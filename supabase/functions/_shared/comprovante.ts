/**
 * comprovante.ts — validação de comprovante em três etapas: LER → CASAR → DECIDIR
 *
 * Só a etapa LER usa modelo (fica em process-media). Este módulo é 100% código:
 * recebe a extração já pronta e devolve o que gravar e o que dizer ao cliente.
 *
 * Por que existe (docs/PLANO-validacao-comprovantes.md): quatro casos em duas
 * semanas mostraram que o pipeline antigo casava o comprovante com "algum
 * boleto do telefone" ignorando o vencimento e excluindo boletos pagos, marcava
 * a baixa ANTES do veredito, e deixava o bot interpretar um veredito em texto
 * livre. Caso Andréia (17/08): comprovante da parcela de JULHO (já paga) casou
 * com o boleto de AGOSTO, saiu "valor divergente" e agosto sumiu da régua.
 *
 * Aqui não há chute: se o casamento não atinge o mínimo, é "nenhum" e vai para
 * humano. Baixa só na regra 1.
 */

// ── LER: contrato de saída do extrator (o modelo devolve FATOS, não julgamento) ─
export type TipoDoc = 'comprovante' | 'agendamento' | 'boleto' | 'outro' | 'ilegivel'

export interface Extracao {
  tipo:             TipoDoc
  valor:            number | null    // valor PAGO (ou do documento)
  vencimento:       string | null    // AAAA-MM-DD — "Data de Vencimento" impressa
  data_pagamento:   string | null    // AAAA-MM-DD — débito/efetivação (agendamento: data do débito)
  pagador:          string | null
  pagador_doc:      string | null    // CPF/CNPJ do pagador, só dígitos
  beneficiario:     string | null
  beneficiario_doc: string | null    // CNPJ do beneficiário, só dígitos
  autenticacao:     string | null    // protocolo / autenticação / E2E
  linha_digitavel:  string | null    // dígitos da linha digitável/código de barras impressos
  confianca:        'alta' | 'media' | 'baixa'
  bruto?:           Record<string, unknown>
}

// ── Boleto candidato (unificado a partir de emitidos / sienge / sgl) ───────────
export interface BoletoCandidato {
  fonte:            'emitido' | 'sienge' | 'sgl'
  id:               string | null    // boletos_emitidos.id ou sienge_boletos.id
  vencimento:       string           // AAAA-MM-DD
  valor:            number
  status:           string           // 'aberto' | 'pago' | 'comprovante_recebido' | ...
  beneficiario_doc: string | null    // CNPJ do empreendimento, só dígitos (se soubermos)
  descricao:        string | null
  linha_digitavel?: string | null
  receivable_bill_id?: number | null
  installment_id?:     number | null
}

// ── CASAR ────────────────────────────────────────────────────────────────────
export type Casamento =
  | { tipo: 'aberto';  boleto: BoletoCandidato; score: number }
  | { tipo: 'ja_pago'; boleto: BoletoCandidato; score: number }
  | { tipo: 'ambiguo'; candidatos: BoletoCandidato[]; score: number }
  | { tipo: 'nenhum' }

// ── LINHA DIGITÁVEL: a âncora determinística ─────────────────────────────────
// Todo boleto e todo comprovante de boleto imprimem a linha digitável (47
// dígitos). Ela é AUTOVALIDÁVEL (DV módulo 10 por campo) e CODIFICA o valor
// (últimos 10 dígitos, em centavos) e o vencimento (fator FEBRABAN). Provado
// nos casos reais: José Vitor → 628,20/23-08 exatos; Andréia → 603,49/20-08;
// uma linha com UM dígito errado REPROVA no DV em vez de sair errada em
// silêncio — exatamente o oposto do LLM, que erra dígito com confiança.
export interface LinhaDecodificada {
  valida: boolean
  linha?: string          // os 47 dígitos normalizados
  banco?: string
  valor?: number
  vencimento?: string     // AAAA-MM-DD (null se fator ausente)
}

// Dois formatos impressos nos documentos:
//   • LINHA DIGITÁVEL (47 díg.) — boletos e lotérica; DV módulo 10 por campo.
//   • CÓDIGO DE BARRAS (44 díg.) — "Representação numérica do código de barras"
//     dos comprovantes de internet banking (Caixa/Bradesco); DV geral módulo 11.
// A base guarda a linha com prefixo ("104-0 " + linha) — o sufixo de 47 é a
// linha; os DVs garantem que só o recorte certo valida.
export function normalizarLinha(s: unknown): string {
  const d = String(s ?? '').replace(/\D/g, '')
  if (d.length === 44 || d.length === 47) return d
  return d.length > 47 ? d.slice(-47) : d
}

