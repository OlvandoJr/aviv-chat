/**
 * cobranca-regua — Edge Function
 *
 * Régua = fluxo (pai) com vários disparos (passos). Cada passo dispara um
 * template aos boletos cujo vencimento está a `offset_days` de hoje (BRT):
 *   alvo = hoje(BRT) - offset_days   (offset -3 dispara 3 dias antes do vencimento)
 *
 * Passo com `on_load=true` (disparo no dia do carregamento): audiência são os
 * boletos que ENTRARAM hoje no sistema (loaded_date = hoje BRT — ZIP ou
 * sienge-webhook). O horário é "a partir de": como o cron é horário, o passo roda
 * em toda passada com hora >= send_time, e a UNIQUE do log garante 1 envio por
 * boleto (offset_days=999 é sentinela de dedup desses passos).
 *
 * Invocação:
 *  - cron horário (sem body) → roda os passos cujo send_time bate com a hora atual
 *  - manual: { reguaId?, force?, dryRun? }
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

const DELAY_MS = 120

function brtNow(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }))
}
function isoDate(d: Date): string { return d.toISOString().slice(0, 10) }

Deno.serve(async (req) => {
  try {
    const body = await req.json().catch(() => ({}))
    const { reguaId, force = false, dryRun = false } = body || {}

    const now = brtNow()
    const hour = now.getHours()

    const sel = 'id, name, inbox_id, audience_filter, active, steps:cobranca_regua_step(id, offset_days, send_time, template_id, variable_mapping, sort_order, on_load)'
    let q = admin.from('cobranca_regua').select(sel).eq('active', true)
    if (reguaId) q = admin.from('cobranca_regua').select(sel).eq('id', reguaId)

    const { data: reguas } = await q
    const out: unknown[] = []

    for (const regua of reguas || []) {
      const steps = [...(regua.steps || [])].sort((a: any, b: any) =>
        Number(b.on_load || false) - Number(a.on_load || false) || a.offset_days - b.offset_days)
      // inbox uma vez por régua
      const { data: inbox } = await admin.from('chat_inboxes')
        .select('phone_number_id, access_token').eq('id', regua.inbox_id).single()

      for (const step of steps) {
        const ruleHour = parseInt(String(step.send_time).slice(0, 2))
        // on_load roda em toda passada com hora >= send_time (boleto pode entrar a
        // qualquer hora; o log deduplica). Passo de offset roda só na hora exata.
        const foraDoHorario = step.on_load ? hour < ruleHour : ruleHour !== hour
        if (!force && !dryRun && foraDoHorario) {
          out.push({ regua: regua.name, offset: step.on_load ? 'carga' : step.offset_days, skipped: 'fora do horário', ruleHour, hour })
          continue
        }
        out.push(await runStep(regua, step, inbox, now, dryRun))
      }
    }

    return json({ ok: true, dryRun, brtHour: hour, results: out })
  } catch (err) {
    console.error('cobranca-regua error:', err)
    return json({ error: String(err) }, 500)
  }
})

// deno-lint-ignore no-explicit-any
async function runStep(regua: any, step: any, inbox: any, now: Date, dryRun: boolean) {
  const target = new Date(now)
  target.setDate(target.getDate() - (step.offset_days || 0))
  const targetDue = isoDate(target)
  const runDate = isoDate(now)
  const label = step.on_load
    ? { regua: regua.name, offset: 'carga', loadedDate: runDate }
    : { regua: regua.name, offset: step.offset_days, targetDue }

  // Audiência: on_load = boletos carregados HOJE; offset = vencendo na data-alvo.
  let vq = admin.from('vw_cobranca_boletos')
    .select('phone_norm, source, customer_name, customer_phone, empreendimento, quadra, lote, parcela, due_date, amount, link_boleto')
  vq = step.on_load ? vq.eq('loaded_date', runDate) : vq.eq('due_date', targetDue)
  const af = regua.audience_filter || {}
  if (af.source && af.source !== 'both') vq = vq.eq('source', af.source)
  if (af.empreendimento) vq = vq.ilike('empreendimento', `%${af.empreendimento}%`)

  const { data: rows } = await vq
  const audience = (rows || []).filter((r) => r.customer_phone && r.phone_norm)

  if (dryRun) {
    return {
      ...label, total: audience.length,
      sample: audience.slice(0, 20).map((r) => ({ nome: r.customer_name, phone: r.customer_phone, parcela: r.parcela })),
    }
  }

  if (!inbox?.phone_number_id) return { ...label, error: 'inbox inválido' }
  const { data: tpl } = await admin.from('chat_wa_templates')
    .select('id, name, language, header_text, header_var_count, body_var_count, body_text')
    .eq('id', step.template_id).single()
  if (!tpl) return { ...label, error: 'template inválido' }

  let sent = 0, failed = 0, skipped = 0
  for (const r of audience) {
    const waId = String(r.customer_phone).replace(/\D/g, '')

    // Claim atômico via UNIQUE(regua_id, offset_days, phone_norm, due_date)
    const { data: claim } = await admin.from('cobranca_regua_log')
      .upsert({
        regua_id: regua.id, step_id: step.id, offset_days: step.offset_days,
        phone_norm: r.phone_norm, due_date: r.due_date, wa_id: waId,
        parcela: r.parcela, run_date: runDate, status: 'pending',
      }, { onConflict: 'regua_id,offset_days,phone_norm,due_date', ignoreDuplicates: true })
      .select('id').maybeSingle()

    if (!claim?.id) { skipped++; continue }

    const conv = await ensureConversation(admin, regua.inbox_id, waId, r.customer_name || undefined)
    if (!conv) {
      await admin.from('cobranca_regua_log').update({ status: 'failed', error: 'falha ao criar conversa' }).eq('id', claim.id)
      failed++; continue
    }

    const variables = resolveVariables(step.variable_mapping as VariableMapping, r)
    const res = await sendTemplateMessage({
      admin,
      inbox: { phone_number_id: inbox.phone_number_id, access_token: inbox.access_token },
      toWaId: waId,
      tpl: tpl as TemplateRow,
      variables,
      conversationId: conv.conversationId,
      metaExtra: { regua_id: regua.id, regua_step_id: step.id },
    })

    if (res.ok) {
      await admin.from('cobranca_regua_log').update({ status: 'sent', wa_message_id: res.waMessageId }).eq('id', claim.id)
      sent++
    } else {
      await admin.from('cobranca_regua_log').update({ status: 'failed', error: JSON.stringify(res.error).slice(0, 500) }).eq('id', claim.id)
      failed++
    }
    await SLEEP(DELAY_MS)
  }

  return { ...label, total: audience.length, sent, failed, skipped }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
