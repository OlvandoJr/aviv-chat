// deno test supabase/functions/_shared/comprovante.test.ts
//
// Fixtures = os 4 casos REAIS de agosto/2026, com os campos que a leitura correta
// produz (conferidos nos documentos originais) e os boletos que cada cliente
// tinha na base naquele momento. Cada caso tem de cair na regra certa.
import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { casarBoleto, decidir, type Extracao, type BoletoCandidato } from './comprovante.ts'

const ex = (o: Partial<Extracao>): Extracao => ({
  tipo: 'comprovante', valor: null, vencimento: null, data_pagamento: null,
  pagador: null, pagador_doc: null, beneficiario: null, beneficiario_doc: null,
  autenticacao: null, confianca: 'alta', ...o,
})
const bol = (o: Partial<BoletoCandidato> & Pick<BoletoCandidato, 'vencimento' | 'valor'>): BoletoCandidato => ({
  fonte: 'emitido', id: `${o.vencimento}|${o.valor}`, status: 'aberto',
  beneficiario_doc: null, descricao: null, ...o,
})

// ── ANDRÉIA (17/08) ──────────────────────────────────────────────────────────
// Base: 20/07 R$591,47 PAGA (Sienge), 20/08 R$603,49 aberta. CNPJ Pôr do Sol 57.214.290/0001-93.
const ANDREIA_BOLETOS = [
  bol({ vencimento: '2026-07-20', valor: 591.47, status: 'pago',   beneficiario_doc: '57214290000193' }),
  bol({ vencimento: '2026-08-20', valor: 603.49, status: 'aberto', beneficiario_doc: '57214290000193' }),
]
const ANDREIA_ABERTOS = ANDREIA_BOLETOS.filter((b) => b.status === 'aberto')

Deno.test('Andréia · print do AGENDAMENTO → regra 6, sem baixa, sem humano', () => {
  const e = ex({ tipo: 'agendamento', valor: 591.47, vencimento: '2026-07-20', data_pagamento: '2026-07-20',
                 beneficiario_doc: '57214290000193' })
  const d = decidir(e, casarBoleto(e, ANDREIA_BOLETOS), ANDREIA_ABERTOS)
  assertEquals(d.regra, 6); assertEquals(d.baixa, false); assertEquals(d.humano, false)
  assert(d.mensagem.includes('20/07/2026'), 'cita a data do débito')
})

Deno.test('Andréia · comprovante de JULHO (já pago) → regra 3, aponta a cobrança de AGOSTO, NÃO toca agosto', () => {
  const e = ex({ valor: 591.47, vencimento: '2026-07-20', data_pagamento: '2026-07-20',
                 beneficiario_doc: '57214290000193', autenticacao: '0000186' })
  const c = casarBoleto(e, ANDREIA_BOLETOS)
  assertEquals(c.tipo, 'ja_pago')
  if (c.tipo === 'ja_pago') assertEquals(c.boleto.vencimento, '2026-07-20')   // casou com JULHO, não com agosto
  const d = decidir(e, c, ANDREIA_ABERTOS)
  assertEquals(d.regra, 3); assertEquals(d.baixa, false); assertEquals(d.humano, false)
  assert(d.mensagem.includes('20/07/2026') && d.mensagem.includes('já consta paga'))
  assert(d.mensagem.includes('20/08/2026') && d.mensagem.includes('603,49'), 'diz qual é a cobrança atual')
})

// ── GEOVANA (05/08) ──────────────────────────────────────────────────────────
// Comprovante Caixa: R$724,08, venc. 10/08/2026, pago 03/08. Boleto 10/08 R$724,08 aberto.
Deno.test('Geovana · comprovante legítimo, valor exato → regra 1, baixa', () => {
  const e = ex({ valor: 724.08, vencimento: '2026-08-10', data_pagamento: '2026-08-03',
                 pagador_doc: '13618013957', autenticacao: '69358905756' })
  const boletos = [bol({ vencimento: '2026-08-10', valor: 724.08 })]
  const d = decidir(e, casarBoleto(e, boletos), boletos)
  assertEquals(d.regra, 1); assertEquals(d.baixa, true); assertEquals(d.humano, false)
})

// ── DIRCEU (05/08) ───────────────────────────────────────────────────────────
// Lotérica: R$599,26, venc. 20/08/2026, pago 05/08. Boleto 20/08 R$599,26 aberto.
Deno.test('Dirceu · leitura correta (rotação) → regra 1', () => {
  const e = ex({ valor: 599.26, vencimento: '2026-08-20', data_pagamento: '2026-08-05', pagador_doc: '89606671968' })
  const boletos = [bol({ vencimento: '2026-08-20', valor: 599.26 })]
  assertEquals(decidir(e, casarBoleto(e, boletos), boletos).regra, 1)
})

