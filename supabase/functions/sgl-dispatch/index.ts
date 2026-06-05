/**
 * sgl-dispatch — Edge Function (poller)
 *
 * Cobrança SGL orientada a evento. O n8n recebe o webhook do SGL, faz o parse e
 * GRAVA em mensagens_cobranca (sem enviar). Esta função reage a cada NOVO registro
 * (app_dispatched_at IS NULL), classifica pelo vencimento, escolhe o template via
 * sgl_regua_map e envia pelo nosso núcleo. Como o SGL só insere para quem está em
 * aberto, herdamos a inteligência de pagamento dele.
 *
 * Invocação: cron (~5 min) sem body. Manual: { dryRun?: boolean, limit?: number }.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  ensureConversation,
  resolveVariables,
  sendTemplateMessage,
  SLEEP,
  type TemplateRow,
  type VariableMapping,
} from '../_shared/whatsapp.ts'

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

const BATCH = 80
const DELAY_MS = 120
const MAX_ATTEMPTS = 5   // após N falhas de envio, desiste (marca tratado) para não loopar

function brtTodayStr(): string {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }))
    .toISOString().slice(0, 10)
}

function classify(dueStr: string | null, todayStr: string): string {
  if (!dueStr) return 'sem_classificacao'
  const iso = String(dueStr).slice(0, 10)
  const d = Date.parse(iso + 'T00:00:00Z')
  if (isNaN(d)) return 'sem_classificacao'
  const t = Date.parse(todayStr + 'T00:00:00Z')
  const dias = Math.floor((t - d) / 86400000)
  if (dias < 0) return 'a_vencer'
  if (dias === 0) return 'vence_hoje'
  if (dias === 3) return 'vencida_3_dias'
  if (dias === 10) return 'vencida_10_dias'
  if (dias === 30) return 'vencida_30_dias'
  return `vencida_${dias}_dias`
}

Deno.serve(async (req) => {
  try {
    const body = await req.json().catch(() => ({}))
    const dryRun = !!body?.dryRun
    const limit = Math.min(Number(body?.limit) || BATCH, 500)
    const todayStr = brtTodayStr()

    // Mapa classificacao → {template, inbox, mapping}
    const { data: maps } = await admin
      .from('sgl_regua_map')
      .select('classificacao, template_id, inbox_id, variable_mapping, active')
      .eq('active', true)
    const mapByClass: Record<string, any> = {}
    for (const m of maps || []) mapByClass[m.classificacao] = m

    // Registros novos
    const { data: rows } = await admin
      .from('mensagens_cobranca')
      .select('id, phone, pessoanomecompleto, unidadeempreendimento, unidadequadraandar, unidadeloteapartamento, contasreceberparcela, contasrecebervencimento, contasrecebervalor, linkboleto, app_dispatch_attempts')
      .is('app_dispatched_at', null)
      .order('created_at', { ascending: true })
      .limit(limit)

    const inboxCache: Record<string, any> = {}
    const tplCache: Record<string, TemplateRow | null> = {}
    const result = { processed: 0, sent: 0, skipped: 0, failed: 0, retry: 0, gaveup: 0, byClass: {} as Record<string, number>, samples: [] as any[] }

    for (const r of rows || []) {
      result.processed++
      const classificacao = classify(r.contasrecebervencimento, todayStr)
      result.byClass[classificacao] = (result.byClass[classificacao] || 0) + 1
      const m = mapByClass[classificacao]
      const waId = String(r.phone || '').replace(/\D/g, '')

      if (dryRun) {
        if (result.samples.length < 25) result.samples.push({ phone: waId, nome: r.pessoanomecompleto, venc: r.contasrecebervencimento, classificacao, template: m ? 'sim' : 'NÃO ENVIA' })
        continue
      }

      // Sem mapa (vence_hoje, vencida_5_dias, etc.) ou telefone inválido → marca e pula
      if (!m || waId.length < 10) {
        await markDispatched(r.id)
        result.skipped++
        continue
      }

      // inbox + template (cache)
      if (!(m.inbox_id in inboxCache)) {
        const { data: ib } = await admin.from('chat_inboxes')
          .select('phone_number_id, access_token').eq('id', m.inbox_id).single()
        inboxCache[m.inbox_id] = ib
      }
      const inbox = inboxCache[m.inbox_id]
      if (!(m.template_id in tplCache)) {
        const { data: tpl } = await admin.from('chat_wa_templates')
          .select('id, name, language, header_text, header_var_count, body_var_count, body_text')
          .eq('id', m.template_id).single()
        tplCache[m.template_id] = (tpl as TemplateRow) || null
      }
      const tpl = tplCache[m.template_id]
      if (!inbox?.phone_number_id || !tpl) {
        bump(result, await giveUpOrRetry(r.id, r.app_dispatch_attempts || 0, 'inbox ou template inválido'))
        continue
      }

      const rowObj = {
        customer_name: r.pessoanomecompleto,
        empreendimento: r.unidadeempreendimento,
        quadra: r.unidadequadraandar,
        lote: r.unidadeloteapartamento,
        parcela: r.contasreceberparcela,
        due_date: r.contasrecebervencimento,   // format 'date' no mapping
        amount: r.contasrecebervalor,            // string BR crua (paridade n8n)
        link_boleto: r.linkboleto,
      }

      const conv = await ensureConversation(admin, m.inbox_id, waId, r.pessoanomecompleto || undefined)
      if (!conv) { bump(result, await giveUpOrRetry(r.id, r.app_dispatch_attempts || 0, 'falha ao criar conversa')); continue }

      const variables = resolveVariables(m.variable_mapping as VariableMapping, rowObj)
      const res = await sendTemplateMessage({
        admin,
        inbox: { phone_number_id: inbox.phone_number_id, access_token: inbox.access_token },
        toWaId: waId,
        tpl,
        variables,
        conversationId: conv.conversationId,
        metaExtra: { sgl_classificacao: classificacao, mensagem_cobranca_id: r.id },
      })

      if (res.ok) {
        await markDispatched(r.id)
        result.sent++
      } else {
        bump(result, await giveUpOrRetry(r.id, r.app_dispatch_attempts || 0, JSON.stringify(res.error).slice(0, 500)))
      }
      await SLEEP(DELAY_MS)
    }

    return json({ ok: true, dryRun, today: todayStr, ...result })
  } catch (err) {
    console.error('sgl-dispatch error:', err)
    return json({ error: String(err) }, 500)
  }
})

async function markDispatched(id: string) {
  await admin.from('mensagens_cobranca')
    .update({ app_dispatched_at: new Date().toISOString(), app_dispatch_error: null })
    .eq('id', id)
}

// Falha de envio: incrementa tentativas. Antes do limite → deixa pendente (retry no
// próximo ciclo). No limite → marca tratado (desiste) para não loopar.
async function giveUpOrRetry(id: string, attemptsNow: number, error: string): Promise<'retry' | 'gaveup'> {
  const attempts = (attemptsNow || 0) + 1
  if (attempts >= MAX_ATTEMPTS) {
    await admin.from('mensagens_cobranca')
      .update({ app_dispatched_at: new Date().toISOString(), app_dispatch_attempts: attempts, app_dispatch_error: error })
      .eq('id', id)
    return 'gaveup'
  }
  await admin.from('mensagens_cobranca')
    .update({ app_dispatch_attempts: attempts, app_dispatch_error: error })
    .eq('id', id)
  return 'retry'
}

function bump(result: { failed: number; retry: number; gaveup: number }, outcome: 'retry' | 'gaveup') {
  result.failed++
  if (outcome === 'gaveup') result.gaveup++; else result.retry++
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
