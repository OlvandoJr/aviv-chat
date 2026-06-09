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
function parseBoletoText(text: string) {
  const ld   = (text.match(/104-0[\d.\-\s]+\d/) || [])[0] || null
  const venc = (text.match(/Vencimento\s*([0-3]?\d\/[01]?\d\/\d{4})/) || [])[1] || null
  const val  = (text.match(/Valor do Documento\s*([\d.]+,\d{2})/) || [])[1] || null
  const nn   = (text.match(/Nosso N[uú]mero\s*([\d/\-]+)/) || [])[1] || null
  return { linhaDigitavel: ld, vencimento: venc, valor: val, nossoNumero: nn }
}

interface Falha { arquivo: string; motivo: string }

export async function POST(req: NextRequest) {
  const caller = await getCaller()
  if (!caller) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  if (caller.role !== 'admin' && caller.role !== 'manager') {
    return NextResponse.json({ error: 'Permissão insuficiente' }, { status: 403 })
  }

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
    const parts    = noExt.split(' - ')
    const clientId = Number((parts[0] || '').trim())
    const nome     = (parts[1] || '').trim()
    const lote     = (parts[2] || '').trim()

    if (isNaN(clientId)) {
      falhas.push({ arquivo: baseName, motivo: 'client_id não identificado no nome do arquivo' })
      continue
    }

    let text = ''
    try {
      const pdfBuf = Buffer.from(await entry.async('nodebuffer'))
      text = (await pdfParse(pdfBuf)).text || ''
      const f = parseBoletoText(text)
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

  // ── Upsert em boletos_emitidos ───────────────────────────────────────────────
  let gravados = 0
  if (rows.length) {
    const { error, count } = await admin
      .from('boletos_emitidos')
      .upsert(rows, { onConflict: 'client_id,vencimento', count: 'exact' })
    if (error) return NextResponse.json({ error: error.message, falhas }, { status: 500 })
    gravados = count ?? rows.length
  }

  const semTelefone = rows.filter((r) => !r.telefone).length
  return NextResponse.json({
    ok: true,
    recebidos:   entries.length,
    gravados,
    com_pdf:     comPdf,
    sem_telefone: semTelefone,
    falhas,
  })
}
