// Helpers de extração do Sienge — compartilhados entre os syncs (clientes/contratos)
// e os webhooks de cadastro. Espelham o shape de GET /customers e GET /sales-contracts.

export const SIENGE_BASE = 'https://api.sienge.com.br/avivconstrutora/public/api/v1'
export const siengeAuth = () =>
  `Basic ${btoa(`${Deno.env.get('SIENGE_USER')}:${Deno.env.get('SIENGE_PASSWORD')}`)}`

// 2ª via do boleto/carnê: GET /payment-slip-notification → urlReport (PDF) + digitableNumber.
// Mesma chamada usada pelo bot (ai-responder, siengeSegundaVia). Consome 1 req de cota.
// Devolve também o objeto bruto (`raw`) p/ extrair valor/vencimento quando disponíveis.
export async function fetchSegundaVia(
  billId: number, instId: number,
): Promise<{ url: string; digitavel: string; valor: number | null; raw: any } | null> {
  try {
    const url = `${SIENGE_BASE}/payment-slip-notification?billReceivableId=${billId}&installmentId=${instId}`
    const r = await fetch(url, { headers: { Authorization: siengeAuth(), Accept: 'application/json' } })
    if (!r.ok) {
      console.error('fetchSegundaVia HTTP', r.status, await r.text().catch(() => ''))
      return null
    }
    const j = await r.json()
    const b = (j.results || [])[0] || j || {}
    const valorRaw = b.documentValue ?? b.value ?? b.amount ?? b.totalAmount ?? null
    const valor = valorRaw == null ? null : Number(valorRaw)
    return { url: b.urlReport || '', digitavel: b.digitableNumber || '', valor: Number.isFinite(valor as number) ? valor : null, raw: b }
  } catch (e) {
    console.error('fetchSegundaVia error:', e)
    return null
  }
}

// ── Baixa de boleto (RECEIPT_PROCESSED) — compartilhado webhook + reconciliação ──
// O webhook só traz { billId, installmentId }. Casamos a baixa, em ordem:
//   1) sienge_boletos pela chave exata → propaga aos emitidos (client_id+vencimento)
//   2) boletos_emitidos pela CHAVE DO SIENGE (offline, sem API) — o boleto que enviamos
//   3) fallback: busca o título no Sienge 1x (consome cota) e grava
// Com N boletos por (cliente, vencimento), a propagação precisa ser SELETIVA:
// prefere a chave exata do Sienge (não afeta o boleto "irmão" do mesmo dia);
// o fallback por (cliente, vencimento) só age quando há exatamente 1 aberto.
// deno-lint-ignore no-explicit-any
export async function propagateToEmitidos(admin: any, rows: any[], novoStatus: 'pago' | 'cancelado') {
  const now = new Date().toISOString()
  const patch: Record<string, any> = { status: novoStatus, updated_at: now }
  if (novoStatus === 'pago') patch.paid_at = now
  for (const sb of rows || []) {
    // 1) chave exata (rbid, parcela)
    if (sb?.receivable_bill_id != null && sb?.installment_id != null) {
      const { data } = await admin.from('boletos_emitidos').update(patch)
        .eq('receivable_bill_id', sb.receivable_bill_id).eq('installment_id', sb.installment_id)
        .not('status', 'in', '("pago","cancelado")')
        .select('id')
      if (data?.length) continue
    }
    // 2) fallback (cliente, vencimento) — só sem ambiguidade
    if (!sb?.customer_id || !sb?.due_date) continue
    const { data: abertos } = await admin.from('boletos_emitidos').select('id')
      .eq('client_id', sb.customer_id).eq('vencimento', sb.due_date)
      .not('status', 'in', '("pago","cancelado")').limit(2)
    if ((abertos || []).length === 1) {
      await admin.from('boletos_emitidos').update(patch).eq('id', abertos![0].id)
    } else if ((abertos || []).length > 1) {
      console.warn(`propagateToEmitidos: ${abertos!.length} boletos abertos p/ client ${sb.customer_id} venc ${sb.due_date} — ambíguo, não propaga`)
    }
  }
}

