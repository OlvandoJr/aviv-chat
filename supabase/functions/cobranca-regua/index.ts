/**
 * cobranca-regua — Edge Function
 *
 * Régua = fluxo (pai) com vários disparos (passos). Cada passo dispara um
 * template aos boletos cujo vencimento está a `offset_days` de hoje (BRT):
 *   alvo = hoje(BRT) - offset_days   (offset -3 dispara 3 dias antes do vencimento)
 *
 * Passo com `on_load=true` (disparo no dia do carregamento): audiência são os
 * boletos cuja data EFETIVA de disparo é hoje (load_dispatch_date na view:
 * carregado até 18h BRT → mesmo dia; depois → dia seguinte; sáb/dom → segunda).
 * O horário é "a partir de": como o cron é horário, o passo roda em toda passada
 * com hora >= send_time, e a UNIQUE do log garante 1 envio por boleto
 * (offset_days=999 é sentinela de dedup desses passos).
 *
 * REGRA LEGAL (dias úteis): nada dispara em sábado/domingo. O run é pulado no
 * fim de semana (force=true é o único override) e, na SEGUNDA, os passos de
 * offset cobrem também os alvos que cairiam no sábado e no domingo.
 *
 * Invocação:
 *  - cron horário (sem body) → roda os passos cujo send_time bate com a hora atual
 *  - manual: { reguaId?, force?, dryRun? }
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  ensureConversation,
  cleanupEmptyConversation,
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

// Pareamento template-com-PDF → template-sem-PDF (texto). Quando o boleto do
// destinatário não tem PDF, a régua usa o fallback (mesmo mapeamento de variáveis).
const NO_PDF_FALLBACK: Record<string, string> = {
  a_vencer1: 'a_vencer2_sem_pdf',
}

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
    const dow = now.getDay()   // 0=dom … 6=sáb (BRT)

    // Regra legal: cobrança não sai em sábado/domingo (posterga p/ segunda).
    if ((dow === 0 || dow === 6) && !force) {
      return json({ ok: true, skipped: 'fim de semana — disparos postergados para segunda' })
    }

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
  const runDate = isoDate(now)

  // Alvos do passo de offset: hoje; na SEGUNDA inclui também os alvos que cairiam
  // no sábado e no domingo (regra legal — disparos postergados).
  const targetDues: string[] = []
  const backDays = now.getDay() === 1 ? [2, 1, 0] : [0]
  for (const back of backDays) {
    const t = new Date(now)
    t.setDate(t.getDate() - back - (step.offset_days || 0))
    targetDues.push(isoDate(t))
  }
  const label = step.on_load
    ? { regua: regua.name, offset: 'carga', dispatchDate: runDate }
    : { regua: regua.name, offset: step.offset_days, targetDues }

  // Audiência: on_load = data efetiva de disparo (carga) é hoje; offset = vencendo na(s) data(s)-alvo.
  let vq = admin.from('vw_cobranca_boletos')
    .select('phone_norm, source, customer_name, customer_phone, empreendimento, quadra, lote, parcela, due_date, amount, link_boleto')
  vq = step.on_load ? vq.eq('load_dispatch_date', runDate) : vq.in('due_date', targetDues)
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
  const TPL_COLS = 'id, name, language, header_text, header_var_count, body_var_count, body_text, header_type'
  const { data: tpl } = await admin.from('chat_wa_templates').select(TPL_COLS).eq('id', step.template_id).single()
  if (!tpl) return { ...label, error: 'template inválido' }

  // Header de mídia (ex.: DOCUMENT): o template exige o PDF anexado no envio.
  const headerMedia = (tpl.header_type || '').toUpperCase()
  const precisaPdf = headerMedia === 'DOCUMENT' || headerMedia === 'IMAGE' || headerMedia === 'VIDEO'

  // Quando NÃO há PDF, cai para um template de texto (mesmo mapeamento de variáveis).
  // Pareamento por nome; ativa só quando o fallback estiver APROVADO/sincronizado.
  let fallbackTpl: any = null
  if (precisaPdf) {
    const fbName = NO_PDF_FALLBACK[tpl.name]
    if (fbName) {
      const { data } = await admin.from('chat_wa_templates').select(TPL_COLS)
        .eq('name', fbName).eq('inbox_id', regua.inbox_id).eq('status', 'APPROVED').maybeSingle()
      fallbackTpl = data || null
    }
  }

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

    // Escolhe o template por destinatário: COM PDF → template de documento (anexa
    // o PDF); SEM PDF → template de texto (fallback). Mesmo mapeamento de variáveis.
    let tplToSend: any = tpl
    let mediaArg: { link: string; filename?: string } | null = null
    if (precisaPdf) {
      // pdf_path vem de boletos_emitidos (chave phone_norm + vencimento).
      const { data: be } = await admin.from('boletos_emitidos')
        .select('pdf_path').eq('phone_norm', r.phone_norm).eq('vencimento', r.due_date).maybeSingle()
      const signedUrl = be?.pdf_path
        ? (await admin.storage.from('boletos').createSignedUrl(be.pdf_path, 600)).data?.signedUrl
        : null
      if (signedUrl) {
        const venc = String(r.due_date || '').slice(0, 10)
        mediaArg = { link: signedUrl, filename: `Boleto ${venc}.pdf` }     // → a_vencer1 com PDF
      } else if (fallbackTpl) {
        tplToSend = fallbackTpl                                            // → a_vencer2_sem_pdf (texto)
      } else {
        await admin.from('cobranca_regua_log').update({ status: 'failed', error: 'sem PDF e sem template de fallback aprovado' }).eq('id', claim.id)
        await cleanupEmptyConversation(admin, conv)
        failed++; continue
      }
    }

    const variables = resolveVariables(step.variable_mapping as VariableMapping, r)
    const res = await sendTemplateMessage({
      admin,
      inbox: { phone_number_id: inbox.phone_number_id, access_token: inbox.access_token },
      toWaId: waId,
      tpl: tplToSend as TemplateRow,
      variables,
      conversationId: conv.conversationId,
      metaExtra: { regua_id: regua.id, regua_step_id: step.id },
      headerMedia: mediaArg,
    })

    if (res.ok) {
      await admin.from('cobranca_regua_log').update({ status: 'sent', wa_message_id: res.waMessageId }).eq('id', claim.id)
      sent++
    } else {
      await admin.from('cobranca_regua_log').update({ status: 'failed', error: JSON.stringify(res.error).slice(0, 500) }).eq('id', claim.id)
      await cleanupEmptyConversation(admin, conv)
      failed++
    }
    await SLEEP(DELAY_MS)
  }

  return { ...label, total: audience.length, sent, failed, skipped }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
