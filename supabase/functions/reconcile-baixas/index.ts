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
import { applyReceipt, SiengeRateLimited } from '../_shared/sienge.ts'

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

const BATCH        = 40
const MAX_ATTEMPTS = 5   // falha transitória volta amanhã; morre de vez só na 5ª
const DELAY_MS = 350   // throttle entre eventos (o fallback do Sienge consome cota)
const SLEEP    = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ORÇAMENTO DIÁRIO de chamadas ao Sienge feitas por esta reconciliação. O plano
// Free dá 100 requisições REST por DIA no total — e a mesma cota é usada pela 2ª
// via do boleto do cliente, pelo bot e pelos syncs. Reservamos uma fatia pequena
// aqui; o resto do dia fica para o que o cliente vê.
const BUDGET_DIA = Number(Deno.env.get('SIENGE_FALLBACK_BUDGET') || '20')

// Quantas chamadas ao Sienge já gastamos HOJE. Conta só as notas com o marcador
// "[api]" — os eventos resolvidos offline (filtro de relevância) não consomem cota
// e não podem entrar nesta conta.
async function gastoHoje(): Promise<number> {
  const inicioDoDia = new Date(); inicioDoDia.setUTCHours(0, 0, 0, 0)
  const iso = inicioDoDia.toISOString()
  // Uma ida à API pode terminar de três jeitos: finalizada (reconciled_at),
  // pendente para retry (só last_attempt_at) ou registrada pelo webhook na
  // chegada (só created_at). As três precisam contar, senão o orçamento fura.
  const { count } = await admin.from('sienge_webhook_events')
    .select('id', { count: 'exact', head: true })
    .or(`reconciled_at.gte.${iso},last_attempt_at.gte.${iso},created_at.gte.${iso}`)
    .ilike('note', '%[api]%')
  return count || 0
}

Deno.serve(async (req) => {
  try {
    const body = await req.json().catch(() => ({}))
    const limit = Math.min(Number(body?.limit) || BATCH, 200)
    const retryFailed = !!body?.retryFailed   // reprocessa também os já marcados (matched=0)

    let q = admin.from('sienge_webhook_events')
      .select('id, receivable_bill_id, installment_id, payload, attempts')
      .eq('event', 'RECEIPT_PROCESSED').eq('matched', 0)
      .lt('attempts', MAX_ATTEMPTS)
      // retryFailed revisita os já marcados — recentes primeiro (baixa nova
      // presa importa mais que evento antigo de parcela irrelevante)
      .order('created_at', { ascending: !retryFailed }).limit(limit)
    if (!retryFailed) q = q.is('reconciled_at', null)

    const { data: events } = await q

    let recuperados = 0, naoCasaram = 0, ignorados = 0
    let orcamentoRestante = Math.max(0, BUDGET_DIA - (await gastoHoje()))
    let rateLimited = false
    const results: any[] = []
    for (const ev of events || []) {
      const billId = Number(ev.receivable_bill_id ?? (ev.payload as any)?.billId) || 0
      const instId = Number(ev.installment_id ?? (ev.payload as any)?.installmentId) || 0
      if (!billId || !instId) { await mark(ev.id, 0, 'sem billId/installmentId'); naoCasaram++; continue }

      let res: { matched: number; note: string; transient?: boolean; deferred?: boolean }
      try {
        // Sem orçamento as pernas OFFLINE ainda rodam (não consomem cota);
        // só a ida à API fica para o próximo dia (deferred, sem gastar tentativa).
        res = await applyReceipt(admin, billId, instId, { allowApi: orcamentoRestante > 0 })
      } catch (e) {
        if (e instanceof SiengeRateLimited) {
          // Cota estourada: aborta o lote inteiro (insistir só queima o resto do
          // dia para a 2ª via do cliente e para o bot).
          rateLimited = true
          console.warn('reconcile-baixas: 429 do Sienge — abortando o lote')
          break
        }
        throw e
      }
      // Só desconta do orçamento quando realmente foi à API (o filtro de
      // relevância resolve offline e não consome cota).
      if (res.deferred) { ignorados++; continue }   // volta quando houver orçamento
      if (res.note.includes('[api]')) orcamentoRestante--
      const tentativas = (Number((ev as any).attempts) || 0) + 1
      if (res.transient && tentativas < MAX_ATTEMPTS) {
        // Falha que pode se resolver sozinha (cota/queda): NÃO grava
        // reconciled_at — o evento volta no próximo dia com orçamento.
        await admin.from('sienge_webhook_events')
          .update({ note: res.note, attempts: tentativas, last_attempt_at: new Date().toISOString() })
          .eq('id', ev.id)
      } else {
        await mark(ev.id, res.matched, res.note, tentativas)
      }
      if (res.matched > 0) recuperados++; else naoCasaram++
      results.push({ billId, instId, matched: res.matched, note: res.note })
      await SLEEP(DELAY_MS)
    }

    return json({
      ok: true, processados: (events || []).length, recuperados, naoCasaram,
      adiadosPorOrcamento: ignorados, orcamentoRestante, rateLimited, results,
    })
  } catch (e) {
    console.error('reconcile-baixas error:', e)
    return json({ error: String(e) }, 500)
  }
})

async function mark(id: string, matched: number, note: string, attempts = 1) {
  const now = new Date().toISOString()
  await admin.from('sienge_webhook_events')
    .update({ matched, note, attempts, reconciled_at: now, last_attempt_at: now })
    .eq('id', id)
}
function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } })
}
