// sienge-webhook — recebe webhooks do Sienge (Títulos a Receber) e atualiza
// public.sienge_boletos. Eventos tratados:
//   • RECEIPT_PROCESSED               { billId, installmentId }   → baixa/recebimento
//   • UPDATE_RECEIVABLE_BILL_SITUATION { receivableBillId:[int], situation:string }
//   • PAYMENT_SLIP_REGISTERED         (header x-sienge-event)      → captura a 2ª via
//       (PDF + linha digitável) e faz upsert em boletos_emitidos — convive com o ZIP.
//   • customer_* / sales_contract_*   (header x-sienge-event)      → cadastro (push)
//
// Push (NÃO consome a cota REST). Por padrão confiamos no evento de baixa e marcamos
// 'pago' direto — nenhuma chamada à API do Sienge. A confirmação de balanceDue
// (distinguir recebimento total de adiantamento parcial) é OPCIONAL e só roda se
// SIENGE_WEBHOOK_CONFIRM=true. Protegido por token (verify_jwt=false).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { mapCustomer, mapContrato, fetchSegundaVia } from '../_shared/sienge.ts'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

const SIENGE_BASE     = 'https://api.sienge.com.br/avivconstrutora/public/api/v1'
const siengeAuth      = () => `Basic ${btoa(`${Deno.env.get('SIENGE_USER')}:${Deno.env.get('SIENGE_PASSWORD')}`)}`
const EXPECTED_TOKEN  = Deno.env.get('SIENGE_WEBHOOK_TOKEN') || ''
const CONFIRM_BALANCE = (Deno.env.get('SIENGE_WEBHOOK_CONFIRM') || '').toLowerCase() === 'true'

const ok   = (body: unknown = { ok: true }) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
const deny = (msg: string) => new Response(JSON.stringify({ error: msg }), { status: 401, headers: { 'Content-Type': 'application/json' } })

// O spec não fixa o header do token; aceitamos os formatos prováveis + query param.
function extractToken(req: Request, url: URL): string {
  const auth = req.headers.get('authorization') || ''
  if (auth) return auth.replace(/^Bearer\s+/i, '').trim()
  return (
    req.headers.get('x-sienge-token') ||
    req.headers.get('x-webhook-token') ||
    req.headers.get('token') ||
    url.searchParams.get('token') ||
    ''
  ).trim()
}

// OPCIONAL (só com SIENGE_WEBHOOK_CONFIRM=true): confirma se a parcela ficou quitada.
// Distingue recebimento total de adiantamento parcial. Consome 1 requisição REST.
async function isFullyPaid(billId: number, installmentId: number): Promise<boolean | null> {
  try {
    const resp = await fetch(`${SIENGE_BASE}/accounts-receivable/receivable-bills/${billId}/installments`,
      { headers: { Authorization: siengeAuth() } })
    if (!resp.ok) return null
    const inst = (await resp.json()).results?.find((i: any) => i.installmentId === installmentId)
    if (!inst) return null
    return Number(inst.balanceDue || 0) <= 0
  } catch { return null }
}

// FALLBACK (consome cota): quando o webhook de recebimento não casa nenhum boleto
// na base (título não sincronizado), busca o título no Sienge UMA vez, faz upsert
// em sienge_boletos como pago e devolve {customer_id, due_date} p/ propagar aos emitidos.
async function syncReceiptFromSienge(billId: number, installmentId: number): Promise<any[] | null> {
  try {
    const auth = siengeAuth()
    const bResp = await fetch(`${SIENGE_BASE}/accounts-receivable/receivable-bills/${billId}`, { headers: { Authorization: auth } })
    if (!bResp.ok) return null
    const bill = await bResp.json()
    const b = bill?.results?.[0] || bill || {}
    const customerId = b.customerId ?? b.clientId ?? null
    if (!customerId) return null

    const iResp = await fetch(`${SIENGE_BASE}/accounts-receivable/receivable-bills/${billId}/installments`, { headers: { Authorization: auth } })
    if (!iResp.ok) return null
    const inst = ((await iResp.json()).results || []).find((i: any) => Number(i.installmentId) === installmentId)
    if (!inst?.dueDate) return null

    const amount = inst.originalAmount ?? inst.value ?? inst.grossAmount ?? inst.balanceDue ?? null
    const { data } = await supabase.from('sienge_boletos').upsert({
      receivable_bill_id: billId,
      installment_id:     installmentId,
      customer_id:        customerId,
      customer_name:      b.customerName ?? b.name ?? null,
      due_date:           inst.dueDate,
      amount,
      parcela_descricao:  `Parcela ${installmentId}`,
      status:             'pago',
      paid_at:            new Date().toISOString(),
      updated_at:         new Date().toISOString(),
    }, { onConflict: 'receivable_bill_id,installment_id' }).select('id, customer_id, due_date')
    return data || []
  } catch (e) {
    console.error('syncReceiptFromSienge error:', e)
    return null
  }
}

