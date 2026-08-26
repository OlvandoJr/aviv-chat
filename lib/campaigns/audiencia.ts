import { resolveVariables } from '@/lib/whatsapp/vars'

/**
 * Resolução da audiência de campanha — fonte ÚNICA.
 *
 * Estava inteira dentro de /api/campaigns/[id]/audience. Ao surgir o "Adicionar
 * contatos" (que resolve a mesma audiência mas só INSERE o que falta), duplicar
 * este código significaria duplicar a trava de distrato, a deduplicação por
 * telefone e o mapa de PDF do boleto — e a primeira a sair de sincronia seria a
 * trava, deixando um distratado entrar pelo caminho novo.
 */

export interface FiltroAudiencia {
  source?: string; dueFrom?: string; dueTo?: string
  origem?: string; empreendimento?: string; contrato?: string
  nome?: string; telefone?: string
}

export interface EntradaAudiencia {
  mode: 'view' | 'manual'
  base?: 'boletos' | 'clientes'
  filter?: FiltroAudiencia
  rows?: Record<string, unknown>[]
}

export interface DestinatarioResolvido {
  campaign_id: string
  wa_id: string
  name: string | null
  variables: unknown
  boleto_pdf_path: string | null
  status: 'pending'
}

/** DDD + 8 dígitos (espelha normalize_phone do banco). */
export function normFone(v: unknown): string {
  let d = String(v ?? '').replace(/\D/g, '')
  if (!d) return ''
  if (d.startsWith('55') && d.length >= 12) d = d.slice(2)
  if (d.startsWith('0')) d = d.slice(1)
  if (d.length >= 11 && d[2] === '9') d = d.slice(0, 2) + d.slice(3)
  return d.slice(-10)
}