function mod10(s: string): number {
  let soma = 0, peso = 2
  for (let i = s.length - 1; i >= 0; i--) {
    let p = Number(s[i]) * peso
    if (p > 9) p = Math.floor(p / 10) + (p % 10)
    soma += p
    peso = peso === 2 ? 1 : 2
  }
  return (10 - (soma % 10)) % 10
}

function mod11Barra(d43: string): number {
  let soma = 0, peso = 2
  for (let i = d43.length - 1; i >= 0; i--) {
    soma += Number(d43[i]) * peso
    peso = peso === 9 ? 2 : peso + 1
  }
  const dv = 11 - (soma % 11)
  return (dv === 0 || dv === 10 || dv === 11) ? 1 : dv
}

const fatorParaVenc = (fator: number): string | undefined =>
  fator >= 1000
    ? new Date(Date.UTC(2025, 1, 22) + (fator - 1000) * 864e5).toISOString().slice(0, 10)
    : undefined   // base nova FEBRABAN: 22/02/2025 = 1000 (reset oficial)

// Código de barras 44 → linha digitável 47 (rearranjo FEBRABAN + DVs mod10).
// Normalizamos tudo para a LINHA porque é o formato guardado na base.
function barra44ParaLinha47(b: string): string {
  const c1 = b.slice(0, 4) + b.slice(19, 24)
  const c2 = b.slice(24, 34)
  const c3 = b.slice(34, 44)
  return c1 + mod10(c1) + c2 + mod10(c2) + c3 + mod10(c3) + b[4] + b.slice(5, 19)
}

// O modelo derruba UM dígito ao copiar 47 dígitos sem separadores (observado
// nos PDFs Caixa: devolve 46). Reparo determinístico: testa todas as inserções
// possíveis (47 posições × 10 dígitos) e aceita SOMENTE se exatamente UMA
// candidata valida nos DVs E o valor decodificado bate com o valor lido pelo
// modelo (checagem cruzada independente — o valor vem de outro campo do
// documento). Ambíguo ou sem confirmação de valor → descarta, sem adivinhar.
export function repararLinha(s: unknown, valorLido: number | null | undefined): LinhaDecodificada {
  const d = String(s ?? '').replace(/\D/g, '')
  if (d.length !== 46 && d.length !== 43) return { valida: false }
  if (valorLido == null) return { valida: false }   // sem valor independente não há checagem cruzada
  // O filtro de VALOR entra antes da unicidade: o módulo 10 sozinho deixa
  // passar ~1 candidata espúria a cada duas tentativas, mas a espúria quase
  // sempre altera o campo de valor — e valor errado é eliminado aqui.
  const unicas = new Set<string>()
  for (let pos = 0; pos <= d.length; pos++) {
    for (let dig = 0; dig <= 9; dig++) {
      const cand = d.slice(0, pos) + String(dig) + d.slice(pos)
      const dec = decodificarLinha(cand)
      if (dec.valida && dec.linha && dec.valor != null && Math.abs(dec.valor - valorLido) < 0.001) {
        unicas.add(dec.linha)
      }
    }
  }
  if (unicas.size !== 1) return { valida: false }   // ambíguo → não adivinha
  return decodificarLinha([...unicas][0])
}

export function decodificarLinha(s: unknown): LinhaDecodificada {
  const d = normalizarLinha(s)

  if (d.length === 44) {
    if (mod11Barra(d.slice(0, 4) + d.slice(5)) !== Number(d[4])) return { valida: false }
    return {
      valida: true, linha: barra44ParaLinha47(d), banco: d.slice(0, 3),
      valor: Number(d.slice(9, 19)) / 100, vencimento: fatorParaVenc(Number(d.slice(5, 9))),
    }
  }

  if (d.length !== 47) return { valida: false }
  for (const campo of [d.slice(0, 10), d.slice(10, 21), d.slice(21, 32)]) {
    if (mod10(campo.slice(0, -1)) !== Number(campo.slice(-1))) return { valida: false }
  }
  // DV GERAL (módulo 11, posição 32): os DVs de campo protegem só as posições
  // 0-31 — sem esta checagem, o rabo (fator+valor) fica desprotegido e o
  // reparo de dígito acha dezenas de candidatas "válidas" ali.
  const barra = d.slice(0, 4) + d[32] + d.slice(33, 47) + d.slice(4, 9) + d.slice(10, 20) + d.slice(21, 31)
  if (mod11Barra(barra.slice(0, 4) + barra.slice(5)) !== Number(barra[4])) return { valida: false }
  return {
    valida: true, linha: d, banco: d.slice(0, 3),
    valor: Number(d.slice(37)) / 100, vencimento: fatorParaVenc(Number(d.slice(33, 37))),
  }
}

