/**
 * Leitura de planilha de audiência (CSV/colar/XLSX → { headers, rows }).
 * Vivia dentro do CampaignWizard; extraído para o diálogo "Adicionar contatos"
 * usar o MESMO parser — dois parsers divergindo é convite a audiência errada.
 */

/** CSV/colar: detecção de separador (; , tab) e aspas. */
export function parseDelimited(text: string): { headers: string[]; rows: Record<string, string>[] } | null {
  const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim() !== '')
  if (lines.length < 2) return null
  const cand: Array<'\t' | ';' | ','> = ['\t', ';', ',']
  const delim = cand.sort((a, b) => lines[0].split(b).length - lines[0].split(a).length)[0]
  const split = (line: string): string[] => {
    const out: string[] = []; let cur = ''; let inQ = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++ } else inQ = !inQ }
      else if (ch === delim && !inQ) { out.push(cur); cur = '' }
      else cur += ch
    }
    out.push(cur); return out.map(s => s.trim())
  }
  return fromMatrix(lines.map(split))
}

/** Matriz (1ª linha = cabeçalhos) → { headers, rows } com cabeçalhos deduplicados. */
export function fromMatrix(matrix: string[][]): { headers: string[]; rows: Record<string, string>[] } | null {
  if (!matrix || matrix.length < 2) return null
  const seen = new Map<string, number>()
  const headers = matrix[0].map((h, i) => {
    const base = String(h || '').trim() || `coluna_${i + 1}`
    const n = seen.get(base) || 0; seen.set(base, n + 1)
    return n ? `${base}_${n + 1}` : base
  })
  const rows = matrix.slice(1)
    .map(cells => { const o: Record<string, string> = {}; headers.forEach((h, i) => o[h] = String(cells[i] ?? '').trim()); return o })
    .filter(o => Object.values(o).some(v => v !== ''))
  return rows.length ? { headers, rows } : null
}

/** Autodetecta as colunas de telefone e nome pelos cabeçalhos. */
export function detectarColunas(headers: string[]): { telefone: string; nome: string } {
  return {
    telefone: headers.find(h => /tele|fone|celular|whats|phone|contato/i.test(h)) || '',
    nome:     headers.find(h => /nome|name|cliente/i.test(h)) || '',
  }
}

/** Lê um File (.xlsx/.xls ou texto) para { headers, rows }. */
export async function lerArquivoPlanilha(f: File): Promise<{ headers: string[]; rows: Record<string, string>[] } | null> {
  if (/\.(xlsx|xls)$/i.test(f.name)) {
    const XLSX = await import('xlsx')
    const wb = XLSX.read(await f.arrayBuffer())
    const ws = wb.Sheets[wb.SheetNames[0]]
    const matrix: string[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' }) as string[][]
    return fromMatrix(matrix)
  }
  return parseDelimited(await f.text())
}