// ── Webhooks de CADASTRO (cliente / contrato) ────────────────────────────────
// Mantém sienge_clientes / sienge_contratos frescos em tempo real (push). Defensivo
// quanto ao payload: usa o objeto se vier completo, senão busca por id (1 req).
// Retorna null se NÃO for evento de cadastro (segue a lógica de baixa).
async function handleCadastro(body: any, hookEvent = ''): Promise<{ event: string; matched: number; note: string } | null> {
  // O nome do evento vem no HEADER x-sienge-event (o body traz só o id, ex.: {customerId:1}).
  const evRaw = hookEvent || body?.event || body?.eventType || body?.type || ''
  const ev = String(evRaw).toLowerCase()
  const isCustomer = /customer|cliente/.test(ev) || body?.customerId != null
  const isContract = /sales[_-]?contract|contrato/.test(ev) || body?.salesContractId != null || Array.isArray(body?.salesContractUnits)
  if (!isCustomer && !isContract) return null

  const removed = /remov|delet|cancel/.test(ev)

  if (isContract) {
    const id = Number(body?.salesContractId ?? body?.id)
    if (!id) return { event: ev || 'contract', matched: 0, note: 'sem id de contrato' }
    if (removed) {
      const { count } = await supabase.from('sienge_contratos').delete({ count: 'exact' }).eq('contract_id', id)
      return { event: ev, matched: count || 0, note: 'contrato removido' }
    }
    let ct = body
    if (!Array.isArray(body?.salesContractCustomers)) {
      const r = await fetch(`${SIENGE_BASE}/sales-contracts/${id}`, { headers: { Authorization: siengeAuth() } })
      if (r.ok) ct = await r.json().then((j) => j?.results?.[0] ?? j)
    }
    ct.id = ct.id ?? id
    const { error, count } = await supabase.from('sienge_contratos').upsert(mapContrato(ct), { onConflict: 'contract_id', count: 'exact' })
    return { event: ev || 'sales_contract', matched: count || 0, note: error ? 'erro: ' + error.message : 'contrato upsert' }
  }

  // cliente
  const id = Number(body?.customerId ?? body?.id)
  if (!id) return { event: ev || 'customer', matched: 0, note: 'sem id de cliente' }
  if (removed) {
    const { count } = await supabase.from('sienge_clientes').delete({ count: 'exact' }).eq('client_id', id)
    return { event: ev, matched: count || 0, note: 'cliente removido' }
  }

  // Buscar o cadastro completo no Sienge. No instante do CUSTOMER_CREATED o cliente
  // às vezes ainda NÃO está consultável (GET volta vazio) — daí o registro ficava
  // com nome/telefone nulos. Tenta de novo com backoff curto antes de desistir.
  let cust: any = (body?.name != null || body?.phones != null) ? body : null
  for (let attempt = 0; attempt < 3 && !cust?.name; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1500))
    const r = await fetch(`${SIENGE_BASE}/customers/${id}`, { headers: { Authorization: siengeAuth() } })
    if (!r.ok) continue
    const c = await r.json().then((j) => j?.results?.[0] ?? j).catch(() => null)
    if (c && (c.name || Array.isArray(c.phones))) cust = c
  }

  // Sem dados utilizáveis: NÃO grava nulos por cima (não clobber) nem cria stub
  // enganoso. Registra honestamente; o sync diário reconcilia o cadastro.
  if (!cust?.name) {
    return { event: ev || 'customer', matched: 0, note: `cadastro Sienge indisponível p/ ${id} no momento do webhook — aguardando reconciliação (sync)` }
  }

  cust.id = cust.id ?? id
  const { error, count } = await supabase.from('sienge_clientes').upsert(mapCustomer(cust), { onConflict: 'client_id', count: 'exact' })
  return { event: ev || 'customer', matched: count || 0, note: error ? 'erro: ' + error.message : 'cliente upsert' }
}

