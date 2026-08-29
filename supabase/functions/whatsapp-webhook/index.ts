import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { normalizeWaId } from '../_shared/whatsapp.ts'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

Deno.serve(async (req) => {
  // ── Verificação do webhook (GET da Meta) ─────────────────
  if (req.method === 'GET') {
    const url = new URL(req.url)
    const mode      = url.searchParams.get('hub.mode')
    const token     = url.searchParams.get('hub.verify_token')
    const challenge = url.searchParams.get('hub.challenge')

    // Token de verificação NO NÍVEL DO APP (Cadastro Incorporado): o webhook do
    // app novo da Meta é verificado ANTES de existir qualquer caixa — o token por
    // caixa não serve nesse momento. META_WEBHOOK_VERIFY_TOKEN cobre esse caso;
    // os tokens por caixa continuam valendo para as caixas já cadastradas.
    const appToken = Deno.env.get('META_WEBHOOK_VERIFY_TOKEN')
    if (mode === 'subscribe' && appToken && token === appToken) {
      return new Response(challenge, { status: 200 })
    }

    const { data: inbox } = await supabase
      .from('chat_inboxes')
      .select('verify_token')
      .eq('verify_token', token)
      .single()

    if (mode === 'subscribe' && inbox) {
      return new Response(challenge, { status: 200 })
    }
    return new Response('Forbidden', { status: 403 })
  }

  // ── Recebimento de mensagem (POST da Meta) ───────────────
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  // Validar assinatura HMAC (opcional mas recomendado)
  const body = await req.text()
  let payload: any
  try {
    payload = JSON.parse(body)
  } catch {
    return new Response('Bad Request', { status: 400 })
  }

  // Responder IMEDIATAMENTE para a Meta (< 5 segundos)
  const responsePromise = new Response('OK', { status: 200 })

  // Processar em background. Coexistência multiplica os tipos de evento: além de
  // messages/statuses, chegam ecos do app do celular, chunks de histórico,
  // contatos da agenda e saúde da conexão — cada um em um change.field próprio,
  // e um POST pode trazer vários changes. Por isso o loop completo.
  ;(async () => {
    try {
      for (const entry of payload.entry || []) {
        for (const change of entry?.changes || []) {
          const value = change?.value
          if (!value) continue
          try {
            switch (change.field) {
              case 'smb_message_echoes':  await handleEchoes(value); break
              case 'history':             await handleHistory(value); break
              case 'smb_app_state_sync':  await handleStateSync(value); break
              case 'account_update':      await handleAccountUpdate(value, entry.id); break
              default:                    await handleMessagesChange(value)
            }
          } catch (err) {
            console.error(`Webhook handler error (${change.field}):`, err)
          }
        }
      }
    } catch (err) {
      console.error('Webhook processing error:', err)
    }
  })()

  return responsePromise
})

// ── Fluxo clássico: messages + statuses ──────────────────────────────────────
// deno-lint-ignore no-explicit-any
async function handleMessagesChange(value: any) {
  const phoneNumberId = value.metadata?.phone_number_id
  if (!phoneNumberId) return

  const { data: inbox } = await supabase
    .from('chat_inboxes')
    .select('id')
    .eq('phone_number_id', phoneNumberId)
    .single()
  if (!inbox) return

  const statuses = value.statuses || []
  for (const status of statuses) {
    await supabase
      .from('chat_messages')
      .update({ wa_status: status.status })
      .eq('wa_message_id', status.id)

    await propagateCampaignStatus(status.id, status.status, status.errors?.[0])

    if (status.status === 'failed') {
      const errCode = status.errors?.[0]?.code
      if (errCode === 131047 || errCode === '131047') {
        await handleWindowClosed(status.id)
      }
    }
  }

  const messages = value.messages || []
  for (const msg of messages) {
    await processMessage(msg, value, inbox.id)
  }
}