// ── Cancelamento por DISTRATO/cancelamento de contrato ────────────────────────
// Cancela TODAS as cobranças abertas dos títulos informados (parcelas em
// sienge_boletos + boletos em boletos_emitidos) — a régua/views filtram
// 'cancelado' e param de cobrar. Nunca toca em linhas pagas/já canceladas.
// Usado pelo sync de contratos (diário) e pelo webhook sales_contract_*.
// deno-lint-ignore no-explicit-any
export async function cancelBills(admin: any, billIds: number[]): Promise<{ parcelas: number; emitidos: number }> {
  const ids = [...new Set(billIds.map(Number).filter((n) => n > 0))]
  const patch = { status: 'cancelado', updated_at: new Date().toISOString() }
  let parcelas = 0, emitidos = 0
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    const { count: c1 } = await admin.from('sienge_boletos')
      .update(patch, { count: 'exact' })
      .in('receivable_bill_id', chunk)
      .not('status', 'in', '("pago","cancelado")')
    parcelas += c1 || 0
    // boletos_emitidos: status pode ser NULL (= aberto) — NOT IN não pega NULL,
    // então são duas passadas (lembrete: .or() não funciona em UPDATE).
    const { count: c2 } = await admin.from('boletos_emitidos')
      .update(patch, { count: 'exact' })
      .in('receivable_bill_id', chunk)
      .not('status', 'in', '("pago","cancelado")')
    const { count: c2b } = await admin.from('boletos_emitidos')
      .update(patch, { count: 'exact' })
      .in('receivable_bill_id', chunk)
      .is('status', null)
    emitidos += (c2 || 0) + (c2b || 0)
  }
  return { parcelas, emitidos }
}

// Situação de contrato que significa distrato/cancelamento (Sienge: "Cancelado").
export function isContratoCancelado(situation: unknown): boolean {
  return /cancel|distrat/i.test(String(situation || ''))
}

// Fallback (consome cota): título não está na base → busca no Sienge, faz upsert em
// sienge_boletos como pago e devolve {customer_id, due_date} p/ propagar aos emitidos.
// deno-lint-ignore no-explicit-any
export async function syncReceiptFromSienge(admin: any, billId: number, installmentId: number): Promise<any[] | null> {
  try {
    const auth = siengeAuth()
    const bResp = await fetch(`${SIENGE_BASE}/accounts-receivable/receivable-bills/${billId}`, { headers: { Authorization: auth } })
    if (!bResp.ok) return null
    const bill = await bResp.json()
    const b = bill?.results?.[0] || bill || {}
    const customerId = b.customerId ?? b.clientId ?? null
    if (!customerId) return null

    const iResp = await fetch(`${SIENGE_BASE}/accounts-receivable/receivable-bills/${billId}/installments`, { headers: { Authorization: auth } })
    if (!iResp.ok) return null
    const inst = ((await iResp.json()).results || []).find((i: any) => Number(i.installmentId) === installmentId)
    if (!inst?.dueDate) return null

    const amount = inst.originalAmount ?? inst.value ?? inst.grossAmount ?? inst.balanceDue ?? null
    const { data } = await admin.from('sienge_boletos').upsert({
      receivable_bill_id: billId,
      installment_id:     installmentId,
      customer_id:        customerId,
      customer_name:      b.customerName ?? b.name ?? null,
      due_date:           inst.dueDate,
      amount,
      parcela_descricao:  `Parcela ${installmentId}`,
      status:             'pago',
      paid_at:            new Date().toISOString(),
      updated_at:         new Date().toISOString(),
    }, { onConflict: 'receivable_bill_id,installment_id' }).select('id, customer_id, due_date, receivable_bill_id, installment_id')

    // Aprende a chave do Sienge no boleto que enviamos (autocura p/ próximas
    // baixas) — SÓ quando há exatamente 1 candidato sem chave (senão é ambíguo).
    if (data?.[0]?.customer_id && data?.[0]?.due_date) {
      const { data: cands } = await admin.from('boletos_emitidos').select('id')
        .eq('client_id', data[0].customer_id).eq('vencimento', data[0].due_date)
        .is('receivable_bill_id', null).limit(2)
      if ((cands || []).length === 1) {
        await admin.from('boletos_emitidos')
          .update({ receivable_bill_id: billId, installment_id: installmentId })
          .eq('id', cands![0].id)
      }
    }
    return data || []
  } catch (e) {
    console.error('syncReceiptFromSienge error:', e)
    return null
  }
}