// ── Webhook PAYMENT_SLIP_REGISTERED (boleto/carnê registrado no banco) ───────────
// Captura a 2ª via (PDF + linha digitável) do Sienge e faz upsert em boletos_emitidos
// — a MESMA chave (client_id, vencimento) e bucket do ZIP, então os dois caminhos
// convivem (o que chegar por último vence). Idempotente. Gated ESTRITAMENTE pelo
// header x-sienge-event (não colide com RECEIPT_PROCESSED, que tem o mesmo {billId}).
// Retorna null se NÃO for esse evento (segue a lógica de baixa).
const slipBoletoPath = (clientId: number, venc: string) => `${clientId}/${venc}.pdf`

// Resolve client_id + vencimento + valor da parcela: base local primeiro, Sienge 1x se faltar.
async function resolveTitulo(billId: number, instId: number): Promise<
  { customer_id: number; due_date: string; amount: number | null; customer_name: string | null } | null
> {
  const { data } = await supabase.from('sienge_boletos')
    .select('customer_id, due_date, amount, customer_name')
    .eq('receivable_bill_id', billId).eq('installment_id', instId).maybeSingle()
  if (data?.customer_id && data?.due_date) return data as any

  // Fallback (consome cota): busca o título + a parcela no Sienge uma vez.
  try {
    const auth = siengeAuth()
    const bResp = await fetch(`${SIENGE_BASE}/accounts-receivable/receivable-bills/${billId}`, { headers: { Authorization: auth } })
    if (!bResp.ok) return null
    const bill = await bResp.json()
    const b = bill?.results?.[0] || bill || {}
    const customerId = Number(b.customerId ?? b.clientId ?? 0) || null
    if (!customerId) return null
    const iResp = await fetch(`${SIENGE_BASE}/accounts-receivable/receivable-bills/${billId}/installments`, { headers: { Authorization: auth } })
    if (!iResp.ok) return null
    const inst = ((await iResp.json()).results || []).find((i: any) => Number(i.installmentId) === instId)
    if (!inst?.dueDate) return null
    const amount = Number(inst.originalAmount ?? inst.value ?? inst.grossAmount ?? inst.balanceDue ?? 0) || null
    return { customer_id: customerId, due_date: inst.dueDate, amount, customer_name: b.customerName ?? b.name ?? null }
  } catch (e) {
    console.error('resolveTitulo error:', e)
    return null
  }
}

