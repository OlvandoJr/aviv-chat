import { NextRequest, NextResponse }            from 'next/server'
import { createServerClient }                   from '@supabase/ssr'
import { createClient as createAdminClient }    from '@supabase/supabase-js'
import { cookies }                              from 'next/headers'
import JSZip                                     from 'jszip'
// Subpath direto evita o bloco de debug do index.js do pdf-parse (que tenta ler um PDF de teste).
// @ts-expect-error — sem types para o subpath
import pdfParse from 'pdf-parse/lib/pdf-parse.js'

export const runtime     = 'nodejs'
export const maxDuration = 300

// ─────────────────────────────────────────────────────────────────────────────
// Importador de boletos (substitui o Drive + n8n "Importar Boletos do Drive").
// Recebe o ZIP do lote semanal de 2ª via, descompacta, extrai os campos de cada
// PDF (MESMA lib pdf-parse + MESMOS regexes do n8n), sobe o PDF no Storage e faz
// upsert idempotente em boletos_emitidos (onConflict client_id,vencimento).
// ─────────────────────────────────────────────────────────────────────────────

async function getCaller(): Promise<{ id: string; role: string | null } | null> {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll()   { return cookieStore.getAll() },
        setAll(cs) { cs.forEach(({ name, value, options }) => cookieStore.set(name, value, options)) },
      },
    }
  )
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: att } = await supabase.from('chat_attendants').select('role').eq('id', user.id).maybeSingle()
  return { id: user.id, role: att?.role ?? null }
}

const admin = createAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// ── Helpers (portados de supabase/functions/import-boletos/index.ts) ──────────
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

function toNumber(v: unknown): number | null {
  if (v == null || v === '') return null
  if (typeof v === 'number') return v
  const s = String(v).replace(/[^\d.,]/g, '')
  const norm = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s
  const n = parseFloat(norm)
  return isNaN(n) ? null : n
}

function cleanWaId(tel: unknown): string | null {
  let d = String(tel ?? '').replace(/\D/g, '')
  if (!d) return null
  if (d.startsWith('55') && d[2] === '0') d = '55' + d.slice(3)
  return d.length >= 12 ? d : (d.length >= 10 ? '55' + d : d)
}

// ── Parser do PDF — MESMOS regexes do node "Parsear boletos" do n8n ───────────
// (linha digitável: CAIXA "104-0..." primeiro — paridade com o n8n; fallback genérico
//  de 47 dígitos para boletos avulsos de outros layouts/bancos)
function parseBoletoText(text: string) {
  const ld   = (text.match(/104-0[\d.\-\s]+\d/) || [])[0]
    || (text.match(/\d{5}[.\s]?\d{5}\s?\d{5}[.\s]?\d{6}\s?\d{5}[.\s]?\d{6}\s?\d\s?\d{14}/) || [])[0]
    || null
  const venc = (text.match(/Vencimento\s*([0-3]?\d\/[01]?\d\/\d{4})/) || [])[1] || null
  const val  = (text.match(/Valor do Documento\s*([\d.]+,\d{2})/) || [])[1] || null
  const nn   = (text.match(/Nosso N[uú]mero\s*([\d/\-]+)/) || [])[1] || null
  return { linhaDigitavel: ld, vencimento: venc, valor: val, nossoNumero: nn }
}