// Aplica a baixa de um título/parcela. Retorna quantos registros casaram + nota.
// deno-lint-ignore no-explicit-any
export async function applyReceipt(admin: any, billId: number, installmentId: number): Promise<{ matched: number; note: string }> {
  const now = new Date().toISOString()
  let matched = 0
  const notes: string[] = []

  // 1) sienge_boletos pela chave exata
  const { data: sb } = await admin.from('sienge_boletos')
    .update({ status: 'pago', paid_at: now, updated_at: now })
    .eq('receivable_bill_id', billId).eq('installment_id', installmentId)
    .select('id, customer_id, due_date, receivable_bill_id, installment_id')
  if (sb?.length) { matched += sb.length; notes.push('sienge_boletos'); await propagateToEmitidos(admin, sb, 'pago') }

  // 2) boletos_emitidos pela chave do Sienge (offline, sem API) — o boleto que enviamos
  const { data: be } = await admin.from('boletos_emitidos')
    .update({ status: 'pago', paid_at: now, updated_at: now })
    .eq('receivable_bill_id', billId).eq('installment_id', installmentId)
    .not('status', 'in', '("pago","cancelado")')
    .select('id')
  if (be?.length) { matched += be.length; notes.push('emitidos(chave)') }

  // 3) nada casou offline → fallback Sienge (1x)
  if (matched === 0) {
    const synced = await syncReceiptFromSienge(admin, billId, installmentId)
    if (synced && synced.length) { matched = synced.length; notes.push('sincronizado do Sienge'); await propagateToEmitidos(admin, synced, 'pago') }
    else if (synced === null) notes.push('não casou e fallback Sienge falhou')
    else notes.push('não casou (título não encontrado no Sienge)')
  }
  return { matched, note: notes.join(' + ') }
}

// Telefone do customer → dígitos com DDI 55 (prefere celular; remove 0 de tronco).
export function bestPhone(c: any): string | null {
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
    d = d.replace(/^0+/, '')
    if (d.startsWith('55') && d[2] === '0') d = '55' + d.slice(3)
    if (d.length === 10 || d.length === 11) d = '55' + d
    if (d.startsWith('55') && d.length >= 12 && d.length <= 13) return d
  }
  return null
}

// customer (GET /customers) → linha de sienge_clientes
export function mapCustomer(c: any) {
  return {
    client_id:  Number(c.id),
    nome:       c.name ?? c.tradeName ?? null,
    cpf:        String(c.cpf ?? c.cnpj ?? '').replace(/\D/g, '') || null,
    telefone:   bestPhone(c),
    updated_at: new Date().toISOString(),
  }
}

function mainOf(arr: any): any {
  if (!Array.isArray(arr) || arr.length === 0) return null
  return arr.find((x: any) => x?.main) || arr[0]
}

// sales-contract (GET /sales-contracts) → linha de sienge_contratos
export function mapContrato(c: any) {
  const cust = mainOf(c.salesContractCustomers)
  const unit = mainOf(c.salesContractUnits)
  return {
    contract_id:            Number(c.id),
    client_id:              cust?.id ?? null,
    customer_name:          cust?.name ?? null,
    enterprise_id:          c.enterpriseId ?? null,
    enterprise_name:        c.enterpriseName ?? null,
    company_name:           c.companyName ?? null,
    unidade:                unit?.name ?? null,
    receivable_bill_id:     c.receivableBillId ?? null,
    number:                 c.number ?? null,
    situation:              c.situation ?? null,
    value:                  c.value ?? null,
    total_selling_value:    c.totalSellingValue ?? null,
    contract_date:          c.contractDate ?? null,
    expected_delivery_date: c.expectedDeliveryDate ?? null,
    payment_conditions:     c.paymentConditions ?? null,
    updated_at:             new Date().toISOString(),
  }
}
