/**
 * Resolução de variáveis de template a partir de um mapeamento + uma linha de dados.
 * Usado por campanhas e régua para preencher {{1}}, {{2}}... com colunas de
 * vw_clientes_boletos (ou valores estáticos).
 */

export type VarSource =
  | { type: 'static'; value: string }
  | { type: 'column'; value: string; format?: 'currency' | 'date' | 'text' }

/** Mapa keyed pelo número da variável: { "1": {...}, "2": {...} } */
export type VariableMapping = Record<string, VarSource>

/** Colunas disponíveis na audiência (vw_clientes_boletos). */
export const AVAILABLE_COLUMNS = [
  'customer_name',
  'empreendimento',
  'quadra',
  'lote',
  'parcela',
  'due_date',
  'amount',
  'link_boleto',
] as const

/** Rótulos amigáveis das colunas (usado nos seletores e no preview). */
export const COLUMN_LABEL: Record<string, string> = {
  customer_name:  'Nome do cliente',
  empreendimento: 'Empreendimento',
  quadra:         'Andar/Quadra',
  lote:           'Unidade/Lote',
  parcela:        'Parcela',
  due_date:       'Vencimento',
  amount:         'Valor',
  link_boleto:    'Link do boleto',
}

export function formatValue(raw: any, format?: string): string {
  if (raw == null) return ''
  if (format === 'currency') {
    const n = typeof raw === 'number' ? raw : parseFloat(String(raw))
    if (isNaN(n)) return ''
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n)
  }
  if (format === 'date') {
    const d = new Date(raw)
    if (isNaN(d.getTime())) return String(raw)
    // datas de boleto são DATE (sem fuso) — formatar em UTC evita -1 dia
    return d.toLocaleDateString('pt-BR', { timeZone: 'UTC' })
  }
  return String(raw)
}

/** Converte o mapeamento + linha em array ordenado de strings (índice = {{n}}). */
export function resolveVariables(
  mapping: VariableMapping | null | undefined,
  row: Record<string, any>,
): string[] {
  if (!mapping) return []
  const nums = Object.keys(mapping)
    .map(Number)
    .filter((n) => !isNaN(n))
    .sort((a, b) => a - b)
  if (nums.length === 0) return []
  // preencher de 1..max para manter a ordem posicional do WhatsApp
  const max = nums[nums.length - 1]
  const out: string[] = []
  for (let i = 1; i <= max; i++) {
    const src = mapping[String(i)]
    if (!src) { out.push(''); continue }
    if (src.type === 'static') { out.push(src.value ?? ''); continue }
    out.push(formatValue(row?.[src.value], src.format))
  }
  return out
}

/** Substitui {{n}} pelo valor (mantém placeholder se vazio) — para preview. */
export function renderPreview(text: string, vars: string[]): string {
  let out = text || ''
  vars.forEach((v, i) => {
    out = out.replace(new RegExp(`\\{\\{${i + 1}\\}\\}`, 'g'), v || `{{${i + 1}}}`)
  })
  return out
}
