/**
 * sgl-dispatch — Edge Function (poller)
 *
 * Cobrança SGL orientada a evento. O n8n recebe o webhook do SGL, faz o parse e
 * GRAVA em mensagens_cobranca (sem enviar). Esta função reage a cada NOVO registro
 * (app_dispatched_at IS NULL), classifica pelo vencimento, escolhe o template via
 * sgl_regua_map e envia pelo nosso núcleo. Como o SGL só insere para quem está em
 * aberto, herdamos a inteligência de pagamento dele.
 *
 * Invocação: cron (~5 min) sem body. Manual: { dryRun?: boolean, limit?: number, force?: boolean }.
 *
 * REGRA LEGAL (dias úteis): não envia em sábado/domingo — a fila acumula e a
 * segunda processa. A classificação usa a data de ENTRADA do registro (created_at
 * BRT), preservando o template certo (ex.: vencida_3_dias) no envio postergado.
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

const BATCH = 80
const DELAY_MS = 120
const MAX_ATTEMPTS = 5   // após N falhas de envio, desiste (marca tratado) para não loopar

function brtNow(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }))
}
function brtTodayStr(): string {
  return brtNow().toISOString().slice(0, 10)
}
// Data BRT de um timestamp do banco — classificação usa o dia em que o registro
// ENTROU (o SGL grava no dia em que mandou cobrar), não o dia do processamento.
// Igual no fluxo normal (poller ~5min); correto quando seguramos o fim de semana.
function brtDateOf(ts: string): string {
  return new Date(new Date(ts).toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }))
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
    const force = !!body?.force
    const limit = Math.min(Number(body?.limit) || BATCH, 500)

    // Regra legal: cobrança não sai em sábado/domingo. Os registros acumulam
    // (app_dispatched_at IS NULL) e a segunda-feira processa a fila normalmente.
    const dow = brtNow().getDay()
    if ((dow === 0 || dow === 6) && !force) {
      return new Response(JSON.stringify({ ok: true, skipped: 'fim de semana — cobrança postergada para segunda' }),
        { headers: { 'Content-Type': 'application/json' } })
    }

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
      .select('id, phone, phone_norm, pessoanomecompleto, unidadeempreendimento, unidadequadraandar, unidadeloteapartamento, contasreceberparcela, contasrecebervencimento, contasrecebervalor, linkboleto, app_dispatch_attempts, created_at')
      .is('app_dispatched_at', null)
      .order('created_at', { ascending: true })
      .limit(limit)

    // ── Supressão: parcelas que já receberam comprovante (ou foram pagas) não cobram ──
    // (chave telefone+parcela; cobre o lag até o SGL registrar a baixa)
    const suppressed = new Set<string>()
    const phones = [...new Set((rows || []).map((r: any) => r.phone_norm).filter(Boolean))]
    if (phones.length) {
      const { data: done } = await admin
        .from('mensagens_cobranca')
        .select('phone_norm, contasreceberparcela')
        .in('phone_norm', phones)
        .in('status', ['comprovante_recebido', 'comprovante_confirmado', 'pago', 'baixado'])
      for (const d of done || []) suppressed.add(`${d.phone_norm}||${d.contasreceberparcela}`)
    }

    // ── Supressão: cliente DISTRATADO não recebe cobrança do SGL ──────────────
    // O SGL não tem API — mas não precisamos dela: quem sabe do distrato é o
    // Sienge, e a ponte entre os dois é o TELEFONE (mesmo phone_norm nas duas
    // bases). Mesmo critério das views de cobrança (migrations 068/069): bloqueia
    // só quem TEM contrato(s) e NENHUM ativo. Sem vínculo com o Sienge (cliente
    // SGL puro, ~14% dos telefones) NÃO bloqueia — na dúvida, cobra, porque
    // barrar às cegas seria pior do que cobrar um distratado.
    const distratados = new Set<string>()
    if (phones.length) {
      // telefone → client_id(s). Um telefone pode apontar para MAIS DE UM cliente
      // (casal, cadastro duplicado): 43 casos hoje, 12 deles com alguém ativo.
      // Guardamos a lista inteira — colapsar em um só bloquearia por engano quem
      // tem contrato vigente, parando cobrança legítima em silêncio.
      const foneClientes = new Map<string, Set<number>>()
      const [{ data: clis }, { data: emitidos }] = await Promise.all([
        admin.from('sienge_clientes').select('client_id, phone_norm').in('phone_norm', phones),
        admin.from('boletos_emitidos').select('client_id, phone_norm').in('phone_norm', phones).not('client_id', 'is', null),
      ])
      for (const c of [...(clis || []), ...(emitidos || [])]) {
        if (!c.phone_norm || c.client_id == null) continue
        if (!foneClientes.has(c.phone_norm)) foneClientes.set(c.phone_norm, new Set())
        foneClientes.get(c.phone_norm)!.add(Number(c.client_id))
      }
      const clientIds = [...new Set([...foneClientes.values()].flatMap((s) => [...s]))]
      if (clientIds.length) {
        const { data: contratos } = await admin.from('sienge_contratos')
          .select('client_id, situation').in('client_id', clientIds)
        const temContrato = new Set<number>()
        const temAtivo    = new Set<number>()
        for (const ct of contratos || []) {
          const cid = Number(ct.client_id)
          temContrato.add(cid)
          if (!/cancel|distrat/i.test(String(ct.situation || ''))) temAtivo.add(cid)
        }
        // Bloqueia só quando NENHUM cliente do telefone tem contrato ativo.
        for (const [fone, cids] of foneClientes) {
          const algumContrato = [...cids].some((c) => temContrato.has(c))
          const algumAtivo    = [...cids].some((c) => temAtivo.has(c))
          if (algumContrato && !algumAtivo) distratados.add(fone)
        }
      }
    }

    const inboxCache: Record<string, any> = {}
    const tplCache: Record<string, TemplateRow | null> = {}
    const result = { processed: 0, sent: 0, skipped: 0, failed: 0, retry: 0, gaveup: 0, byClass: {} as Record<string, number>, samples: [] as any[] }

    for (const r of rows || []) {
      result.processed++
      const classificacao = classify(r.contasrecebervencimento, r.created_at ? brtDateOf(r.created_at) : brtTodayStr())
      result.byClass[classificacao] = (result.byClass[classificacao] || 0) + 1
      const m = mapByClass[classificacao]
      const waId = String(r.phone || '').replace(/\D/g, '')

      // Parcela já com comprovante/baixa → não cobra (sai da régua)
      const suprimida = suppressed.has(`${r.phone_norm}||${r.contasreceberparcela}`)

      if (dryRun) {
        if (result.samples.length < 25) result.samples.push({ phone: waId, nome: r.pessoanomecompleto, venc: r.contasrecebervencimento, classificacao, template: distratados.has(r.phone_norm) ? 'BLOQUEADO (distrato)' : suprimida ? 'SUPRIMIDO (comprovante)' : (m ? 'sim' : 'NÃO ENVIA') })
        continue
      }

      // Distrato: registra o motivo (auditoria) e não cobra.
      if (distratados.has(r.phone_norm)) {
        await admin.from('mensagens_cobranca').update({
          app_dispatched_at:  new Date().toISOString(),
          app_dispatch_error: 'não enviado: cliente sem contrato ativo no Sienge (distrato)',
        }).eq('id', r.id)
        result.skipped++
        continue
      }

      if (suprimida) {
        await markDispatched(r.id)
        result.skipped++
        continue
      }

      // GUARDA: registro sem dados de cobrança (link do boleto ou vencimento) —
      // tipicamente linha de estado do fluxo n8n legado que polui esta tabela,
      // não uma cobrança do SGL (o webhook de cobrança SEMPRE traz o link).
      // NUNCA cobrar sem boleto: marca tratado com o motivo (auditoria) e pula.
      const semLink = !String(r.linkboleto || '').trim()
      if (semLink || !r.contasrecebervencimento) {
        await admin.from('mensagens_cobranca').update({
          app_dispatched_at:  new Date().toISOString(),
          app_dispatch_error: `não enviado: registro sem ${semLink ? 'linkboleto' : 'vencimento'}`,
        }).eq('id', r.id)
        result.skipped++
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
        await cleanupEmptyConversation(admin, conv)   // envio falhou → não deixa conversa fantasma
      }
      await SLEEP(DELAY_MS)
    }

    return json({ ok: true, dryRun, today: brtTodayStr(), ...result })
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