// Normaliza nome p/ casar com o cadastro (sem acentos, caixa baixa, espaços únicos)
function normName(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

interface Falha { arquivo: string; motivo: string }

export async function POST(req: NextRequest) {
  const caller = await getCaller()
  if (!caller) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  // Carregar boletos é operação do dia a dia — liberado para qualquer atendente logado.

  // ── Receber o ZIP ──────────────────────────────────────────────────────────
  const form = await req.formData()
  const file = form.get('file') as File | null
  if (!file) return NextResponse.json({ error: 'Envie o arquivo ZIP no campo "file".' }, { status: 400 })

  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(Buffer.from(await file.arrayBuffer()))
  } catch {
    return NextResponse.json({ error: 'Arquivo inválido — não é um ZIP legível.' }, { status: 400 })
  }

  // PDFs do ZIP (ignora diretórios e não-PDF)
  const entries = Object.values(zip.files).filter(
    (f) => !f.dir && /\.pdf$/i.test(f.name)
  )
  if (entries.length === 0) {
    return NextResponse.json({ error: 'Nenhum PDF encontrado no ZIP.' }, { status: 400 })
  }

  // ── Extrair + parsear cada PDF ───────────────────────────────────────────────
  type Parsed = {
    clientId: number; nome: string; lote: string
    vencimento: string | null; valor: string | null
    linhaDigitavel: string | null; nossoNumero: string | null
    pdfBuf: Buffer; baseName: string
  }
  const parsed: Parsed[] = []
  const falhas: Falha[]  = []

  for (const entry of entries) {
    const baseName = entry.name.split('/').pop() || entry.name      // tira pasta
    const noExt    = baseName.replace(/\.pdf$/i, '')

    // Formato A (lote CAIXA/n8n): "{clientId} - {nome} - {lote}.pdf"
    // Formato B (avulso):         "{nome}_{título}_{parcela}_{ddmmaaaa}.pdf" → cliente por NOME
    let clientId = NaN
    let nome = ''
    let lote = ''
    let vencFallback: string | null = null

    const partsA = noExt.split(' - ')
    const idA    = Number((partsA[0] || '').trim())
    const mB     = noExt.match(/^(.+?)_(\d+)_(\d+)_(\d{8})$/)

    if (!isNaN(idA)) {
      clientId = idA
      nome     = (partsA[1] || '').trim()
      lote     = (partsA[2] || '').trim()
    } else if (mB) {
      nome = mB[1].trim()
      lote = mB[2]                                    // nº do título como referência
      vencFallback = `${mB[4].slice(0, 2)}/${mB[4].slice(2, 4)}/${mB[4].slice(4)}`  // ddmmaaaa
    } else {
      falhas.push({ arquivo: baseName, motivo: 'nome do arquivo fora dos formatos aceitos ("id - nome - lote" ou "nome_titulo_parcela_data")' })
      continue
    }

    let text = ''
    try {
      const pdfBuf = Buffer.from(await entry.async('nodebuffer'))
      text = (await pdfParse(pdfBuf)).text || ''
      const f = parseBoletoText(text)
      if (!f.vencimento && vencFallback) f.vencimento = vencFallback
      if (!f.vencimento) {
        falhas.push({ arquivo: baseName, motivo: 'vencimento não encontrado no PDF' })
        continue
      }
      if (!f.linhaDigitavel) {
        falhas.push({ arquivo: baseName, motivo: 'linha digitável não encontrada no PDF' })
        continue
      }
      parsed.push({ clientId, nome, lote, ...f, pdfBuf, baseName })
    } catch (err) {
      falhas.push({ arquivo: baseName, motivo: 'falha ao ler o PDF: ' + String(err) })
    }
  }

  // ── Formato B: resolver o cliente pelo NOME no cadastro (sienge_clientes) ────
  if (parsed.some((p) => isNaN(p.clientId))) {
    const { data: clientes } = await admin.from('sienge_clientes').select('client_id, nome')
    const byName = new Map<string, number[]>()
    for (const c of clientes || []) {
      const k = normName(c.nome || '')
      if (k) byName.set(k, [...(byName.get(k) || []), c.client_id])
    }
    for (const p of parsed) {
      if (!isNaN(p.clientId)) continue
      const ids = byName.get(normName(p.nome)) || []
      if (ids.length === 1) {
        p.clientId = ids[0]
      } else {
        falhas.push({
          arquivo: p.baseName,
          motivo: ids.length === 0
            ? `cliente "${p.nome}" não encontrado no cadastro Sienge`
            : `nome "${p.nome}" ambíguo no cadastro (${ids.length} clientes)`,
        })
      }
    }
    // descarta os que não resolveram
    for (let i = parsed.length - 1; i >= 0; i--) if (isNaN(parsed[i].clientId)) parsed.splice(i, 1)
  }

  // ── Telefone por client_id (sienge_clientes) ─────────────────────────────────
  const ids = [...new Set(parsed.map((p) => p.clientId))]
  const telById: Record<number, { tel: string | null; nome: string | null }> = {}
  if (ids.length) {
    const { data: clientes } = await admin
      .from('sienge_clientes')
      .select('client_id, telefone, nome')
      .in('client_id', ids)
    for (const c of clientes || []) telById[c.client_id] = { tel: cleanWaId(c.telefone), nome: c.nome }
  }

  // ── Upload dos PDFs + montar as linhas ───────────────────────────────────────
  const rows: any[] = []
  let comPdf = 0
  for (const p of parsed) {
    const venc = toISODate(p.vencimento)!     // garantido acima
    const info = telById[p.clientId] || { tel: null, nome: null }

    // Sobe o PDF (idempotente por client_id/vencimento)
    let pdfPath: string | null = `${p.clientId}/${venc}.pdf`
    const { error: upErr } = await admin.storage
      .from('boletos')
      .upload(pdfPath, p.pdfBuf, { contentType: 'application/pdf', upsert: true })
    if (upErr) {
      falhas.push({ arquivo: p.baseName, motivo: 'falha ao subir o PDF: ' + upErr.message })
      pdfPath = null
    } else {
      comPdf++
    }

    rows.push({
      client_id:       p.clientId,
      customer_name:   p.nome || info.nome || null,
      vencimento:      venc,
      valor:           toNumber(p.valor),
      linha_digitavel: (p.linhaDigitavel || '').replace(/\s+/g, ' ').trim() || null,
      nosso_numero:    p.nossoNumero || null,
      telefone:        info.tel,
      lote:            p.lote || null,
      pdf_path:        pdfPath,
      status:          'aberto',
      updated_at:      new Date().toISOString(),
    })
  }

  const semTelefone = rows.filter((r) => !r.telefone).length
  const valorTotal  = rows.reduce((s, r) => s + (Number(r.valor) || 0), 0)
  const loteRemessa = rows.find((r) => r.lote)?.lote || null

  // ── Registra o LOTE (carregamento) e carimba upload_id em cada boleto ────────
  let loteId: string | null = null
  if (rows.length) {
    const { data: me } = await admin.from('chat_attendants').select('name').eq('id', caller.id).maybeSingle()
    const { data: lote } = await admin.from('boleto_lotes').insert({
      uploaded_by:      caller.id,
      uploaded_by_name: me?.name || null,
      filename:         file.name || null,
      lote:             loteRemessa,
      recebidos:        entries.length,
      gravados:         rows.length,
      com_pdf:          comPdf,
      sem_telefone:     semTelefone,
      falhas:           falhas.length,
      valor_total:      valorTotal,
    }).select('id').single()
    loteId = lote?.id || null
    if (loteId) for (const r of rows) r.upload_id = loteId
  }

  // ── Upsert em boletos_emitidos ───────────────────────────────────────────────
  let gravados = 0
  if (rows.length) {
    const { error, count } = await admin
      .from('boletos_emitidos')
      .upsert(rows, { onConflict: 'client_id,vencimento', count: 'exact' })
    if (error) return NextResponse.json({ error: error.message, falhas }, { status: 500 })
    gravados = count ?? rows.length
  }

  return NextResponse.json({
    ok: true,
    lote_id:     loteId,
    recebidos:   entries.length,
    gravados,
    com_pdf:     comPdf,
    sem_telefone: semTelefone,
    falhas,
  })
}