const PAGO = new Set(['pago', 'baixado', 'comprovante_confirmado'])
export const ehPago = (b: BoletoCandidato) => PAGO.has(String(b.status || '').toLowerCase())

const soDigitos = (v: unknown) => String(v ?? '').replace(/\D/g, '')

/**
 * Pontua cada boleto do cliente e escolhe. Pesos:
 *   vencimento igual ............ 4  (chave mais forte: todo comprovante de boleto imprime)
 *   valor igual (±0,01) ......... 3
 *   CNPJ do beneficiário igual .. 2  (evita casar com boleto de outro credor)
 *   valor próximo (±5%) ......... 1  (juros/multa; só desempate)
 * Aceita com score >= 4 (vencimento, OU valor+CNPJ). Abaixo disso: 'nenhum'.
 * Empate no topo com score alto: 'ambiguo' — o sistema NÃO escolhe por nós.
 */
export function casarBoleto(ex: Extracao, candidatos: BoletoCandidato[]): Casamento {
  if (!candidatos.length) return { tipo: 'nenhum' }

  // ── Âncora: linha digitável VÁLIDA ───────────────────────────────────────
  // 1. Se a linha do comprovante casa exatamente com a de um boleto nosso, é
  //    AQUELE boleto — fim (score 10, acima de qualquer combinação).
  // 2. Mesmo sem casar a linha (boleto de fora/legado), o valor e o vencimento
  //    DECODIFICADOS substituem os lidos pelo modelo — o DV garante que estão
  //    certos, e mata a classe "leu 528 em vez de 628".
  let dec = decodificarLinha(ex.linha_digitavel)
  if (!dec.valida) dec = repararLinha(ex.linha_digitavel, ex.valor)
  if (dec.valida) {
    const alvo = candidatos.find((b) => normalizarLinha(b.linha_digitavel) === dec.linha)
    if (alvo) {
      return ehPago(alvo)
        ? { tipo: 'ja_pago', boleto: alvo, score: 10 }
        : { tipo: 'aberto',  boleto: alvo, score: 10 }
    }
    ex = { ...ex, valor: dec.valor ?? ex.valor, vencimento: dec.vencimento ?? ex.vencimento }
  }

  const pontuar = (b: BoletoCandidato): number => {
    let s = 0
    if (ex.vencimento && b.vencimento && ex.vencimento === b.vencimento) s += 4
    if (ex.valor != null && ex.valor > 0 && b.valor > 0) {
      const diff = Math.abs(ex.valor - b.valor)
      if (diff <= 0.01) s += 3
      else if (diff / b.valor <= 0.05) s += 1
    }
    const exDoc = soDigitos(ex.beneficiario_doc)
    const bDoc  = soDigitos(b.beneficiario_doc)
    if (exDoc.length >= 11 && bDoc.length >= 11 && exDoc === bDoc) s += 2
    return s
  }

  const ranking = candidatos
    .map((b) => ({ b, score: pontuar(b) }))
    .sort((x, y) => y.score - x.score || x.b.vencimento.localeCompare(y.b.vencimento))

  const top = ranking[0]
  if (top.score < 4) return { tipo: 'nenhum' }

  const empatados = ranking.filter((r) => r.score === top.score)
  if (empatados.length > 1) {
    // Empate real só se forem boletos DIFERENTES (id ou vencimento distintos).
    const distintos = new Set(empatados.map((r) => r.b.id ?? `${r.b.fonte}|${r.b.vencimento}|${r.b.valor}`))
    if (distintos.size > 1) return { tipo: 'ambiguo', candidatos: empatados.map((r) => r.b), score: top.score }
  }

  return ehPago(top.b)
    ? { tipo: 'ja_pago', boleto: top.b, score: top.score }
    : { tipo: 'aberto',  boleto: top.b, score: top.score }
}

// ── DECIDIR ──────────────────────────────────────────────────────────────────
export interface Decisao {
  regra:    1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
  baixa:    boolean                 // marcar comprovante_recebido no boleto casado
  humano:   boolean                 // receipt_validation na conversa
  mensagem: string                  // texto pronto para o cliente
  boleto?:  BoletoCandidato         // o boleto que a decisão se refere (se houver)
}