async function processMessage(msg: any, value: any, inboxId: string) {
  // Normaliza o número recebido (a Meta pode mandar BR sem o "9") para casar com o
  // mesmo contato/conversa dos envios — senão template e resposta caem em threads diferentes.
  const waId      = normalizeWaId(msg.from) || msg.from
  const msgType   = msg.type
  const msgId     = msg.id
  const timestamp = new Date(parseInt(msg.timestamp) * 1000).toISOString()

  // ── Deduplicação: ignorar se a mensagem já foi processada ─────────────
  // WhatsApp reenvia o webhook diversas vezes — a checagem por wa_message_id
  // impede criação de conversas/mensagens duplicadas e múltiplas respostas do bot.
  const { data: existingMsg } = await supabase
    .from('chat_messages')
    .select('id')
    .eq('wa_message_id', msgId)
    .maybeSingle()

  if (existingMsg) {
    console.log(`[dedup] mensagem ${msgId} já processada, ignorando webhook duplicado`)
    return
  }

  // Upsert contato
  const contactName = value.contacts?.[0]?.profile?.name || waId
  const { data: contact, error: contactErr } = await supabase
    .from('chat_contacts')
    .upsert({ wa_id: waId, name: contactName }, { onConflict: 'wa_id' })
    .select('id')
    .single()
  if (contactErr || !contact) {
    console.error('Contact upsert error:', contactErr)
    return
  }

  // Buscar ou criar conversa aberta
  let { data: conversation } = await supabase
    .from('chat_conversations')
    .select('id')
    .eq('contact_id', contact.id)
    .eq('inbox_id', inboxId)
    .not('status', 'eq', 'archived')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!conversation) {
    const { data: newConv } = await supabase
      .from('chat_conversations')
      .insert({
        inbox_id:   inboxId,
        contact_id: contact.id,
        status:     'open',
      })
      .select('id')
      .single()
    conversation = newConv
  }
  if (!conversation) return

  // ── Reações: atualizar metadados da mensagem original, sem criar nova mensagem ─
  if (msgType === 'reaction') {
    await handleReaction(msg)
    return
  }

  // Extrair conteúdo da mensagem
  let content: string | null = null
  let mediaId: string | null = null
  let mimeType: string | null = null
  let filename: string | null = null

  switch (msgType) {
    case 'text':
      content = msg.text?.body || null
      break
    case 'image':
      mediaId  = msg.image?.id || null
      mimeType = msg.image?.mime_type || null
      content  = msg.image?.caption || null
      break
    case 'audio':
      mediaId  = msg.audio?.id || null
      mimeType = msg.audio?.mime_type || null
      break
    case 'voice':
      mediaId  = msg.voice?.id || null
      mimeType = msg.voice?.mime_type || null
      break
    case 'sticker':
      mediaId  = msg.sticker?.id || null
      mimeType = msg.sticker?.mime_type || 'image/webp'
      break
    case 'video':
      mediaId  = msg.video?.id || null
      mimeType = msg.video?.mime_type || null
      content  = msg.video?.caption || null
      break
    case 'document':
      mediaId   = msg.document?.id || null
      mimeType  = msg.document?.mime_type || null
      filename  = msg.document?.filename || null
      content   = msg.document?.caption || null
      break
    case 'button':
      content = msg.button?.text || null
      break
    case 'location': {
      const lat     = msg.location?.latitude
      const lng     = msg.location?.longitude
      const locAddr = msg.location?.address || ''
      const locName = msg.location?.name   || ''
      content = [
        locName  ? `📍 ${locName}` : '📍 Localização',
        locAddr  || null,
        `https://maps.google.com/?q=${lat},${lng}`,
      ].filter(Boolean).join('\n')
      break
    }
    case 'contacts': {
      const names = (msg.contacts || [])
        .map((c: any) => c.name?.formatted_name || '')
        .filter(Boolean)
      content = names.length ? `Contato: ${names.join(', ')}` : 'Contato'
      break
    }
    default:
      // Coexistência: 'unsupported' com erro 131060 é NORMAL em dois cenários —
      // primeira mensagem de um usuário (resolve em segundos) e mensagem enviada
      // por companion não suportado (WhatsApp Windows/WearOS, que não espelha).
      // Não é falha de sistema; o operador confere no app do celular.
      if (String(msg.errors?.[0]?.code) === '131060') {
        console.log(`[coex] mensagem 131060 (não espelhável) de ${msg.from}`)
        content = '⚠️ Mensagem não disponível pela API — verifique o app WhatsApp Business do celular.'
      } else {
        content = JSON.stringify(msg[msgType] || {})
      }
  }

  const preview = content || `[${msgType}]`

  // Inserir mensagem
  const { data: message } = await supabase
    .from('chat_messages')
    .insert({
      conversation_id: conversation.id,
      wa_message_id:   msgId,
      direction:       'in',
      type:            msgType,
      content,
      media_mime_type: mimeType,
      media_filename:  filename,
      metadata:        mediaId ? { wa_media_id: mediaId } : null,
      created_at:      timestamp,
    })
    .select('id')
    .single()

  // Resposta via botão de template de campanha → marca replied_at no destinatário.
  if (msgType === 'button' && message) {
    await markCampaignReply(msg)
  }

  // Atualizar conversa
  await supabase
    .from('chat_conversations')
    .update({
      last_message_at:      timestamp,
      last_message_preview: preview,
      unread_count:         supabase.rpc('increment_unread', { conv_id: conversation.id }) as any,
      status:               'open',
    })
    .eq('id', conversation.id)

  // Atualizar unread_count direto
  await supabase.rpc('chat_increment_unread', { conv_id: conversation.id })

  // Disparar processamento de mídia em background
  if (mediaId && message) {
    await supabase.functions.invoke('process-media', {
      body: {
        messageId:   message.id,
        waMediaId:   mediaId,
        mimeType,
        msgType,
        convId:      conversation.id,
        contactWaId: waId,
        inboxId:     inboxId,
      },
    })
    // O ai-responder será invocado pelo process-media após análise concluída
  } else if (message && (msgType === 'text' || msgType === 'button' || msgType === 'location' || msgType === 'contacts')) {
    // Para mensagens de texto/localização/contatos, invocar o bot diretamente
    await supabase.functions.invoke('ai-responder', {
      body: {
        conversationId: conversation.id,
        messageId:      message.id,
      },
    })
  }
}

