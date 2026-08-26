/**
 * dispatch-campaign — Edge Function
 *
 * Processa campanhas de template WhatsApp. Pode ser chamada:
 *  - na hora, pelo /api/campaigns/[id]/start  → body { campaignId }
 *  - por cron (a cada 1 min, sem body)         → varre campanhas devidas
 *
 * Idempotente: só processa recipients 'pending'. Throttle para respeitar o
 * rate-limit da Meta. Reentrante: processa um lote por invocação; o cron
 * (ou auto-reinvocação) continua de onde parou.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  ensureConversation,
  cleanupEmptyConversation,
  sendTemplateMessage,
  COBRANCA_AGENT_ID,
  SLEEP,
  resolveVariables,
  type TemplateRow,
  type VariableMapping,
} from '../_shared/whatsapp.ts'

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

const BATCH = 100          // máx. de envios por invocação
const DELAY_MS = 120       // ~8 msg/s, abaixo do limite da Meta

Deno.serve(async (req) => {
  try {
    const body = await req.json().catch(() => ({}))
    const onlyId: string | undefined = body?.campaignId

    // ── Selecionar campanhas a processar ──────────────────────────────────────
    // scheduled vencidas → running (ignora excluídas)
    await admin
      .from('chat_campaigns')
      .update({ status: 'running', updated_at: new Date().toISOString() })
      .eq('status', 'scheduled')
      .is('deleted_at', null)
      .lte('scheduled_at', new Date().toISOString())

    const CAMP_COLS = 'id, inbox_id, template_id, status, owner_id, header_media_mode, header_media_path, header_media_filename, agent_id, bot_ativo'
    let q = admin.from('chat_campaigns')
      .select(CAMP_COLS)
      .eq('status', 'running')
      .is('deleted_at', null)
    if (onlyId) q = admin.from('chat_campaigns')
      .select(CAMP_COLS + ', deleted_at')
      .eq('id', onlyId)

    const { data: campaigns } = await q
    const results: any[] = []

    // Disparos ADICIONAIS vencidos (modelo da régua: cada disparo tem template e
    // mapeamento próprios). Rodam independentes do envio principal.
    const disparos = await processarDisparosDevidos(onlyId)

    for (const camp of campaigns || []) {
      if (camp.deleted_at) continue
      if (onlyId && camp.status !== 'running' && camp.status !== 'scheduled') continue
      results.push(await processCampaign(camp))
    }

    // Auto-reinvocação: campanhas que ainda têm pendentes continuam em background
    for (const r of results) {
      if (r?.status === 'running' && r?.pending > 0) reinvoke(r.campaign)
    }

    return json({ ok: true, processed: results, disparos })
  } catch (err) {
    console.error('dispatch-campaign error:', err)
    return json({ error: String(err) }, 500)
  }
})

// deno-lint-ignore no-explicit-any
async function processCampaign(camp: any) {
  // Credenciais do inbox + template
  const { data: inbox } = await admin
    .from('chat_inboxes')
    .select('phone_number_id, access_token')
    .eq('id', camp.inbox_id)
    .single()

  const { data: tpl } = await admin
    .from('chat_wa_templates')
    .select('id, name, language, header_text, header_var_count, body_var_count, body_text, header_type')
    .eq('id', camp.template_id)
    .single()

  if (!inbox?.phone_number_id || !inbox?.access_token || !tpl) {
    await admin.from('chat_campaigns')
      .update({ status: 'failed', updated_at: new Date().toISOString() })
      .eq('id', camp.id)
    return { campaign: camp.id, error: 'inbox ou template inválido' }
  }

  // Template com header de mídia: 'upload' = mesmo arquivo p/ todos (signed URL 1x);
  // 'boleto' = PDF de cada destinatário (signed URL por envio). Sem mídia → falha.
  const mediaType = (tpl.header_type || '').toUpperCase()
  const precisaMedia = mediaType === 'DOCUMENT' || mediaType === 'IMAGE' || mediaType === 'VIDEO'
  const mediaMode = camp.header_media_mode === 'boleto' ? 'boleto' : 'upload'
  let headerMedia: { link: string; filename?: string } | null = null
  if (precisaMedia && mediaMode === 'upload') {
    if (!camp.header_media_path) {
      await admin.from('chat_campaigns').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', camp.id)
      return { campaign: camp.id, error: 'template de mídia sem arquivo anexado' }
    }
    const { data: signed } = await admin.storage.from('campaign-media').createSignedUrl(camp.header_media_path, 3600)
    if (!signed?.signedUrl) {
      await admin.from('chat_campaigns').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', camp.id)
      return { campaign: camp.id, error: 'falha ao gerar signed URL da mídia' }
    }
    headerMedia = { link: signed.signedUrl, filename: camp.header_media_filename || undefined }
  }

  // Reservas travadas há >10min (execução que morreu no meio) voltam a ficar
  // reclamáveis. Usamos .lt (filtro simples) porque .or() NÃO funciona em UPDATE
  // no PostgREST — casa 0 linhas — só em SELECT.
  const staleISO = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  await admin.from('chat_campaign_recipients')
    .update({ claimed_at: null })
    .eq('campaign_id', camp.id).eq('status', 'pending')
    .lt('claimed_at', staleISO)

  // Lote de pendentes ainda não reservados.
  const { data: recipients } = await admin
    .from('chat_campaign_recipients')
    .select('id, wa_id, name, variables, boleto_pdf_path')
    .eq('campaign_id', camp.id)
    .eq('status', 'pending')
    .is('claimed_at', null)
    .limit(BATCH)

  let sent = 0, failed = 0
  for (const r of recipients || []) {
    // TRAVA ATÔMICA: reserva o destinatário antes de enviar. Se outra execução
    // concorrente já reservou (claimed_at recente), o UPDATE não casa → pula.
    // Impede o duplo envio (caso Indique e Ganhe — Tapejara).
    const { data: claim } = await admin
      .from('chat_campaign_recipients')
      .update({ claimed_at: new Date().toISOString() })
      .eq('id', r.id).eq('status', 'pending')
      .is('claimed_at', null)
      .select('id').maybeSingle()
    if (!claim) continue   // já reservado por outra execução — não reenvia

    // Conversa nasce com o PROPRIETÁRIO da campanha (assignee) — só ele + admin/gerente a veem.
    // Agente: o especialista da campanha, se houver; senão o de cobrança (default histórico).
    const conv = await ensureConversation(admin, camp.inbox_id, r.wa_id, r.name || undefined, camp.agent_id || COBRANCA_AGENT_ID, camp.owner_id || null)
    if (!conv) {
      await markRecipient(r.id, 'failed', null, 'falha ao criar conversa')
      failed++
      continue
    }

    // Modo 'boleto': anexa o PDF do próprio destinatário (signed URL por envio).
    let sendMedia = headerMedia
    let mediaRef: { bucket: string; path: string; filename?: string; kind: 'image' | 'video' | 'document' } | null =
      precisaMedia && mediaMode === 'upload' && camp.header_media_path
        ? { bucket: 'campaign-media', path: camp.header_media_path,
            filename: camp.header_media_filename || undefined,
            kind: mediaType === 'IMAGE' ? 'image' : mediaType === 'VIDEO' ? 'video' : 'document' }
        : null
    if (precisaMedia && mediaMode === 'boleto') {
      if (!r.boleto_pdf_path) {
        await markRecipient(r.id, 'failed', null, 'sem boleto com PDF para anexar')
        await cleanupEmptyConversation(admin, conv)
        failed++; continue
      }
      const { data: signed } = await admin.storage.from('boletos').createSignedUrl(r.boleto_pdf_path, 3600)
      if (!signed?.signedUrl) {
        await markRecipient(r.id, 'failed', null, 'falha ao gerar signed URL do boleto')
        await cleanupEmptyConversation(admin, conv)
        failed++; continue
      }
      sendMedia = { link: signed.signedUrl, filename: 'Boleto.pdf' }
      mediaRef = { bucket: 'boletos', path: r.boleto_pdf_path, filename: 'Boleto.pdf', kind: 'document' }
    }

    const res = await sendTemplateMessage({
      admin,
      inbox: { phone_number_id: inbox.phone_number_id, access_token: inbox.access_token },
      toWaId: r.wa_id,
      tpl: tpl as TemplateRow,
      variables: Array.isArray(r.variables) ? r.variables : [],
      conversationId: conv.conversationId,
      headerMedia: sendMedia,
      headerMediaRef: mediaRef,
      metaExtra: { campaign_id: camp.id },
    })
    if (res.ok) {
      await markRecipient(r.id, 'sent', res.waMessageId, null)
      // Com a IA ligada, a conversa volta para o bot — assim ele trata as respostas
      // (ex.: fluxo Indique e Ganhe), mesmo que estivesse em atendimento humano.
      // Com bot_ativo=false, não mexe: quem responde é humano (o ai-responder marca
      // handled_by='human' na 1ª resposta do lead e sai calado).
      if (camp.bot_ativo !== false) {
        await admin.from('chat_conversations')
          .update({ handled_by: 'bot', ...(camp.agent_id ? { agent_id: camp.agent_id } : {}) })
          .eq('id', conv.conversationId)
      }
      sent++
    } else {
      await markRecipient(r.id, 'failed', null, JSON.stringify(res.error).slice(0, 500))
      await cleanupEmptyConversation(admin, conv)
      failed++
    }
    await SLEEP(DELAY_MS)
  }

  // Recontar e atualizar status da campanha
  const counts = await countRecipients(camp.id)
  const status = counts.pending === 0 ? 'done' : 'running'
  await admin.from('chat_campaigns').update({
    total: counts.total,
    sent: counts.sent,
    failed: counts.failed,
    status,
    updated_at: new Date().toISOString(),
  }).eq('id', camp.id)

  return { campaign: camp.id, batchSent: sent, batchFailed: failed, ...counts, status }
}

/**
 * Disparos adicionais da campanha (chat_campaign_disparos).
 *
 * Espelha a régua: um disparo = um template + mapeamento próprios, com data/hora
 * absoluta (a campanha não tem vencimento para ancorar). A audiência é a MESMA da
 * campanha — os destinatários vêm de chat_campaign_recipients, e o log por disparo
 * (chat_campaign_envios, UNIQUE disparo+wa_id) garante que reprocessar não duplica.
 */
