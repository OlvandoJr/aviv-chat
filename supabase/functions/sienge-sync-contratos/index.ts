/**
 * sienge-sync-contratos — Edge Function (cron DIÁRIO)
 *
 * Sincroniza os CONTRATOS DE VENDA do Sienge (GET /sales-contracts, paginado) para
 * public.sienge_contratos — traz empreendimento + unidade (quadra/lote) + vínculo
 * cliente/título. Os webhooks sales_contract_* complementam em tempo real.
 *
 * DISTRATO: o Sienge NÃO envia webhook quando um contrato é distratado (caso
 * Elielton, 07/2026 — a régua continuou cobrando). Por isso este sync roda
 * DIARIAMENTE e, após gravar, PROPAGA: contratos com situação "Cancelado"
 * têm as parcelas (sienge_boletos) e boletos (boletos_emitidos) do título
 * cancelados — a régua para de cobrar em até 24h.
 *
 * Invocação: cron sem body. Manual: { dryRun?: boolean } → não grava, retorna amostra.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { SIENGE_BASE, siengeAuth, mapContrato, cancelBills, isContratoCancelado } from '../_shared/sienge.ts'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

const PAGE = 200
const MAX_PAGES = 100

Deno.serve(async (req) => {
  try {
    const body = await req.json().catch(() => ({}))
    const dryRun = !!body?.dryRun

    const rows: any[] = []
    const sample: any[] = []
    let totalApi = 0

    for (let page = 0; page < MAX_PAGES; page++) {
      const resp = await fetch(
        `${SIENGE_BASE}/sales-contracts?limit=${PAGE}&offset=${page * PAGE}`,
        { headers: { Authorization: siengeAuth() } },
      )
      if (!resp.ok) return json({ ok: false, error: `Sienge /sales-contracts HTTP ${resp.status}`, page }, 502)
      const data = await resp.json()
      const results: any[] = data.results || []
      totalApi = data.resultSetMetadata?.count ?? totalApi

      for (const c of results) {
        if (c?.id == null) continue
        const row = mapContrato(c)
        rows.push(row)
        if (sample.length < 3) sample.push(row)
      }
      if (results.length < PAGE) break
    }

    if (dryRun) return json({ ok: true, dryRun: true, total_api: totalApi, mapeados: rows.length, amostra: sample })

    let upserted = 0
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500)
      const { error, count } = await supabase
        .from('sienge_contratos')
        .upsert(chunk, { onConflict: 'contract_id', count: 'exact' })
      if (error) return json({ ok: false, error: error.message, upserted }, 500)
      upserted += count ?? chunk.length
    }

    // ── Propagar DISTRATO: contratos cancelados → cancelar cobranças do título ──
    const canceladosBills = rows
      .filter((r) => isContratoCancelado(r.situation))
      .map((r) => Number(r.receivable_bill_id))
      .filter((n) => n > 0)
    const canceladas = await cancelBills(supabase, canceladosBills)

    const semCliente = rows.filter((r) => !r.client_id).length
    const result = {
      ok: true, total_api: totalApi, upserted, sem_cliente: semCliente,
      contratos_cancelados: canceladosBills.length,
      cobrancas_canceladas: canceladas,
    }
    console.log('sienge-sync-contratos:', JSON.stringify(result))
    return json(result)
  } catch (e) {
    console.error('sienge-sync-contratos fatal:', e)
    return json({ ok: false, error: String(e) }, 500)
  }
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