// ═══════════════════════════ COEXISTÊNCIA (CoEx) ═══════════════════════════
// Número que continua no app WhatsApp Business do celular, espelhado na Cloud
// API. Payloads conforme o brief de 29/08/2026 (doc oficial da Meta).

// deno-lint-ignore no-explicit-any
async function inboxPorPhoneNumberId(value: any): Promise<{ id: string } | null> {
  const pnid = value?.metadata?.phone_number_id
  if (!pnid) return null
  const { data } = await supabase.from('chat_inboxes').select('id').eq('phone_number_id', pnid).maybeSingle()
  return data || null
}

// Conteúdo de eco/histórico (shape dos payloads de ENVIO da Meta).
// deno-lint-ignore no-explicit-any
function extrairConteudo(m: any): { content: string | null; mime: string | null; mediaId: string | null; filename: string | null } {
  const t = m.type
  const bloco = m[t] || {}
  switch (t) {
    case 'text':     return { content: bloco.body ?? null, mime: null, mediaId: null, filename: null }
    case 'image':
    case 'video':
    case 'audio':
    case 'voice':
    case 'sticker':  return { content: bloco.caption ?? null, mime: bloco.mime_type ?? null, mediaId: bloco.id ?? null, filename: null }
    case 'document': return { content: bloco.caption ?? null, mime: bloco.mime_type ?? null, mediaId: bloco.id ?? null, filename: bloco.filename ?? null }
    case 'media_placeholder':
      // Histórico: mídia com mais de 14 dias fica como placeholder para sempre;
      // a recente chega depois num webhook próprio que atualiza esta linha.
      return { content: '[Mídia do histórico não disponível]', mime: null, mediaId: null, filename: null }
    default:         return { content: bloco.body ?? bloco.text ?? null, mime: null, mediaId: null, filename: null }
  }
}