// deno-lint-ignore no-explicit-any
async function processarDisparosDevidos(onlyCampaign?: string): Promise<any[]> {
  let q = admin.from('chat_campaign_disparos')
    .select('id, campaign_id, ordem, scheduled_at, template_id, variable_mapping, status')
    .in('status', ['scheduled', 'running'])
    .lte('scheduled_at', new Date().toISOString())
    .order('scheduled_at')
  if (onlyCampaign) q = q.eq('campaign_id', onlyCampaign)

  const { data: devidos } = await q
  const out: any[] = []
  for (const d of devidos || []) out.push(await processarDisparo(d))
  return out
}

// deno-lint-ignore no-explicit-any
async function processarDisparo(d: any) {
  const { data: camp } = await admin.from('chat_campaigns')
    .select('id, inbox_id, status, owner_id, agent_id, bot_ativo, deleted_at')
    .eq('id', d.campaign_id).maybeSingle()
  if (!camp || camp.deleted_at) {
    await admin.from('chat_campaign_disparos').update({ status: 'done' }).eq('id', d.id)
    return { disparo: d.id, skip: 'campanha inexistente' }
  }

  const [{ data: inbox }, { data: tpl }] = await Promise.all([
    admin.from('chat_inboxes').select('phone_number_id, access_token').eq('id', camp.inbox_id).single(),
    admin.from('chat_wa_templates')
      .select('id, name, language, header_text, header_var_count, body_var_count, body_text, header_type')
      .eq('id', d.template_id).single(),
  ])
  if (!inbox?.phone_number_id || !tpl) {
    await admin.from('chat_campaign_disparos').update({ status: 'failed' }).eq('id', d.id)
    return { disparo: d.id, error: 'inbox ou template inválido' }
  }

  await admin.from('chat_campaign_disparos').update({ status: 'running' }).eq('id', d.id)

  // Materializa a fila deste disparo a partir da audiência da campanha (idempotente
  // pelo UNIQUE disparo+wa_id — quem já está não é reinserido nem reenviado).
  const { data: audiencia } = await admin.from('chat_campaign_recipients')
    .select('wa_id, name, dados').eq('campaign_id', camp.id).limit(5000)
  const fila = (audiencia || []).map((r: any) => ({
    disparo_id: d.id, campaign_id: camp.id, wa_id: r.wa_id, name: r.name, status: 'pending',
  }))
  for (let i = 0; i < fila.length; i += 500) {
    await admin.from('chat_campaign_envios')
      .upsert(fila.slice(i, i + 500), { onConflict: 'disparo_id,wa_id', ignoreDuplicates: true })
  }
  const dadosPorWa = new Map<string, Record<string, unknown>>(
    (audiencia || []).map((r: any) => [String(r.wa_id), (r.dados || {}) as Record<string, unknown>]))

  const staleISO = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  await admin.from('chat_campaign_envios').update({ claimed_at: null })
    .eq('disparo_id', d.id).eq('status', 'pending').lt('claimed_at', staleISO)

  const { data: pendentes } = await admin.from('chat_campaign_envios')
    .select('id, wa_id, name').eq('disparo_id', d.id).eq('status', 'pending')
    .is('claimed_at', null).limit(BATCH)

  let sent = 0, failed = 0
  for (const e of pendentes || []) {
    const { data: claim } = await admin.from('chat_campaign_envios')
      .update({ claimed_at: new Date().toISOString() })
      .eq('id', e.id).eq('status', 'pending').is('claimed_at', null)
      .select('id').maybeSingle()
    if (!claim) continue

    const conv = await ensureConversation(
      admin, camp.inbox_id, e.wa_id, e.name || undefined,
      camp.agent_id || COBRANCA_AGENT_ID, camp.owner_id || null)
    if (!conv) {
      await marcarEnvio(e.id, 'failed', null, 'falha ao criar conversa'); failed++; continue
    }

    const res = await sendTemplateMessage({
      admin,
      inbox: { phone_number_id: inbox.phone_number_id, access_token: inbox.access_token },
      toWaId: e.wa_id,
      tpl: tpl as TemplateRow,
      variables: resolveVariables(d.variable_mapping as VariableMapping, dadosPorWa.get(String(e.wa_id)) || {}),
      conversationId: conv.conversationId,
      metaExtra: { campaign_id: camp.id, disparo_id: d.id, disparo_ordem: d.ordem },
    })

    if (res.ok) {
      await marcarEnvio(e.id, 'sent', res.waMessageId, null)
      if (camp.bot_ativo !== false) {
        await admin.from('chat_conversations')
          .update({ handled_by: 'bot', ...(camp.agent_id ? { agent_id: camp.agent_id } : {}) })
          .eq('id', conv.conversationId)
      }
      sent++
    } else {
      await marcarEnvio(e.id, 'failed', null, JSON.stringify(res.error).slice(0, 500))
      await cleanupEmptyConversation(admin, conv)
      failed++
    }
    await SLEEP(DELAY_MS)
  }

  const cont = async (st: string) => (await admin.from('chat_campaign_envios')
    .select('id', { count: 'exact', head: true }).eq('disparo_id', d.id).eq('status', st)).count || 0
  const [pend, okc, failc] = await Promise.all([cont('pending'), cont('sent'), cont('failed')])
  await admin.from('chat_campaign_disparos').update({
    status: pend === 0 ? 'done' : 'running',
    sent: okc, failed: failc, updated_at: new Date().toISOString(),
  }).eq('id', d.id)

  if (pend > 0) reinvoke(camp.id)
  return { disparo: d.id, ordem: d.ordem, batchSent: sent, batchFailed: failed, pendentes: pend }
}

