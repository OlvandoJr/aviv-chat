/**
 * Tradução das falhas de envio/entrega do WhatsApp para linguagem de atendente.
 *
 * O texto gravado em `chat_campaign_recipients.error` tem três origens:
 *  • JSON cru da Graph API quando a CHAMADA falha (dispatch-campaign);
 *  • "[código] Título — detalhe" quando a Meta reporta falha de ENTREGA depois,
 *    pelo webhook de status (mensagem aceita no envio, mas não entregue);
 *  • mensagens nossas ("falha ao criar conversa", ...).
 *
 * `retentavel` responde à pergunta que o atendente realmente faz: adianta
 * reenviar? Número sem WhatsApp não adianta; limite da Meta, sim.
 */

export interface FalhaDescrita {
  titulo:      string
  explicacao:  string
  retentavel:  boolean
  codigo?:     number
  bruto?:      string
}

const CATALOGO: Record<number, Omit<FalhaDescrita, 'bruto' | 'codigo'>> = {
  131026: { titulo: 'Número não recebe WhatsApp', retentavel: false,
    explicacao: 'O número não tem conta no WhatsApp, está inativo ou não pode receber mensagens. Reenviar não resolve — confirme o número com o cliente.' },
  131047: { titulo: 'Janela de 24 horas fechada', retentavel: true,
    explicacao: 'A Meta recusou por estar fora da janela de conversa. Com template aprovado, reenviar costuma funcionar.' },
  131049: { titulo: 'Entrega limitada pela Meta', retentavel: true,
    explicacao: 'A Meta limitou mensagens de marketing para este usuário hoje, para preservar a experiência dele. Reenviar mais tarde pode funcionar.' },
  130472: { titulo: 'Usuário em experimento da Meta', retentavel: true,
    explicacao: 'Este número faz parte de um experimento da Meta que restringe mensagens de marketing. Reenviar mais tarde pode funcionar.' },
  131008: { titulo: 'Faltou o valor de uma variável', retentavel: false,
    explicacao: 'Algum {{n}} do template ficou sem valor para este contato. Corrija a planilha ou o mapeamento de variáveis antes de reenviar.' },
  131000: { titulo: 'Erro temporário da Meta', retentavel: true,
    explicacao: 'Falha interna do WhatsApp no momento do envio. Reenviar costuma resolver.' },
  131056: { titulo: 'Muitas tentativas para este número', retentavel: true,
    explicacao: 'A Meta limitou o par remetente/destinatário por excesso de tentativas. Aguarde e reenvie.' },
  132000: { titulo: 'Variáveis não batem com o template', retentavel: false,
    explicacao: 'O número de variáveis enviadas é diferente do que o template espera. Sincronize o template e refaça o mapeamento.' },
  132001: { titulo: 'Template não encontrado', retentavel: false,
    explicacao: 'O template não existe, não está aprovado ou está em outro idioma. Sincronize os templates com a Meta.' },
  132005: { titulo: 'Texto acima do limite', retentavel: false,
    explicacao: 'O conteúdo com as variáveis passou do tamanho permitido pela Meta.' },
  132007: { titulo: 'Conteúdo reprovado pela política', retentavel: false,
    explicacao: 'A Meta bloqueou o conteúdo por violar a política de mensagens.' },
  132012: { titulo: 'Formato de variável inválido', retentavel: false,
    explicacao: 'Alguma variável tem formato não aceito (quebra de linha, tabulação ou espaços seguidos).' },
  132015: { titulo: 'Template pausado pela Meta', retentavel: true,
    explicacao: 'A Meta pausou este template por qualidade baixa. Aguarde a liberação para reenviar.' },
  133010: { titulo: 'Número remetente não registrado', retentavel: false,
    explicacao: 'A caixa de entrada não está registrada na Cloud API. É configuração da conta, não do cliente.' },
  368:    { titulo: 'Conta temporariamente bloqueada', retentavel: true,
    explicacao: 'A Meta bloqueou temporariamente os envios desta conta por violação de política.' },
  80007:  { titulo: 'Limite de envios atingido', retentavel: true,
    explicacao: 'A conta atingiu o limite de mensagens da Meta. Reenviar depois costuma funcionar.' },
  100:    { titulo: 'Parâmetro inválido no envio', retentavel: false,
    explicacao: 'A Meta recusou o formato da requisição. Confira o template e o mapeamento das variáveis.' },
}

// Mensagens geradas por nós no dispatch (não vêm da Meta).
const NOSSAS: { casa: RegExp; d: Omit<FalhaDescrita, 'bruto' | 'codigo'> }[] = [
  { casa: /falha ao criar conversa/i, d: { titulo: 'Não foi possível abrir a conversa', retentavel: true,
      explicacao: 'Erro ao criar a conversa antes do envio — normalmente temporário. Reenviar costuma resolver.' } },
  { casa: /sem boleto com PDF/i, d: { titulo: 'Cliente sem boleto com PDF', retentavel: false,
      explicacao: 'A campanha anexa o boleto de cada cliente e este não tem PDF disponível. Carregue o boleto antes de reenviar.' } },
  { casa: /signed URL do boleto/i, d: { titulo: 'Falha ao preparar o PDF do boleto', retentavel: true,
      explicacao: 'Não foi possível gerar o link temporário do boleto. Reenviar costuma resolver.' } },
]

export function descreverFalha(error: string | null | undefined): FalhaDescrita {
  const bruto = (error || '').trim()

  if (!bruto) {
    return {
      titulo: 'Falha na entrega',
      explicacao: 'O envio foi aceito pela Meta, mas a mensagem não chegou e o motivo não ficou registrado. '
        + 'A causa mais comum é número sem WhatsApp. Reenviar é seguro e mostra o motivo se falhar de novo.',
      retentavel: true,
    }
  }

  // 1) JSON cru da Graph API
  let codigo: number | undefined
  let detalhe = ''
  try {
    const j = JSON.parse(bruto)
    const e = j?.error ?? j
    if (e?.code != null) codigo = Number(e.code)
    detalhe = e?.error_data?.details || e?.message || ''
  } catch {
    // 2) formato "[131026] Título — detalhe" (webhook de status)
    const m = bruto.match(/^\[(\d+)\]\s*(.*)$/)
    if (m) { codigo = Number(m[1]); detalhe = m[2] }
  }

  if (codigo != null && CATALOGO[codigo]) {
    return { ...CATALOGO[codigo], codigo, bruto }
  }

  for (const n of NOSSAS) if (n.casa.test(bruto)) return { ...n.d, bruto }

  return {
    titulo: codigo ? `Erro ${codigo} do WhatsApp` : 'Falha no envio',
    explicacao: detalhe || bruto.slice(0, 200),
    retentavel: true,
    codigo,
    bruto,
  }
}