// Garante contato + conversa para um número de usuário. `statusNova` controla o
// estado da conversa CRIADA aqui (histórico antigo nasce 'resolved' para não
// inundar a fila de Abertas; eco nasce 'open' — a empresa está falando agora).
async function garantirConversa(inboxId: string, userWaId: string, statusNova: 'open' | 'resolved') {
  const waId = normalizeWaId(userWaId) || userWaId
  const { data: contact } = await supabase
    .from('chat_contacts')
    .upsert({ wa_id: waId }, { onConflict: 'wa_id' })
    .select('id')
    .single()
  if (!contact) return null

  const { data: existente } = await supabase
    .from('chat_conversations')
    .select('id, last_message_at')
    .eq('contact_id', contact.id).eq('inbox_id', inboxId)
    .not('status', 'eq', 'archived')
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (existente) return { ...existente, contactId: contact.id, created: false }

  const { data: nova } = await supabase
    .from('chat_conversations')
    .insert({ inbox_id: inboxId, contact_id: contact.id, status: statusNova, handled_by: 'human' })
    .select('id, last_message_at')
    .single()
  return nova ? { ...nova, contactId: contact.id, created: true } : null
}

// ── smb_message_echoes: mensagem enviada pelo APP DO CELULAR ─────────────────
// O coração da coexistência: espelha na thread o que o negócio digitou no
// aparelho. NUNCA dispara bot/automação — é a própria empresa falando.
// deno-lint-ignore no-explicit-any
async function handleEchoes(value: any) {
  const inbox = await inboxPorPhoneNumberId(value)
  if (!inbox) return

  for (const eco of value.message_echoes || []) {
    if (!eco?.id) continue
    const { data: jaExiste } = await supabase
      .from('chat_messages').select('id').eq('wa_message_id', eco.id).maybeSingle()
    if (jaExiste) continue                      // Meta reenvia webhooks — dedup por wamid

    const conv = await garantirConversa(inbox.id, eco.to, 'open')
    if (!conv) continue

    const { content, mime, mediaId, filename } = extrairConteudo(eco)
    const ts = new Date(parseInt(eco.timestamp) * 1000).toISOString()
    await supabase.from('chat_messages').insert({
      conversation_id: conv.id,
      wa_message_id:   eco.id,
      direction:       'out',
      type:            eco.type,
      content,
      media_mime_type: mime,
      media_filename:  filename,
      origin:          'app_echo',
      wa_status:       'sent',
      metadata:        { origin: 'app_echo', ...(mediaId ? { wa_media_id: mediaId } : {}) },
      created_at:      ts,
    })
    await supabase.from('chat_conversations').update({
      last_message_at: ts,
      last_message_preview: `📱 ${content || `[${eco.type}]`}`.slice(0, 120),
      status: 'open',
    }).eq('id', conv.id)
  }
}

