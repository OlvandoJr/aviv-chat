import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { resolveVariables }          from '@/lib/whatsapp/vars'

const admin = createAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

/**
 * Resolve a audiência da campanha e (re)insere os recipients com as variáveis
 * já calculadas a partir do variable_mapping da campanha.
 *
 * Body:
 *  - { mode: 'view', filter: { source?, dueFrom?, dueTo?, empreendimento? } }
 *  - { mode: 'manual', rows: [{ wa_id, name?, ...colunas }] }
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

    const { id } = await ctx.params
    const { mode = 'view', base = 'boletos', filter = {}, rows = [] } = await req.json()

    const { data: camp } = await admin
      .from('chat_campaigns')
      .select('id, status, variable_mapping, deleted_at, incluir_distratados')
      .eq('id', id)
      .single()
    if (!camp || camp.deleted_at) return NextResponse.json({ error: 'Campanha não encontrada' }, { status: 404 })
    if (!['draft', 'scheduled', 'paused'].includes(camp.status)) {
      return NextResponse.json({ error: 'Só é possível editar audiência em rascunho/agendada/pausada' }, { status: 422 })
    }

    // ── Montar as linhas de origem ────────────────────────────────────────────
    let sourceRows: Record<string, any>[] = []

    if (mode === 'view' && base === 'clientes') {
      // "Selecionar da base — qualquer cliente": TODA a Central (não só boletos em
      // aberto), com filtros de origem/empreendimento/situação do contrato.
      let q = admin.from('vw_central_clientes')
        .select('phone_norm, telefone, nome, cpf, email, origem, empreendimento, contrato_situacao')
      if (filter.origem && filter.origem !== 'todos') q = q.eq('origem', filter.origem)
      if (filter.empreendimento) q = q.ilike('empreendimento', `%${filter.empreendimento}%`)
      if (filter.contrato)       q = q.ilike('contrato_situacao', `%${filter.contrato}%`)
      const { data, error } = await q.limit(5000)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      sourceRows = (data || []).map(r => ({
        wa_id: r.telefone || (r.phone_norm ? '55' + r.phone_norm : ''),
        name: r.nome, phone_norm: r.phone_norm,
        customer_name: r.nome, empreendimento: r.empreendimento, cpf: r.cpf, email: r.email,
      }))
    } else if (mode === 'view') {
      let q = admin.from('vw_clientes_boletos')
        .select('phone_norm, source, customer_name, customer_phone, empreendimento, quadra, lote, parcela, due_date, amount, link_boleto')
      if (filter.source && filter.source !== 'both') q = q.eq('source', filter.source)
      if (filter.dueFrom)       q = q.gte('due_date', filter.dueFrom)
      if (filter.dueTo)         q = q.lte('due_date', filter.dueTo)
      if (filter.empreendimento) q = q.ilike('empreendimento', `%${filter.empreendimento}%`)
      const { data, error } = await q.limit(5000)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      sourceRows = (data || []).map(r => ({ ...r, wa_id: r.customer_phone, name: r.customer_name }))
    } else if (mode === 'manual') {
      sourceRows = (rows || []).map((r: any) => ({ ...r, wa_id: r.wa_id, name: r.name }))
    } else {
      return NextResponse.json({ error: 'mode inválido' }, { status: 400 })
    }

    // Mapa pdf_path por (phone_norm|venc) — usado quando a campanha enviar o boleto
    // de cada cliente (modo 'boleto'). Campanha manda 1 mensagem por telefone; se o
    // cliente tiver 2 boletos no MESMO vencimento, escolha determinística: maior
    // valor (empate → mais recente).
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

    // ── DISTRATO: quem não tem nenhum contrato ativo sai da audiência ─────────
    // Último caminho de envio a ganhar a proteção (régua Sienge, 2ª via do bot e
    // régua SGL já bloqueiam). Vale para os TRÊS modos — inclusive planilha, que
    // é justamente por onde um distratado entraria sem ninguém perceber.
    // Não é cego: `incluir_distratados` permite campanha de reconquista/pesquisa,
    // mas o padrão é o lado seguro.
    let removidosDistrato = 0
    if (!camp.incluir_distratados) {
      const fonesAud = [...new Set(sourceRows.map(r => normFone(r.phone_norm || r.wa_id)).filter(Boolean))]
      const distratados = await buscarDistratados(fonesAud)
      if (distratados.size) {
        const antes = sourceRows.length
        sourceRows = sourceRows.filter(r => !distratados.has(normFone(r.phone_norm || r.wa_id)))
        removidosDistrato = antes - sourceRows.length
      }
    }

    // Filtrar sem telefone e deduplicar por wa_id
    const seen = new Set<string>()
    const recipients = sourceRows
      .filter(r => r.wa_id && String(r.wa_id).replace(/\D/g, '').length >= 10)
      .filter(r => { const k = String(r.wa_id); if (seen.has(k)) return false; seen.add(k); return true })
      .map(r => ({
        campaign_id: id,
        wa_id:       String(r.wa_id).replace(/\D/g, ''),
        name:        r.name || null,
        variables:   resolveVariables(camp.variable_mapping as any, r),
        boleto_pdf_path: pdfByKey.get(`${r.phone_norm}|${String(r.due_date || '').slice(0, 10)}`)?.path || null,
        status:      'pending' as const,
      }))

    // Substituir audiência: limpar pendentes anteriores e reinserir
    await admin.from('chat_campaign_recipients').delete().eq('campaign_id', id)
    if (recipients.length) {
      // inserir em lotes de 500
      for (let i = 0; i < recipients.length; i += 500) {
        const chunk = recipients.slice(i, i + 500)
        const { error } = await admin.from('chat_campaign_recipients')
          .upsert(chunk, { onConflict: 'campaign_id,wa_id', ignoreDuplicates: true })
        if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      }
    }

    await admin.from('chat_campaigns').update({
      total: recipients.length,
      sent: 0,
      failed: 0,
      audience: { mode, base, filter, ...(mode === 'manual' ? { manualCount: recipients.length } : {}) },
      updated_at: new Date().toISOString(),
    }).eq('id', id)

    return NextResponse.json({ ok: true, total: recipients.length, removidosDistrato })
  } catch (err) {
    console.error('[campaigns audience]', err)
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 })
  }
}

// ── Distrato: telefone → clientes → nenhum contrato ativo ────────────────────
// Mesmo critério das views de cobrança (migrations 068/069) e da régua do SGL.
// Um telefone pode apontar para MAIS DE UM cliente (casal, cadastro duplicado):
// só bloqueia quando NENHUM deles tem contrato ativo — colapsar em um cliente só
// bloquearia por engano quem tem contrato vigente.
function normFone(v: unknown): string {
  let d = String(v ?? '').replace(/\D/g, '')
  if (!d) return ''
  if (d.startsWith('55') && d.length >= 12) d = d.slice(2)
  if (d.startsWith('0')) d = d.slice(1)
  if (d.length >= 11 && d[2] === '9') d = d.slice(0, 2) + d.slice(3)
  return d.slice(-10)
}

async function buscarDistratados(fones: string[]): Promise<Set<string>> {
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
