// sienge-webhook — recebe webhooks do Sienge (Títulos a Receber) e atualiza
// public.sienge_boletos. Eventos tratados:
//   • RECEIPT_PROCESSED               { billId, installmentId }   → baixa/recebimento
//   • UPDATE_RECEIVABLE_BILL_SITUATION { receivableBillId:[int], situation:string }
//
// Push (NÃO consome a cota REST). Por padrão confiamos no evento de baixa e marcamos
// 'pago' direto — nenhuma chamada à API do Sienge. A confirmação de balanceDue
// (distinguir recebimento total de adiantamento parcial) é OPCIONAL e só roda se
// SIENGE_WEBHOOK_CONFIRM=true. Protegido por token (verify_jwt=false).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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

function classifySituation(s: string): 'pago' | 'cancelado' | null {
  const t = (s || '').toLowerCase()
  if (/cancel/.test(t)) return 'cancelado'
  if (/quit|liquid|baix|pag/.test(t)) return 'pago'
  return null   // situação não acionável → só audita
}

Deno.serve(async (req) => {
 try {
  const url = new URL(req.url)
  if (req.method === 'GET')  return ok({ ok: true, service: 'sienge-webhook', tokenConfigured: !!EXPECTED_TOKEN })
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
          .eq('receivable_bill_id', billId).eq('installment_id', installmentId).select('id')
        if (error) note = `erro update: ${error.message}`
        matched = data?.length || 0
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
          .in('receivable_bill_id', body.receivableBillId.map(Number)).select('id')
        if (error) note = `erro update: ${error.message}`
        matched = data?.length || 0
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