async function handlePaymentSlip(body: any, hookEvent = ''): Promise<{ event: string; matched: number; note: string } | null> {
  const ev = String(hookEvent || body?.event || body?.eventType || body?.type || '').toLowerCase()
  const isSlip = /payment[_-]?slip|boleto.*regist|slip.*regist|carne.*regist/.test(ev)
  if (!isSlip) return null
  const evName = hookEvent || 'PAYMENT_SLIP_REGISTERED'

  // Extração defensiva do id do título e da parcela (o shape exato é confirmado no 1º evento).
  const ps = body?.paymentSlip ?? body
  const billId = Number(body?.billReceivableId ?? body?.receivableBillId ?? body?.billId ?? ps?.billReceivableId ?? ps?.receivableBillId ?? body?.id ?? 0) || 0
  const instId = Number(body?.installmentId ?? body?.installment ?? ps?.installmentId ?? 0) || 0
  if (!billId || !instId) return { event: evName, matched: 0, note: `sem billReceivableId/installmentId (bill=${billId} inst=${instId})` }

  // Quem é o cliente e qual o vencimento (define a chave do boleto emitido).
  const tit = await resolveTitulo(billId, instId)
  if (!tit) return { event: evName, matched: 0, note: `título ${billId}/${instId} não resolvido (base + Sienge)` }

  // 2ª via: PDF (urlReport) + linha digitável.
  const via = await fetchSegundaVia(billId, instId)
  if (!via?.url) return { event: evName, matched: 0, note: `2ª via sem urlReport (bill=${billId} inst=${instId})` }

  // Baixa o PDF e sobe no bucket privado `boletos` (mesma convenção do ZIP).
  let pdfPath: string | null = slipBoletoPath(tit.customer_id, tit.due_date)
  try {
    const pdfResp = await fetch(via.url)
    if (!pdfResp.ok) return { event: evName, matched: 0, note: `download do PDF falhou (${pdfResp.status})` }
    const pdfBytes = new Uint8Array(await pdfResp.arrayBuffer())
    const { error: upErr } = await supabase.storage.from('boletos')
      .upload(pdfPath, pdfBytes, { contentType: 'application/pdf', upsert: true })
    if (upErr) { console.error('slip upload PDF:', upErr.message); pdfPath = null }
  } catch (e) {
    console.error('slip download PDF:', e); pdfPath = null
  }

  // Telefone do cadastro (mesma fonte do ZIP).
  const { data: cli } = await supabase.from('sienge_clientes')
    .select('telefone, nome').eq('client_id', tit.customer_id).maybeSingle()

  // Não rebaixar um boleto já pago/cancelado: preserva o status nesse caso.
  const { data: existing } = await supabase.from('boletos_emitidos')
    .select('status').eq('client_id', tit.customer_id).eq('vencimento', tit.due_date).maybeSingle()
  const preservaStatus = existing && ['pago', 'cancelado'].includes(String(existing.status))

  const row: Record<string, any> = {
    client_id:       tit.customer_id,
    customer_name:   tit.customer_name || cli?.nome || null,
    vencimento:      tit.due_date,
    valor:           via.valor ?? tit.amount ?? null,
    linha_digitavel: (via.digitavel || '').replace(/\s+/g, ' ').trim() || null,
    telefone:        cli?.telefone || null,
    lote:            'sienge-webhook',
    pdf_path:        pdfPath,
    updated_at:      new Date().toISOString(),
  }
  if (!preservaStatus) row.status = 'aberto'

  const { error, count } = await supabase.from('boletos_emitidos')
    .upsert(row, { onConflict: 'client_id,vencimento', count: 'exact' })
  if (error) return { event: evName, matched: 0, note: 'erro upsert: ' + error.message }
  return {
    event: evName, matched: count || 1,
    note: `boleto capturado (client ${tit.customer_id}, venc ${tit.due_date}${pdfPath ? '' : ', SEM pdf'}${preservaStatus ? ', status preservado' : ''})`,
  }
}

function classifySituation(s: string): 'pago' | 'cancelado' | null {
  const t = (s || '').toLowerCase()
  if (/cancel/.test(t)) return 'cancelado'
  if (/quit|liquid|baix|pag/.test(t)) return 'pago'
  return null   // situação não acionável → só audita
}

// Propaga o status para boletos_emitidos (fonte de verdade do boleto que enviamos),
// casando pela chave do Sienge (customer_id + due_date). Mantém as duas bases alinhadas.
async function propagateToEmitidos(rows: any[], novoStatus: 'pago' | 'cancelado') {
  const patch: Record<string, any> = { status: novoStatus, updated_at: new Date().toISOString() }
  if (novoStatus === 'pago') patch.paid_at = new Date().toISOString()
  for (const sb of rows || []) {
    if (!sb?.customer_id || !sb?.due_date) continue
    await supabase.from('boletos_emitidos').update(patch)
      .eq('client_id', sb.customer_id).eq('vencimento', sb.due_date)
      .not('status', 'in', '("pago","cancelado")')
  }
}