/** Trecho de telefone digitado no filtro → dígitos comparáveis com phone_norm. */
function trechoTelefone(v: string): string {
  const d = String(v || '').replace(/\D/g, '')
  if (!d) return ''
  return d.length >= 10 ? normFone(d) : d
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function resolverAudiencia(
  admin: any,
  camp: { id: string; variable_mapping: unknown; incluir_distratados?: boolean },
  entrada: EntradaAudiencia,
): Promise<{ recipients: DestinatarioResolvido[]; removidosDistrato: number } | { erro: string }> {
  const { mode = 'view', base = 'boletos', filter = {}, rows = [] } = entrada
  let sourceRows: Record<string, any>[] = []

  if (mode === 'view' && base === 'clientes') {
    let q = admin.from('vw_central_clientes')
      .select('phone_norm, telefone, nome, cpf, email, origem, empreendimento, contrato_situacao')
    if (filter.origem && filter.origem !== 'todos') q = q.eq('origem', filter.origem)
    if (filter.empreendimento) q = q.ilike('empreendimento', `%${filter.empreendimento}%`)
    if (filter.contrato)       q = q.ilike('contrato_situacao', `%${filter.contrato}%`)
    if (filter.nome)           q = q.ilike('nome', `%${filter.nome}%`)
    const tel = trechoTelefone(filter.telefone || '')
    if (tel)                   q = q.ilike('phone_norm', `%${tel}%`)
    const { data, error } = await q.limit(5000)
    if (error) return { erro: error.message }
    sourceRows = (data || []).map((r: any) => ({
      wa_id: r.telefone || (r.phone_norm ? '55' + r.phone_norm : ''),
      name: r.nome, phone_norm: r.phone_norm,
      customer_name: r.nome, empreendimento: r.empreendimento, cpf: r.cpf, email: r.email,
    }))
  } else if (mode === 'view') {
    let q = admin.from('vw_clientes_boletos')
      .select('phone_norm, source, customer_name, customer_phone, empreendimento, quadra, lote, parcela, due_date, amount, link_boleto')
    if (filter.source && filter.source !== 'both') q = q.eq('source', filter.source)
    if (filter.dueFrom)        q = q.gte('due_date', filter.dueFrom)
    if (filter.dueTo)          q = q.lte('due_date', filter.dueTo)
    if (filter.empreendimento) q = q.ilike('empreendimento', `%${filter.empreendimento}%`)
    if (filter.nome)           q = q.ilike('customer_name', `%${filter.nome}%`)
    const tel = trechoTelefone(filter.telefone || '')
    if (tel)                   q = q.ilike('phone_norm', `%${tel}%`)
    const { data, error } = await q.limit(5000)
    if (error) return { erro: error.message }
    sourceRows = (data || []).map((r: any) => ({ ...r, wa_id: r.customer_phone, name: r.customer_name }))
  } else if (mode === 'manual') {
    sourceRows = (rows || []).map((r: any) => ({ ...r, wa_id: r.wa_id, name: r.name }))
  } else {
    return { erro: 'mode inválido' }
  }

  // Mapa pdf_path por (phone_norm|venc) — campanha manda 1 mensagem por telefone;
  // com 2 boletos no MESMO vencimento a escolha é determinística: maior valor
  // (empate → mais recente).
  const pdfByKey = new Map<string, { path: string; valor: number; created: string }>()
  const phonesAud = [...new Set(sourceRows.map(r => r.phone_norm).filter(Boolean))]
  for (let i = 0; i < phonesAud.length; i += 200) {
    const chunk = phonesAud.slice(i, i + 200)
    const { data: bes } = await admin.from('boletos_emitidos')
      .select('phone_norm, vencimento, pdf_path, valor, created_at').in('phone_norm', chunk)
    for (const b of bes || []) {
      if (!b.pdf_path) continue
      const k = `${b.phone_norm}|${String(b.vencimento).slice(0, 10)}`
      const atual = pdfByKey.get(k)
      const cand = { path: b.pdf_path, valor: Number(b.valor) || 0, created: String(b.created_at || '') }
      if (!atual || cand.valor > atual.valor || (cand.valor === atual.valor && cand.created > atual.created)) {
        pdfByKey.set(k, cand)
      }
    }
  }

  // DISTRATO: quem não tem NENHUM contrato ativo sai da audiência. Vale para os
  // três modos — inclusive planilha, que é por onde um distratado entraria sem
  // ninguém perceber.
  let removidosDistrato = 0
  if (!camp.incluir_distratados) {
    const fonesAud = [...new Set(sourceRows.map(r => normFone(r.phone_norm || r.wa_id)).filter(Boolean))]
    const distratados = await buscarDistratados(admin, fonesAud)
    if (distratados.size) {
      const antes = sourceRows.length
      sourceRows = sourceRows.filter(r => !distratados.has(normFone(r.phone_norm || r.wa_id)))
      removidosDistrato = antes - sourceRows.length
    }
  }

  const seen = new Set<string>()
  const recipients: DestinatarioResolvido[] = sourceRows
    .filter(r => r.wa_id && String(r.wa_id).replace(/\D/g, '').length >= 10)
    .filter(r => { const k = String(r.wa_id).replace(/\D/g, ''); if (seen.has(k)) return false; seen.add(k); return true })
    .map(r => ({
      campaign_id: camp.id,
      wa_id:       String(r.wa_id).replace(/\D/g, ''),
      name:        r.name || null,
      variables:   resolveVariables(camp.variable_mapping as any, r),
      boleto_pdf_path: pdfByKey.get(`${r.phone_norm}|${String(r.due_date || '').slice(0, 10)}`)?.path || null,
      status:      'pending' as const,
    }))

  return { recipients, removidosDistrato }
}

/**
 * Telefone → clientes → nenhum contrato ativo. Mesmo critério das views de
 * cobrança (migrations 068/069) e da régua do SGL. Um telefone pode apontar para
 * MAIS DE UM cliente (casal, cadastro duplicado): só bloqueia quando NENHUM deles
 * tem contrato ativo — colapsar em um cliente só bloquearia quem está em dia.
 */
export async function buscarDistratados(admin: any, fones: string[]): Promise<Set<string>> {
  const bloqueados = new Set<string>()
  if (!fones.length) return bloqueados
  const foneClientes = new Map<string, Set<number>>()

  for (let i = 0; i < fones.length; i += 200) {
    const chunk = fones.slice(i, i + 200)
    const [{ data: clis }, { data: emitidos }] = await Promise.all([
      admin.from('sienge_clientes').select('client_id, phone_norm').in('phone_norm', chunk),
      admin.from('boletos_emitidos').select('client_id, phone_norm').in('phone_norm', chunk).not('client_id', 'is', null),
    ])
    for (const c of [...(clis || []), ...(emitidos || [])]) {
      if (!c.phone_norm || c.client_id == null) continue
      if (!foneClientes.has(c.phone_norm)) foneClientes.set(c.phone_norm, new Set())
      foneClientes.get(c.phone_norm)!.add(Number(c.client_id))
    }
  }

  const clientIds = [...new Set([...foneClientes.values()].flatMap(s => [...s]))]
  if (!clientIds.length) return bloqueados

  const temContrato = new Set<number>()
  const temAtivo    = new Set<number>()
  for (let i = 0; i < clientIds.length; i += 200) {
    const { data: contratos } = await admin.from('sienge_contratos')
      .select('client_id, situation').in('client_id', clientIds.slice(i, i + 200))
    for (const ct of contratos || []) {
      const cid = Number(ct.client_id)
      temContrato.add(cid)
      if (!/cancel|distrat/i.test(String(ct.situation || ''))) temAtivo.add(cid)
    }
  }

  for (const [fone, cids] of foneClientes) {
    const algumContrato = [...cids].some(c => temContrato.has(c))
    const algumAtivo    = [...cids].some(c => temAtivo.has(c))
    if (algumContrato && !algumAtivo) bloqueados.add(fone)
  }
  return bloqueados
}