// ── history: importação do histórico (até 180 dias, em fases/chunks) ─────────
// deno-lint-ignore no-explicit-any
async function handleHistory(value: any) {
  const inbox = await inboxPorPhoneNumberId(value)
  if (!inbox) return
  const bizDigits = String(value.metadata?.display_phone_number || '').replace(/\D/g, '')

  // Webhook complementar de mídia recente (≤14 dias): array `messages` com o
  // asset — ATUALIZA o placeholder já importado, casando por wamid.
  for (const m of value.messages || []) {
    if (!m?.id || !m?.type) continue
    const bloco = m[m.type] || {}
    const { data: row } = await supabase.from('chat_messages')
      .select('id, metadata').eq('wa_message_id', m.id).maybeSingle()
    if (!row) continue
    await supabase.from('chat_messages').update({
      type: m.type,
      media_mime_type: bloco.mime_type ?? null,
      content: bloco.caption ?? null,
      metadata: { ...(row.metadata || {}), wa_media_id: bloco.id ?? null },
    }).eq('id', row.id)
  }

  for (const h of value.history || []) {
    // Recusa de compartilhamento: conclusão legítima, não erro de sistema.
    const recusa = (h.errors || []).some((e: { code?: number | string }) => String(e?.code) === '2593109')
    if (recusa) {
      await supabase.from('chat_inboxes')
        .update({ history_share: 'declined', sync_progress: 100 }).eq('id', inbox.id)
      continue
    }

    const progress = Number(h.metadata?.progress)
    if (!isNaN(progress)) {
      await supabase.from('chat_inboxes').update({
        sync_progress: progress,
        ...(progress >= 100 ? { history_share: 'shared' } : {}),
      }).eq('id', inbox.id).neq('history_share', 'declined')
    }

    for (const thread of h.threads || []) {
      const conv = await garantirConversa(inbox.id, thread.id, 'resolved')
      if (!conv) continue

      const msgs = (thread.messages || []).filter((m: { id?: string }) => m?.id)
      if (!msgs.length) continue

      // Dedup em lote por wamid (um chunk pode ter milhares de mensagens).
      const wamids = msgs.map((m: { id: string }) => m.id)
      const existentes = new Set<string>()
      for (let i = 0; i < wamids.length; i += 200) {
        const { data } = await supabase.from('chat_messages')
          .select('wa_message_id').in('wa_message_id', wamids.slice(i, i + 200))
        for (const r of data || []) existentes.add(r.wa_message_id)
      }

      let maxTs = ''
      // deno-lint-ignore no-explicit-any
      const linhas = msgs.filter((m: any) => !existentes.has(m.id)).map((m: any) => {
        const fromDigits = String(m.from || '').replace(/\D/g, '')
        const out = bizDigits && fromDigits.slice(-8) === bizDigits.slice(-8)
        const ts = new Date(parseInt(m.timestamp) * 1000).toISOString()
        if (ts > maxTs) maxTs = ts
        const { content, mime, mediaId, filename } = extrairConteudo(m)
        return {
          conversation_id: conv.id,
          wa_message_id:   m.id,
          direction:       out ? 'out' : 'in',
          type:            m.type,
          content,
          media_mime_type: mime,
          media_filename:  filename,
          origin:          'history',
          wa_status:       String(m.history_context?.status || '').toLowerCase() || null,
          metadata:        { origin: 'history', ...(mediaId ? { wa_media_id: mediaId } : {}) },
          created_at:      ts,
        }
      })
      for (let i = 0; i < linhas.length; i += 500) {
        await supabase.from('chat_messages').insert(linhas.slice(i, i + 500))
      }

      // Não reordena a lista de conversas com papo antigo: só preenche quando a
      // conversa ainda não tem last_message_at (recém-criada pelo histórico).
      if (linhas.length && !conv.last_message_at) {
        await supabase.from('chat_conversations')
          .update({ last_message_at: maxTs, last_message_preview: '[Histórico importado]' })
          .eq('id', conv.id).is('last_message_at', null)
      }
    }
  }
}