Deno.serve(async (req) => {
 try {
  const url = new URL(req.url)
  if (req.method === 'GET')  return ok({ ok: true, service: 'sienge-webhook' })
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  // ── Autenticação por token ──────────────────────────────────────────────────
  const token = extractToken(req, url)
  if (EXPECTED_TOKEN && token !== EXPECTED_TOKEN) return deny('invalid token')

  // ── Corpo ───────────────────────────────────────────────────────────────────
  let body: any = {}
  try { body = await req.json() } catch { /* mantém {} */ }

  const headers: Record<string, string> = {}
  for (const [k, v] of req.headers.entries()) {
    if (/^(authorization|cookie)$/i.test(k)) { headers[k] = '***'; continue }
    headers[k] = v
  }

  // ── Eventos de CADASTRO (cliente/contrato) — push em tempo real ──────────────
  // O Sienge manda o nome do evento no header x-sienge-event; o body traz só o id.
  const hookEvent = req.headers.get('x-sienge-event') || req.headers.get('x-event') || ''
  const cad = await handleCadastro(body, hookEvent)
  if (cad) {
    try {
      await supabase.from('sienge_webhook_events').insert({
        event: cad.event, payload: body, headers, matched: cad.matched, note: cad.note,
      })
    } catch (_) { /* auditoria best-effort */ }
    return ok({ ok: true, event: cad.event, matched: cad.matched, note: cad.note || undefined })
  }

  // ── PAYMENT_SLIP_REGISTERED — captura a 2ª via do boleto recém-registrado ─────
  const slip = await handlePaymentSlip(body, hookEvent)
  if (slip) {
    try {
      await supabase.from('sienge_webhook_events').insert({
        event: slip.event,
        receivable_bill_id: Number(body?.billReceivableId ?? body?.receivableBillId ?? body?.billId ?? 0) || null,
        installment_id:     Number(body?.installmentId ?? 0) || null,
        payload: body, headers, matched: slip.matched, note: slip.note,
      })
    } catch (_) { /* auditoria best-effort */ }
    return ok({ ok: true, event: slip.event, matched: slip.matched, note: slip.note || undefined })
  }

  // Identifica o evento pela forma do payload (ou por body.event, se vier).
  const isReceipt   = body?.billId != null && body?.installmentId != null
  const isSituation = Array.isArray(body?.receivableBillId) && body?.situation != null
  const event = body?.event || (isReceipt ? 'RECEIPT_PROCESSED' : isSituation ? 'UPDATE_RECEIVABLE_BILL_SITUATION' : 'UNKNOWN')

  let matched = 0
  let note = ''

  try {
    if (isReceipt) {
      const billId = Number(body.billId)
      const installmentId = Number(body.installmentId)

      // Confiamos no evento de baixa por padrão (zero REST). Só checamos se a flag estiver ligada.
      let marcarPago = true
      if (CONFIRM_BALANCE) {
        const paid = await isFullyPaid(billId, installmentId)
        if (paid === false) { marcarPago = false; note = 'recebimento parcial/adiantamento — mantido em aberto' }
        else if (paid === null) note = 'balanceDue não confirmado (API) — marcado por confiança no evento'
      }

      if (marcarPago) {
        const { data, error } = await supabase.from('sienge_boletos')
          .update({ status: 'pago', paid_at: new Date().toISOString(), updated_at: new Date().toISOString() }, { count: 'exact' })
          .eq('receivable_bill_id', billId).eq('installment_id', installmentId).select('id, customer_id, due_date')
        if (error) note = `erro update: ${error.message}`
        matched = data?.length || 0
        await propagateToEmitidos(data || [], 'pago')

        // Não casou → título não sincronizado: busca no Sienge 1x e grava.
        if (matched === 0) {
          const synced = await syncReceiptFromSienge(billId, installmentId)
          if (synced && synced.length) {
            matched = synced.length
            note = 'sincronizado do Sienge (título não estava na base)'
            await propagateToEmitidos(synced, 'pago')
          } else if (synced === null) {
            note = 'não casou e fallback Sienge falhou'
          } else {
            note = 'não casou (título não encontrado no Sienge)'
          }
        }
      }
    } else if (isSituation) {
      const novo = classifySituation(body.situation)
      if (!novo) {
        note = `situação não acionável: "${body.situation}"`
      } else {
        const patch: Record<string, any> = { status: novo, updated_at: new Date().toISOString() }
        if (novo === 'pago') patch.paid_at = new Date().toISOString()
        const { data, error } = await supabase.from('sienge_boletos')
          .update(patch, { count: 'exact' })
          .in('receivable_bill_id', body.receivableBillId.map(Number)).select('id, customer_id, due_date')
        if (error) note = `erro update: ${error.message}`
        matched = data?.length || 0
        await propagateToEmitidos(data || [], novo)
      }
    } else {
      note = 'payload não reconhecido'
    }
  } catch (e) {
    note = `falha: ${String(e)}`
  }

  // ── Auditoria (sempre) ───────────────────────────────────────────────────────
  try {
    await supabase.from('sienge_webhook_events').insert({
      event,
      receivable_bill_id: isReceipt ? Number(body.billId) : (isSituation ? Number(body.receivableBillId?.[0]) : null),
      installment_id:     isReceipt ? Number(body.installmentId) : null,
      situation:          isSituation ? String(body.situation) : null,
      payload: body, headers, matched, note,
    })
  } catch (_) { /* auditoria é best-effort */ }

  // Sempre 2XX para o Sienge dar ack (erros ficam registrados na auditoria).
  return ok({ ok: true, event, matched, note: note || undefined })
 } catch (e) {
  console.error('sienge-webhook fatal:', e)
  return ok({ ok: false, error: String(e) })
 }
})