async function marcarEnvio(id: string, status: string, waMessageId: string | null, error: string | null) {
  await admin.from('chat_campaign_envios').update({
    status, wa_message_id: waMessageId, error,
    sent_at: status === 'sent' ? new Date().toISOString() : null,
  }).eq('id', id)
}

async function markRecipient(id: string, status: string, waMessageId: string | null, error: string | null) {
  await admin.from('chat_campaign_recipients').update({
    status,
    wa_message_id: waMessageId,
    error,
    sent_at: status === 'sent' ? new Date().toISOString() : null,
  }).eq('id', id)
}

async function countRecipients(campaignId: string) {
  const sel = (st: string) => admin
    .from('chat_campaign_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .eq('status', st)

  const [{ count: total }, { count: pending }, { count: failed },
         { count: s1 }, { count: s2 }, { count: s3 }] = await Promise.all([
    admin.from('chat_campaign_recipients').select('id', { count: 'exact', head: true }).eq('campaign_id', campaignId),
    sel('pending'), sel('failed'), sel('sent'), sel('delivered'), sel('read'),
  ])
  return {
    total: total || 0,
    pending: pending || 0,
    failed: failed || 0,
    sent: (s1 || 0) + (s2 || 0) + (s3 || 0),
  }
}

function reinvoke(campaignId: string) {
  fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/dispatch-campaign`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ campaignId }),
  }).catch((e) => console.error('reinvoke falhou:', e))
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