const brl  = (n: number | null | undefined) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(n) || 0)
const dBR  = (iso: string | null | undefined) => {
  const s = String(iso || '').slice(0, 10)
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (s || 'data não informada')
}

/**
 * Tabela de regras. Cada linha: o que grava, se chama humano, e a mensagem
 * PRONTA — o bot entrega o texto (não interpreta um veredito).
 *
 * `abertos` = boletos em aberto do cliente, para a regra 3 poder dizer QUAL é a
 * cobrança atual ("a cobrança é da parcela de 20/08").
 */
export function decidir(ex: Extracao, cas: Casamento, abertos: BoletoCandidato[] = []): Decisao {
  // 6 · agendamento: reconhece, não dá baixa, pede o definitivo
  if (ex.tipo === 'agendamento') {
    const quando = ex.data_pagamento ? ` para ${dBR(ex.data_pagamento)}` : ''
    return {
      regra: 6, baixa: false, humano: false,
      mensagem: `Vi que você agendou o pagamento${quando}. A baixa acontece quando o banco efetivar o débito nessa data — depois disso, se puder me enviar o comprovante definitivo, eu confirmo por aqui.`,
    }
  }

  // 7 · boleto: é a cobrança
  if (ex.tipo === 'boleto') {
    return {
      regra: 7, baixa: false, humano: false,
      mensagem: 'Esse arquivo é o boleto (a cobrança), não o comprovante de pagamento. Se você já pagou, me envie o comprovante do pagamento efetivado (PIX, transferência ou pagamento realizado).',
    }
  }

  // 8 · não é documento financeiro / ilegível
  if (ex.tipo === 'outro' || ex.tipo === 'ilegivel') {
    return {
      regra: 8, baixa: false, humano: true,
      mensagem: 'Não consegui identificar esse arquivo como comprovante de pagamento. Vou pedir para um atendente dar uma olhada.',
    }
  }

  // daqui para baixo: tipo === 'comprovante'

  // 9 · leitura sem confiança: não afirmamos nada sobre o boleto
  if (ex.confianca === 'baixa') {
    return {
      regra: 9, baixa: false, humano: true,
      mensagem: 'Recebi o comprovante. Não consegui ler todos os dados com segurança, então vou pedir para um atendente conferir.',
    }
  }

  // 3 · casou com boleto JÁ PAGO (caso Andréia)
  if (cas.tipo === 'ja_pago') {
    const atual = abertos.length === 1 ? abertos[0] : null
    const cobranca = atual
      ? ` A cobrança que enviamos é da parcela de ${dBR(atual.vencimento)}, no valor de ${brl(atual.valor)}.`
      : abertos.length > 1
        ? ' A cobrança que enviamos é de outra parcela, que segue em aberto.'
        : ''
    return {
      regra: 3, baixa: false, humano: false, boleto: cas.boleto,
      mensagem: `Esse comprovante é da parcela de ${dBR(cas.boleto.vencimento)}, que já consta paga no sistema.${cobranca}`,
    }
  }

  // 4 · ambíguo
  if (cas.tipo === 'ambiguo') {
    return {
      regra: 4, baixa: false, humano: true,
      mensagem: 'Recebi o comprovante. Você tem mais de um boleto compatível com ele — vou pedir para um atendente identificar qual parcela foi paga.',
    }
  }

  // 5 · não casou
  if (cas.tipo === 'nenhum') {
    return {
      regra: 5, baixa: false, humano: true,
      mensagem: 'Recebi o comprovante, mas não localizei o boleto correspondente no seu cadastro. Um atendente vai conferir.',
    }
  }

  // aberto: 1 (valor exato) ou 2 (valor diferente)
  const b = cas.boleto
  const pago = ex.valor ?? 0
  if (Math.abs(pago - b.valor) <= 0.01) {
    return {
      regra: 1, baixa: true, humano: false, boleto: b,
      mensagem: `Recebi o comprovante da parcela de ${dBR(b.vencimento)}, no valor de ${brl(pago)}. Ele fica registrado e a baixa é confirmada pelo sistema. Se precisar de algo mais, estou à disposição.`,
    }
  }
  return {
    regra: 2, baixa: false, humano: true, boleto: b,
    mensagem: `Recebi o comprovante da parcela de ${dBR(b.vencimento)}. O valor pago (${brl(pago)}) é diferente do valor do boleto (${brl(b.valor)}) — vou pedir para um atendente conferir.`,
  }
}
