/**
 * sienge-sync-clientes — Edge Function (cron diário)
 *
 * Sincroniza o CADASTRO DE CLIENTES direto do Sienge (GET /customers, paginado)
 * para public.sienge_clientes. Substitui o caminho antigo do n8n que derivava os
 * clientes a partir das PARCELAS (receivable-bills) — desnecessário agora que os
 * boletos vêm do carregamento do ZIP (boletos_emitidos) e a baixa vem do webhook.
 *
 * Cota: ~1 requisição por página de 200 clientes (poucas/dia, plano Free ok).
 * Após o upsert, faz backfill do telefone em boletos_emitidos onde estiver nulo.
 *
 * Invocação: cron sem body. Manual: { dryRun?: boolean } → não grava, retorna amostra.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

const SIENGE_BASE = 'https://api.sienge.com.br/avivconstrutora/public/api/v1'
const siengeAuth  = () => `Basic ${btoa(`${Deno.env.get('SIENGE_USER')}:${Deno.env.get('SIENGE_PASSWORD')}`)}`

const PAGE = 200
const MAX_PAGES = 100   // trava de segurança (20k clientes)

// Extrai o melhor telefone do customer (prefere celular), em dígitos com DDI 55.
function bestPhone(c: any): string | null {
  const cands: string[] = []
  if (Array.isArray(c?.phones)) {
    const sorted = [...c.phones].sort((a: any, b: any) => {
      const cel = (p: any) => /cel|mob/i.test(String(p?.type || '')) || p?.main === true ? 0 : 1
      return cel(a) - cel(b)
    })
    for (const p of sorted) {
      const d = `${p?.ddd ?? ''}${p?.number ?? ''}`.replace(/\D/g, '')
      if (d) cands.push(d)
    }
  }
  for (const k of ['mobilePhone', 'cellPhone', 'phone', 'phoneNumber']) {
    const d = String(c?.[k] ?? '').replace(/\D/g, '')
    if (d) cands.push(d)
  }
  for (let d of cands) {
    d = d.replace(/^0+/, '')                                  // "(043)9967..." → remove 0 de tronco
    if (d.startsWith('55') && d[2] === '0') d = '55' + d.slice(3)
    if (d.length === 10 || d.length === 11) d = '55' + d      // DDD+número → prefixa DDI
    if (d.startsWith('55') && d.length >= 12 && d.length <= 13) return d
  }
  return null
}

Deno.serve(async (req) => {
  try {
    const body = await req.json().catch(() => ({}))
    const dryRun = !!body?.dryRun

    const rows: any[] = []
    const sample: any[] = []
    let totalApi = 0

    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * PAGE
      const resp = await fetch(
        `${SIENGE_BASE}/customers?limit=${PAGE}&offset=${offset}&onlyActive=false`,
        { headers: { Authorization: siengeAuth() } },
      )
      if (!resp.ok) {
        return json({ ok: false, error: `Sienge /customers HTTP ${resp.status}`, page }, 502)
      }
      const data = await resp.json()
      const results: any[] = data.results || []
      totalApi = data.resultSetMetadata?.count ?? totalApi

      for (const c of results) {
        if (c?.id == null) continue
        const row = {
          client_id:  Number(c.id),
          nome:       c.name ?? c.tradeName ?? null,
          cpf:        (c.cpf ?? c.cnpj ?? '').replace(/\D/g, '') || null,
          telefone:   bestPhone(c),
          updated_at: new Date().toISOString(),
        }
        rows.push(row)
        if (sample.length < 3) sample.push({ ...row, _raw_phones: c.phones ?? null })
      }

      if (results.length < PAGE) break   // última página
    }

    if (dryRun) {
      return json({ ok: true, dryRun: true, total_api: totalApi, mapeados: rows.length, amostra: sample })
    }

    // Upsert em lotes
    let upserted = 0
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500)
      const { error, count } = await supabase
        .from('sienge_clientes')
        .upsert(chunk, { onConflict: 'client_id', count: 'exact' })
      if (error) return json({ ok: false, error: error.message, upserted }, 500)
      upserted += count ?? chunk.length
    }

    // Backfill: boletos emitidos sem telefone ganham o telefone do cadastro
    const { data: pend } = await supabase
      .from('boletos_emitidos').select('id, client_id').is('telefone', null).limit(1000)
    let backfilled = 0
    for (const b of pend || []) {
      const { data: cli } = await supabase
        .from('sienge_clientes').select('telefone').eq('client_id', b.client_id).maybeSingle()
      if (cli?.telefone) {
        await supabase.from('boletos_emitidos').update({ telefone: cli.telefone }).eq('id', b.id)
        backfilled++
      }
    }

    const semTel = rows.filter((r) => !r.telefone).length
    const result = { ok: true, total_api: totalApi, upserted, sem_telefone: semTel, backfilled }
    console.log('sienge-sync-clientes:', JSON.stringify(result))
    return json(result)
  } catch (e) {
    console.error('sienge-sync-clientes fatal:', e)
    return json({ ok: false, error: String(e) }, 500)
  }
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
