/**
 * import-boletos — Edge Function
 *
 * Recebe os boletos extraídos pelo n8n (do PDF de segunda via) e grava em
 * boletos_emitidos. O n8n manda o client_id (do nome do arquivo), vencimento,
 * valor, linha digitável, nosso número e o lote. Aqui casamos client_id →
 * sienge_clientes para pegar o telefone (limpo) e fazemos upsert.
 *
 * Body: { boletos: [{ clientId, nome?, vencimento, valor?, linhaDigitavel?, nossoNumero?, lote? }] }
 *   (também aceita um array direto no topo)
 * Auth: anon key no header (verify_jwt). Uso interno (n8n).
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

// "20/06/2026" ou "2026-06-20" → "2026-06-20"
function toISODate(v: unknown): string | null {
  if (!v) return null
  const s = String(v).trim()
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/)
  if (m) {
    const yyyy = m[3].length === 2 ? '20' + m[3] : m[3]
    return `${yyyy}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  }
  return null
}

// "532,11" | "1.395,46" | 532.11 → number
function toNumber(v: unknown): number | null {
  if (v == null || v === '') return null
  if (typeof v === 'number') return v
  const s = String(v).replace(/[^\d.,]/g, '')
  const norm = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s
  const n = parseFloat(norm)
  return isNaN(n) ? null : n
}

// Telefone → wa_id limpo. Corrige DDD com 0 à esquerda (55 0 44 ... → 55 44 ...)
function cleanWaId(tel: unknown): string | null {
  let d = String(tel ?? '').replace(/\D/g, '')
  if (!d) return null
  if (d.startsWith('55') && d[2] === '0') d = '55' + d.slice(3)
  return d.length >= 12 ? d : (d.length >= 10 ? '55' + d : d)
}

Deno.serve(async (req) => {
  try {
    const body = await req.json().catch(() => ({}))
    const list: any[] = Array.isArray(body) ? body : (body?.boletos || [])
    if (!Array.isArray(list) || list.length === 0) {
      return json({ error: 'esperado { boletos: [...] }' }, 400)
    }

    // cache de telefones por client_id
    const ids = [...new Set(list.map((b) => Number(b.clientId)).filter((n) => !isNaN(n)))]
    const { data: clientes } = await admin
      .from('sienge_clientes')
      .select('client_id, telefone, nome')
      .in('client_id', ids)
    const telById: Record<number, { tel: string | null; nome: string | null }> = {}
    for (const c of clientes || []) telById[c.client_id] = { tel: cleanWaId(c.telefone), nome: c.nome }

    const rows: any[] = []
    const erros: any[] = []
    const vistos = new Set<string>()   // dedupe por (client, venc, ref) dentro do mesmo lote
    for (const b of list) {
      const clientId = Number(b.clientId)
      const venc = toISODate(b.vencimento)
      if (isNaN(clientId) || !venc) { erros.push({ b, motivo: 'clientId/vencimento inválido' }); continue }
      const info = telById[clientId] || { tel: null, nome: null }
      // Identidade do boleto (chave única: client_id, vencimento, boleto_ref)
      const nn = String(b.nossoNumero || '').replace(/\D/g, '')
      const ref = nn ? `n${nn}` : ''
      const chave = `${clientId}|${venc}|${ref}`
      if (vistos.has(chave)) { erros.push({ b, motivo: 'duplicado no lote (mesmo boleto)' }); continue }
      vistos.add(chave)
      rows.push({
        client_id:       clientId,
        customer_name:   b.nome || info.nome || null,
        vencimento:      venc,
        valor:           toNumber(b.valor),
        linha_digitavel: (b.linhaDigitavel || '').toString().replace(/\s+/g, ' ').trim() || null,
        nosso_numero:    b.nossoNumero || null,
        boleto_ref:      ref,
        telefone:        info.tel,
        lote:            b.lote || null,
        status:          'aberto',
        updated_at:      new Date().toISOString(),
      })
    }

    let upserted = 0
    if (rows.length) {
      const { error, count } = await admin
        .from('boletos_emitidos')
        .upsert(rows, { onConflict: 'client_id,vencimento,boleto_ref', count: 'exact' })
      if (error) return json({ error: error.message }, 500)
      upserted = count ?? rows.length
    }

    const semTelefone = rows.filter((r) => !r.telefone).length
    return json({ ok: true, recebidos: list.length, gravados: upserted, sem_telefone: semTelefone, erros: erros.length })
  } catch (err) {
    console.error('import-boletos error:', err)
    return json({ error: String(err) }, 500)
  }
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