Deno.test('Dirceu · leitura ERRADA por R$1 (598,26) → ainda casa pelo vencimento, regra 2 (humano), sem baixa', () => {
  const e = ex({ valor: 598.26, vencimento: '2026-08-20', data_pagamento: '2026-08-05' })
  const boletos = [bol({ vencimento: '2026-08-20', valor: 599.26 })]
  const c = casarBoleto(e, boletos)
  assertEquals(c.tipo, 'aberto')          // vencimento (4) + valor próximo (1) = 5 ≥ 4
  const d = decidir(e, c, boletos)
  assertEquals(d.regra, 2); assertEquals(d.baixa, false); assertEquals(d.humano, true)
  assert(d.mensagem.includes('598,26') && d.mensagem.includes('599,26'), 'mostra os dois valores')
})

// ── Regras de borda ──────────────────────────────────────────────────────────
Deno.test('boleto (cobrança) → regra 7', () => {
  const d = decidir(ex({ tipo: 'boleto', valor: 603.49, vencimento: '2026-08-20' }), { tipo: 'nenhum' })
  assertEquals(d.regra, 7); assertEquals(d.baixa, false)
})

Deno.test('outro/ilegível → regra 8, humano', () => {
  assertEquals(decidir(ex({ tipo: 'outro' }), { tipo: 'nenhum' }).regra, 8)
  assertEquals(decidir(ex({ tipo: 'ilegivel' }), { tipo: 'nenhum' }).humano, true)
})

Deno.test('comprovante com confiança BAIXA → regra 9, humano, sem afirmar boleto', () => {
  const e = ex({ valor: 724.08, vencimento: '2026-08-10', confianca: 'baixa' })
  const boletos = [bol({ vencimento: '2026-08-10', valor: 724.08 })]
  const d = decidir(e, casarBoleto(e, boletos), boletos)
  assertEquals(d.regra, 9); assertEquals(d.baixa, false); assertEquals(d.humano, true)
  assert(!d.mensagem.includes('10/08'), 'não cita o boleto — a leitura não é confiável')
})

Deno.test('só valor bate (sem vencimento, sem CNPJ) → score 3 < 4 → nenhum → regra 5', () => {
  const e = ex({ valor: 603.49 })
  const c = casarBoleto(e, ANDREIA_BOLETOS)
  assertEquals(c.tipo, 'nenhum')
  assertEquals(decidir(e, c, ANDREIA_ABERTOS).regra, 5)
})

Deno.test('valor + CNPJ batem (sem vencimento) → score 5 → aceita', () => {
  const e = ex({ valor: 603.49, beneficiario_doc: '57214290000193' })
  assertEquals(casarBoleto(e, ANDREIA_BOLETOS).tipo, 'aberto')
})

Deno.test('dois boletos no MESMO vencimento e valor → ambíguo → regra 4', () => {
  const e = ex({ valor: 500, vencimento: '2026-09-10' })
  const boletos = [
    bol({ id: 'a', vencimento: '2026-09-10', valor: 500 }),
    bol({ id: 'b', vencimento: '2026-09-10', valor: 500 }),
  ]
  const c = casarBoleto(e, boletos)
  assertEquals(c.tipo, 'ambiguo')
  assertEquals(decidir(e, c, boletos).regra, 4)
})

Deno.test('vencimento decide contra valor: comprovante 20/07 casa com 20/07 mesmo tendo 20/08 com valor "próximo"', () => {
  // o erro exato do caso Andréia: antes escolhia pelo valor mais próximo entre os ABERTOS
  const e = ex({ valor: 591.47, vencimento: '2026-07-20' })
  const c = casarBoleto(e, ANDREIA_BOLETOS)
  assert(c.tipo === 'ja_pago' && c.boleto.vencimento === '2026-07-20')
})

Deno.test('baixa SÓ na regra 1', () => {
  const regrasComBaixa = new Set<number>()
  const cenarios: [Extracao, BoletoCandidato[]][] = [
    [ex({ tipo: 'agendamento', data_pagamento: '2026-07-20' }), ANDREIA_BOLETOS],
    [ex({ tipo: 'boleto' }), ANDREIA_BOLETOS],
    [ex({ tipo: 'outro' }), ANDREIA_BOLETOS],
    [ex({ valor: 591.47, vencimento: '2026-07-20' }), ANDREIA_BOLETOS],          // ja_pago
    [ex({ valor: 603.49, vencimento: '2026-08-20' }), ANDREIA_BOLETOS],          // aberto exato → 1
    [ex({ valor: 600.00, vencimento: '2026-08-20' }), ANDREIA_BOLETOS],          // aberto diferente → 2
    [ex({ valor: 1 }), ANDREIA_BOLETOS],                                          // nenhum
    [ex({ valor: 603.49, vencimento: '2026-08-20', confianca: 'baixa' }), ANDREIA_BOLETOS],
  ]
  for (const [e, bs] of cenarios) {
    const d = decidir(e, casarBoleto(e, bs), bs.filter((b) => b.status === 'aberto'))
    if (d.baixa) regrasComBaixa.add(d.regra)
  }
  assertEquals([...regrasComBaixa], [1])
})