// ── smb_app_state_sync: agenda de contatos do celular ────────────────────────
// deno-lint-ignore no-explicit-any
async function handleStateSync(value: any) {
  const inbox = await inboxPorPhoneNumberId(value)
  if (!inbox) return
  for (const item of value.state_sync || []) {
    if (item?.type !== 'contact' || !item.contact?.phone_number) continue
    const phone = normalizeWaId(item.contact.phone_number) || String(item.contact.phone_number).replace(/\D/g, '')
    if (item.action === 'remove') {
      await supabase.from('chat_inbox_synced_contacts')
        .update({ removed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('inbox_id', inbox.id).eq('phone_number', phone)
    } else {
      // 'add' cobre também edição de contato existente
      await supabase.from('chat_inbox_synced_contacts').upsert({
        inbox_id: inbox.id,
        phone_number: phone,
        full_name: item.contact.full_name ?? null,
        first_name: item.contact.first_name ?? null,
        removed_at: null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'inbox_id,phone_number' })
    }
  }
}

// ── account_update: saúde da conexão de coexistência ─────────────────────────
// Desconectada, a caixa PARA de espelhar até o cliente reconectar no celular
// (Configurações → Conta → Plataforma de negócios). A razão mais comum é
// PRIMARY_INACTIVITY: celular fechado ~14 dias.
// deno-lint-ignore no-explicit-any
async function handleAccountUpdate(value: any, wabaId: string | undefined) {
  const evento = value?.event
  if (!evento || !wabaId) return
  const patch =
    evento === 'ACCOUNT_RECONNECTED'
      ? { connection_status: 'connected', disconnect_reason: null }
      : (evento === 'PARTNER_REMOVED' || evento === 'ACCOUNT_OFFBOARDED')
      ? { connection_status: 'disconnected',
          disconnect_reason: value?.disconnection_info?.reason || evento }
      : null                                     // demais eventos de account_update: fora do escopo
  if (!patch) return
  await supabase.from('chat_inboxes').update(patch).eq('waba_id', String(wabaId))
  console.log(`[coex] account_update ${evento} → WABA ${wabaId}`, value?.disconnection_info || '')
}

// ── Indicadores de campanha (delivered/read/replied) ─────────────────────────
// Propaga o status da Meta para o destinatário de campanha, casando por wa_message_id.
// Idempotente (timestamp só se null) e monotônico (nunca rebaixa o status).
// deno-lint-ignore no-explicit-any
async function propagateCampaignStatus(waMessageId: string, waStatus: string, erro?: any) {
  if (!waMessageId) return
  const now = new Date().toISOString()
  const T = () => supabase.from('chat_campaign_recipients')

  if (waStatus === 'delivered') {
    await T().update({ delivered_at: now }).eq('wa_message_id', waMessageId).is('delivered_at', null)
    await T().update({ status: 'delivered' }).eq('wa_message_id', waMessageId).eq('status', 'sent')
  } else if (waStatus === 'read') {
    await T().update({ read_at: now }).eq('wa_message_id', waMessageId).is('read_at', null)
    await T().update({ delivered_at: now }).eq('wa_message_id', waMessageId).is('delivered_at', null)
    await T().update({ status: 'read' }).eq('wa_message_id', waMessageId).in('status', ['sent', 'delivered'])
  } else if (waStatus === 'failed') {
    // Formato lido por lib/whatsapp/erros.ts: "[código] Título — detalhe".
    const motivo = erro
      ? `[${erro.code ?? '?'}] ${erro.title || erro.message || 'Falha na entrega'}`
        + (erro.error_data?.details ? ` — ${erro.error_data.details}` : '')
      : 'Falha na entrega (a Meta não informou o motivo)'
    const { data: afetados } = await T()
      .update({ status: 'failed', error: motivo.slice(0, 500) })
      .eq('wa_message_id', waMessageId).eq('status', 'sent')
      .select('campaign_id')
    // Falha ASSÍNCRONA muda o placar depois da recontagem do dispatch — sem isto
    // o topo da tela dizia "4 falhas" com 5 na lista (caso de 27/08).
    for (const a of afetados || []) await recontarCampanha(a.campaign_id)
  }

  // Disparos adicionais: mesma propagação para chat_campaign_envios.
  const E = () => supabase.from('chat_campaign_envios')
  if (waStatus === 'delivered') {
    await E().update({ delivered_at: now }).eq('wa_message_id', waMessageId).is('delivered_at', null)
    await E().update({ status: 'delivered' }).eq('wa_message_id', waMessageId).eq('status', 'sent')
  } else if (waStatus === 'read') {
    await E().update({ read_at: now }).eq('wa_message_id', waMessageId).is('read_at', null)
    await E().update({ delivered_at: now }).eq('wa_message_id', waMessageId).is('delivered_at', null)
    await E().update({ status: 'read' }).eq('wa_message_id', waMessageId).in('status', ['sent', 'delivered'])
  } else if (waStatus === 'failed') {
    const motivoE = erro
      ? `[${erro.code ?? '?'}] ${erro.title || erro.message || 'Falha na entrega'}`
        + (erro.error_data?.details ? ` — ${erro.error_data.details}` : '')
      : 'Falha na entrega (a Meta não informou o motivo)'
    const { data: envAfetados } = await E()
      .update({ status: 'failed', error: motivoE.slice(0, 500) })
      .eq('wa_message_id', waMessageId).eq('status', 'sent')
      .select('disparo_id')
    for (const a of envAfetados || []) await recontarDisparo(a.disparo_id)
  }
}

// Placar da campanha a partir dos destinatários (fonte da verdade).
async function recontarCampanha(campaignId: string) {
  if (!campaignId) return
  const conta = async (filtro: string[]) => (await supabase.from('chat_campaign_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId).in('status', filtro)).count || 0
  const [ok, falhas] = await Promise.all([conta(['sent', 'delivered', 'read']), conta(['failed'])])
  await supabase.from('chat_campaigns')
    .update({ sent: ok, failed: falhas, updated_at: new Date().toISOString() })
    .eq('id', campaignId)
}

async function recontarDisparo(disparoId: string) {
  if (!disparoId) return
  const conta = async (filtro: string[]) => (await supabase.from('chat_campaign_envios')
    .select('id', { count: 'exact', head: true })
    .eq('disparo_id', disparoId).in('status', filtro)).count || 0
  const [ok, falhas] = await Promise.all([conta(['sent', 'delivered', 'read']), conta(['failed'])])
  await supabase.from('chat_campaign_disparos')
    .update({ sent: ok, failed: falhas, updated_at: new Date().toISOString() })
    .eq('id', disparoId)
}

// Marca replied_at quando o cliente clica no botão DO template da campanha.
// A resposta de botão traz context.id = id da mensagem que está respondendo (o
// template enviado). O destinatário guarda esse mesmo id em wa_message_id — casa
// exatamente e ignora cliques em botões de cobrança (context.id de outra mensagem).
async function markCampaignReply(msg: any) {
  const ctxId = msg?.context?.id
  if (!ctxId) return
  await supabase.from('chat_campaign_recipients')
    .update({ replied_at: new Date().toISOString() })
    .eq('wa_message_id', ctxId)
    .is('replied_at', null)
  await supabase.from('chat_campaign_envios')
    .update({ replied_at: new Date().toISOString() })
    .eq('wa_message_id', ctxId)
    .is('replied_at', null)
}

// ── Tratamento de reações ────────────────────────────────────────────────────
async function handleReaction(msg: any) {
  const waMessageId = msg.reaction?.message_id
  const emoji       = msg.reaction?.emoji   // vazio = reação removida
  const fromWaId    = normalizeWaId(msg.from) || msg.from
  if (!waMessageId) return

  const { data: targetMsg } = await supabase
    .from('chat_messages')
    .select('id, metadata')
    .eq('wa_message_id', waMessageId)
    .maybeSingle()

  if (!targetMsg) return

  // Remove reação anterior deste remetente; adiciona a nova (se houver emoji)
  const existing: { wa_id: string; emoji: string }[] = (targetMsg.metadata?.reactions as any[]) || []
  const filtered = existing.filter((r) => r.wa_id !== fromWaId)
  if (emoji) filtered.push({ wa_id: fromWaId, emoji })

  await supabase
    .from('chat_messages')
    .update({ metadata: { ...(targetMsg.metadata || {}), reactions: filtered } })
    .eq('id', targetMsg.id)
}

// ── Janela de 24h fechada ─────────────────────────────────────────────────────
// Chamada quando o webhook de status retorna failed + código 131047.
// Insere uma mensagem de sistema na conversa para alertar o atendente.
async function handleWindowClosed(waMessageId: string) {
  // Buscar a mensagem que falhou para obter a conversa
  const { data: failedMsg } = await supabase
    .from('chat_messages')
    .select('id, conversation_id, attendant_id')
    .eq('wa_message_id', waMessageId)
    .maybeSingle()

  if (!failedMsg?.conversation_id) return

  // Deduplicação: só inserir se não houver outro card de janela fechada
  // criado nos últimos 10 minutos para esta conversa
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  const { data: recent } = await supabase
    .from('chat_messages')
    .select('id')
    .eq('conversation_id', failedMsg.conversation_id)
    .eq('content', 'WINDOW_CLOSED')
    .gte('created_at', tenMinAgo)
    .maybeSingle()

  if (recent) return   // já existe card recente — não duplicar

  await supabase.from('chat_messages').insert({
    conversation_id: failedMsg.conversation_id,
    direction:       'out',
    type:            'unknown',
    content:         'WINDOW_CLOSED',
    wa_status:       'failed',
    attendant_id:    failedMsg.attendant_id,
    metadata:        { system_type: 'window_closed' },
  })

  await supabase.from('chat_conversations').update({
    last_message_at:      new Date().toISOString(),
    last_message_preview: '⚠️ Janela de conversa fechada',
  }).eq('id', failedMsg.conversation_id)
}
