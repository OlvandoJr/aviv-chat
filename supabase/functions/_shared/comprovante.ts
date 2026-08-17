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
  receivable_bill_id?: number | null
  installment_id?:     number | null
}

// ── CASAR ────────────────────────────────────────────────────────────────────
export type Casamento =
  | { tipo: 'aberto';  boleto: BoletoCandidato; score: number }
  | { tipo: 'ja_pago'; boleto: BoletoCandidato; score: number }
  | { tipo: 'ambiguo'; candidatos: BoletoCandidato[]; score: number }
  | { tipo: 'nenhum' }

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
