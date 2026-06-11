/**
 * sienge-sync-contratos — Edge Function (cron MENSAL, fallback)
 *
 * Sincroniza os CONTRATOS DE VENDA do Sienge (GET /sales-contracts, paginado) para
 * public.sienge_contratos — traz empreendimento + unidade (quadra/lote) + vínculo
 * cliente/título. A atualização do dia a dia vem dos webhooks sales_contract_*;
 * este sync mensal é só reconciliação.
 *
 * Invocação: cron sem body. Manual: { dryRun?: boolean } → não grava, retorna amostra.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { SIENGE_BASE, siengeAuth, mapContrato } from '../_shared/sienge.ts'

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

    const semCliente = rows.filter((r) => !r.client_id).length
    const result = { ok: true, total_api: totalApi, upserted, sem_cliente: semCliente }
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
