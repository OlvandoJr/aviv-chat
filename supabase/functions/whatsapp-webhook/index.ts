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

  // Processar em background
  ;(async () => {
    try {
      const entry   = payload.entry?.[0]
      const change  = entry?.changes?.[0]
      const value   = change?.value
      if (!value) return

      const phoneNumberId = value.metadata?.phone_number_id
      if (!phoneNumberId) return

      // Buscar inbox
      const { data: inbox } = await supabase
        .from('chat_inboxes')
        .select('id')
        .eq('phone_number_id', phoneNumberId)
        .single()
      if (!inbox) return

      // Processar status updates (mensagens entregues/lidas/falhas)
      const statuses = value.statuses || []
      for (const status of statuses) {
        await supabase
          .from('chat_messages')
          .update({ wa_status: status.status })
          .eq('wa_message_id', status.id)

        // Detectar janela de 24h fechada (erro 131047 via webhook assíncrono)
        if (status.status === 'failed') {
          const errCode = status.errors?.[0]?.code
          if (errCode === 131047 || errCode === '131047') {
            await handleWindowClosed(status.id)
          }
        }
      }

      // Processar mensagens recebidas
      const messages = value.messages || []
      for (const msg of messages) {
        await processMessage(msg, value, inbox.id)
      }
    } catch (err) {
      console.error('Webhook processing error:', err)
    }
  })()

  return responsePromise
})

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
      content = JSON.stringify(msg[msgType] || {})
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
