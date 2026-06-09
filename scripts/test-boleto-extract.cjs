/* Teste headless da extração de boletos — mesma lib (pdf-parse) e mesmos regexes da rota.
   Compara o resultado com boletos_emitidos (dados que o n8n já gravou). Uso:
     node scripts/test-boleto-extract.cjs "/caminho/lote.zip"
*/
const fs = require('fs')
const path = require('path')
const JSZip = require('jszip')
const pdfParse = require('pdf-parse/lib/pdf-parse.js')
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') })
const { createClient } = require('@supabase/supabase-js')

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

function parseBoletoText(text) {
  const ld   = (text.match(/104-0[\d.\-\s]+\d/) || [])[0] || null
  const venc = (text.match(/Vencimento\s*([0-3]?\d\/[01]?\d\/\d{4})/) || [])[1] || null
  const val  = (text.match(/Valor do Documento\s*([\d.]+,\d{2})/) || [])[1] || null
  const nn   = (text.match(/Nosso N[uú]mero\s*([\d/\-]+)/) || [])[1] || null
  return { linhaDigitavel: ld, vencimento: venc, valor: val, nossoNumero: nn }
}
function toISODate(v) {
  if (!v) return null
  const s = String(v).trim()
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/)
  if (m) { const y = m[3].length === 2 ? '20'+m[3] : m[3]; return `${y}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}` }
  return null
}
function toNumber(v) {
  if (v == null || v === '') return null
  const s = String(v).replace(/[^\d.,]/g, '')
  const norm = s.includes(',') ? s.replace(/\./g,'').replace(',','.') : s
  const n = parseFloat(norm); return isNaN(n) ? null : n
}

;(async () => {
  const zipPath = process.argv[2]
  const zip = await JSZip.loadAsync(fs.readFileSync(zipPath))
  const entries = Object.values(zip.files).filter((f) => !f.dir && /\.pdf$/i.test(f.name))
  console.log(`PDFs no ZIP: ${entries.length}\n`)

  const parsed = []
  const falhas = []
  for (const entry of entries) {
    const baseName = entry.name.split('/').pop() || entry.name
    const noExt = baseName.replace(/\.pdf$/i, '')
    const parts = noExt.split(' - ')
    const clientId = Number((parts[0] || '').trim())
    if (isNaN(clientId)) { falhas.push({ baseName, motivo: 'client_id' }); continue }
    try {
      const buf = await entry.async('nodebuffer')
      const text = (await pdfParse(buf)).text || ''
      const f = parseBoletoText(text)
      if (!f.vencimento) { falhas.push({ baseName, motivo: 'vencimento' }); continue }
      if (!f.linhaDigitavel) { falhas.push({ baseName, motivo: 'linha digitável' }); continue }
      parsed.push({ clientId, vencimento: toISODate(f.vencimento), valor: toNumber(f.valor),
                    linha: f.linhaDigitavel.replace(/\s+/g,' ').trim(), nn: f.nossoNumero })
    } catch (e) { falhas.push({ baseName, motivo: 'erro pdf: ' + e.message }) }
  }

  console.log(`Parseados OK: ${parsed.length} | Falhas: ${falhas.length}`)
  if (falhas.length) console.log('Falhas:', falhas.slice(0, 20))
  console.log('\nAmostra (5):')
  parsed.slice(0, 5).forEach((p) => console.log(`  #${p.clientId} venc=${p.vencimento} valor=${p.valor} nn=${p.nn}\n    ld=${p.linha}`))

  // ── Comparar com boletos_emitidos (n8n) ──
  let bate = 0, difere = 0, ausente = 0
  const diffs = []
  for (const p of parsed) {
    const { data } = await admin.from('boletos_emitidos')
      .select('valor, linha_digitavel, nosso_numero')
      .eq('client_id', p.clientId).eq('vencimento', p.vencimento).maybeSingle()
    if (!data) { ausente++; continue }
    const ldDb = (data.linha_digitavel || '').replace(/\s+/g,' ').trim()
    const same = ldDb === p.linha && Number(data.valor) === Number(p.valor)
    if (same) bate++
    else { difere++; diffs.push({ clientId: p.clientId, venc: p.vencimento,
            db: { valor: data.valor, ld: ldDb }, novo: { valor: p.valor, ld: p.linha } }) }
  }
  console.log(`\n── Comparação com n8n (boletos_emitidos) ──`)
  console.log(`Igual: ${bate} | Diferente: ${difere} | Não estava na base: ${ausente}`)
  if (diffs.length) console.log('Diferenças:', JSON.stringify(diffs.slice(0, 10), null, 2))
})().catch((e) => { console.error(e); process.exit(1) })
