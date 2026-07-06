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
  type TemplateRow,
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

    const CAMP_COLS = 'id, inbox_id, template_id, status, owner_id, header_media_path, header_media_filename'
    let q = admin.from('chat_campaigns')
      .select(CAMP_COLS)
      .eq('status', 'running')
      .is('deleted_at', null)
    if (onlyId) q = admin.from('chat_campaigns')
      .select(CAMP_COLS + ', deleted_at')
      .eq('id', onlyId)

    const { data: campaigns } = await q
    const results: any[] = []

    for (const camp of campaigns || []) {
      if (camp.deleted_at) continue
      if (onlyId && camp.status !== 'running' && camp.status !== 'scheduled') continue
      results.push(await processCampaign(camp))
    }

    // Auto-reinvocação: campanhas que ainda têm pendentes continuam em background
    for (const r of results) {
      if (r?.status === 'running' && r?.pending > 0) reinvoke(r.campaign)
    }

    return json({ ok: true, processed: results })
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

  // Lote de pendentes
  const { data: recipients } = await admin
    .from('chat_campaign_recipients')
    .select('id, wa_id, name, variables, boleto_pdf_path')
    .eq('campaign_id', camp.id)
    .eq('status', 'pending')
    .limit(BATCH)

  let sent = 0, failed = 0
  for (const r of recipients || []) {
    // Conversa nasce com o PROPRIETÁRIO da campanha (assignee) — só ele + admin/gerente a veem.
    const conv = await ensureConversation(admin, camp.inbox_id, r.wa_id, r.name || undefined, COBRANCA_AGENT_ID, camp.owner_id || null)
    if (!conv) {
      await markRecipient(r.id, 'failed', null, 'falha ao criar conversa')
      failed++
      continue
    }

    // Modo 'boleto': anexa o PDF do próprio destinatário (signed URL por envio).
    let sendMedia = headerMedia
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
    }

    const res = await sendTemplateMessage({
      admin,
      inbox: { phone_number_id: inbox.phone_number_id, access_token: inbox.access_token },
      toWaId: r.wa_id,
      tpl: tpl as TemplateRow,
      variables: Array.isArray(r.variables) ? r.variables : [],
      conversationId: conv.conversationId,
      headerMedia: sendMedia,
      metaExtra: { campaign_id: camp.id },
    })
    if (res.ok) {
      await markRecipient(r.id, 'sent', res.waMessageId, null)
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
