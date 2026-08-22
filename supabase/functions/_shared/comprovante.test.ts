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
  autenticacao: null, linha_digitavel: null, confianca: 'alta', ...o,
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

// ── LINHA DIGITÁVEL (âncora determinística) ──────────────────────────────────
import { decodificarLinha, normalizarLinha, repararLinha } from './comprovante.ts'

// Linhas REAIS dos documentos de agosto (conferidas nos PDFs originais).
const LINHA_JOSE    = '10491.25733 95000.100040 00000.018051 1 15470000062820'  // 628,20 · 23/08/2026
const LINHA_ANDREIA = '10491 24918 94000.100043 00000.001305 7 15440000060349'  // 603,49 · 20/08/2026

Deno.test('linha REAL decodifica valor e vencimento exatos (José Vitor)', () => {
  const d = decodificarLinha(LINHA_JOSE)
  assert(d.valida); assertEquals(d.valor, 628.2); assertEquals(d.vencimento, '2026-08-23')
})

Deno.test('linha REAL decodifica (Andréia agosto)', () => {
  const d = decodificarLinha(LINHA_ANDREIA)
  assert(d.valida); assertEquals(d.valor, 603.49); assertEquals(d.vencimento, '2026-08-20')
})

Deno.test('UM dígito trocado → DV reprova (nunca erra em silêncio)', () => {
  const corrompida = LINHA_JOSE.replace('25733', '25738')
  assertEquals(decodificarLinha(corrompida).valida, false)
})

Deno.test('prefixo da base ("104-0 " + linha) normaliza para os 47 do sufixo', () => {
  const comPrefixo = '104-0 ' + LINHA_JOSE
  assertEquals(normalizarLinha(comPrefixo).length, 47)
  assert(decodificarLinha(comPrefixo).valida)
})

Deno.test('CASO JOSÉ VITOR completo: modelo leu 528,20/23-09, linha corrige e casa exato', () => {
  // a extração ERRADA que aconteceu em produção — mas com a linha copiada certa
  const e = ex({ valor: 528.20, vencimento: '2026-09-23', linha_digitavel: LINHA_JOSE })
  const boletos = [
    bol({ vencimento: '2026-08-23', valor: 628.20, linha_digitavel: '104-0 ' + LINHA_JOSE }),
    bol({ vencimento: '2026-07-23', valor: 624.33, status: 'pago' }),
  ]
  const c = casarBoleto(e, boletos)
  assertEquals(c.tipo, 'aberto')
  if (c.tipo === 'aberto') {
    assertEquals(c.score, 10)                       // casamento pela linha, não por adivinhação
    assertEquals(c.boleto.vencimento, '2026-08-23')
  }
  // e a decisão: o valor DECODIFICADO (628,20) é o que vale → regra 1, baixa
  const d = decidir({ ...e, valor: decodificarLinha(LINHA_JOSE).valor! }, c, boletos)
  assertEquals(d.regra, 1)
})

Deno.test('linha válida sem boleto correspondente: valor/venc decodificados substituem os lidos', () => {
  // modelo leu valor errado; linha não bate com nenhum boleto nosso (legado),
  // mas o vencimento decodificado casa por data com o boleto aberto
  const e = ex({ valor: 528.20, vencimento: '2026-09-23', linha_digitavel: LINHA_ANDREIA })
  const boletos = [bol({ vencimento: '2026-08-20', valor: 603.49 })]
  const c = casarBoleto(e, boletos)
  assertEquals(c.tipo, 'aberto')   // venc decodificado 20/08 (4) + valor decodificado exato (3) = 7
})

Deno.test('linha corrompida é ignorada: cai no casamento tradicional', () => {
  const e = ex({ valor: 603.49, vencimento: '2026-08-20', linha_digitavel: LINHA_JOSE.replace('25733','25738') })
  const boletos = [bol({ vencimento: '2026-08-20', valor: 603.49 })]
  const c = casarBoleto(e, boletos)
  assertEquals(c.tipo, 'aberto')   // pelos campos, como antes
})

Deno.test('código de barras 44 díg. (comprovante internet banking) valida e converte para a linha de 47', () => {
  // derivado da linha REAL do José Vitor: linha47 → barra44 → decodifica igual
  const linha = decodificarLinha(LINHA_JOSE)
  assert(linha.valida && linha.linha)
  // reconstrói a barra a partir da linha (transformação inversa da FEBRABAN)
  const l = linha.linha!
  const barra = l.slice(0, 4) + l.slice(32, 33) + l.slice(33, 47) + l.slice(4, 9) + l.slice(10, 20) + l.slice(21, 31)
  const d = decodificarLinha(barra)
  assert(d.valida, 'barra 44 deve validar no mod11')
  assertEquals(d.valor, 628.2)
  assertEquals(d.vencimento, '2026-08-23')
  assertEquals(d.linha, linha.linha)   // normaliza para a MESMA linha de 47 → casa com a base
})

Deno.test('barra 44 com um dígito trocado reprova no mod11', () => {
  const l = decodificarLinha(LINHA_JOSE).linha!
  const barra = l.slice(0, 4) + l.slice(32, 33) + l.slice(33, 47) + l.slice(4, 9) + l.slice(10, 20) + l.slice(21, 31)
  const ruim = barra.slice(0, 10) + (barra[10] === '9' ? '0' : '9') + barra.slice(11)
  assertEquals(decodificarLinha(ruim).valida, false)
})

Deno.test('reparo é SEGURO: para qualquer dígito derrubado, ou recupera a linha CERTA ou rejeita', () => {
  // Os DVs foram feitos para DETECTAR erro, não para corrigir apagamento — o
  // reparo é oportunista: em muitas posições sobra ambiguidade e ele rejeita
  // (fallback pelos campos lidos segue valendo). O que NUNCA pode acontecer é
  // devolver linha errada. Propriedade varrida nas 47 posições.
  const l = decodificarLinha(LINHA_JOSE).linha!
  let recuperadas = 0
  for (let pos = 0; pos < 47; pos++) {
    const capenga = l.slice(0, pos) + l.slice(pos + 1)
    const r = repararLinha(capenga, 628.20)
    if (r.valida) {
      assertEquals(r.linha, l, `pos ${pos}: reparo devolveu linha ERRADA`)
      recuperadas++
    }
  }
  assert(recuperadas >= 1, 'o reparo deve recuperar ao menos algum caso')
})

Deno.test('reparo NÃO adivinha: sem confirmação de valor, descarta', () => {
  const l = decodificarLinha(LINHA_JOSE).linha!
  const capenga = l.slice(0, 17) + l.slice(18)
  assertEquals(repararLinha(capenga, null).valida, false)          // sem valor lido
  assertEquals(repararLinha(capenga, 999.99).valida, false)        // valor não bate
})
