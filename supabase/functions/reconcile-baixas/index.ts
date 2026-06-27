/**
 * reconcile-baixas — Edge Function (rede de segurança da baixa)
 *
 * Reprocessa os eventos RECEIPT_PROCESSED que NÃO casaram em tempo real
 * (sienge_webhook_events.matched=0). Para cada um, chama applyReceipt:
 *   1) sienge_boletos pela chave exata
 *   2) boletos_emitidos pela CHAVE DO SIENGE (offline, sem API)
 *   3) fallback Sienge (1x, com throttle entre eventos para não estourar a cota)
 *
 * Como o webhook já entrega { billId, installmentId } de TODA baixa e nós os
 * logamos, este replay recupera qualquer baixa que falhou no momento (cota/queda).
 *
 * Invocação: cron (sem body) ou manual { limit?, retryFailed? }.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { applyReceipt } from '../_shared/sienge.ts'

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

const BATCH    = 40
const DELAY_MS = 350   // throttle entre eventos (o fallback do Sienge consome cota)
const SLEEP    = (ms: number) => new Promise((r) => setTimeout(r, ms))

Deno.serve(async (req) => {
  try {
    const body = await req.json().catch(() => ({}))
    const limit = Math.min(Number(body?.limit) || BATCH, 200)
    const retryFailed = !!body?.retryFailed   // reprocessa também os já marcados (matched=0)

    let q = admin.from('sienge_webhook_events')
      .select('id, receivable_bill_id, installment_id, payload')
      .eq('event', 'RECEIPT_PROCESSED').eq('matched', 0)
      .order('created_at', { ascending: true }).limit(limit)
    if (!retryFailed) q = q.is('reconciled_at', null)

    const { data: events } = await q

    let recuperados = 0, naoCasaram = 0
    const results: any[] = []
    for (const ev of events || []) {
      const billId = Number(ev.receivable_bill_id ?? (ev.payload as any)?.billId) || 0
      const instId = Number(ev.installment_id ?? (ev.payload as any)?.installmentId) || 0
      if (!billId || !instId) { await mark(ev.id, 0, 'sem billId/installmentId'); naoCasaram++; continue }

      const res = await applyReceipt(admin, billId, instId)
      await mark(ev.id, res.matched, res.note)
      if (res.matched > 0) recuperados++; else naoCasaram++
      results.push({ billId, instId, matched: res.matched, note: res.note })
      await SLEEP(DELAY_MS)
    }

    return json({ ok: true, processados: (events || []).length, recuperados, naoCasaram, results })
  } catch (e) {
    console.error('reconcile-baixas error:', e)
    return json({ error: String(e) }, 500)
  }
})

async function mark(id: string, matched: number, note: string) {
  await admin.from('sienge_webhook_events')
    .update({ matched, note, reconciled_at: new Date().toISOString() })
    .eq('id', id)
}
function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } })
}
