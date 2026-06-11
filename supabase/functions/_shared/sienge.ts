// Helpers de extração do Sienge — compartilhados entre os syncs (clientes/contratos)
// e os webhooks de cadastro. Espelham o shape de GET /customers e GET /sales-contracts.

export const SIENGE_BASE = 'https://api.sienge.com.br/avivconstrutora/public/api/v1'
export const siengeAuth = () =>
  `Basic ${btoa(`${Deno.env.get('SIENGE_USER')}:${Deno.env.get('SIENGE_PASSWORD')}`)}`

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
