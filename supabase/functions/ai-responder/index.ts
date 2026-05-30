import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const OPENAI_API_KEY     = Deno.env.get('OPENAI_API_KEY')!
const WA_ACCESS_TOKEN    = Deno.env.get('WHATSAPP_ACCESS_TOKEN')!
const WA_PHONE_NUMBER_ID = Deno.env.get('WHATSAPP_PHONE_NUMBER_ID')!

// ── Prompt do sistema ──────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Você é a Avi, assistente virtual de cobrança da Aviv Construtora — uma incorporadora focada em imóveis residenciais.

MISSÃO:
Auxiliar clientes com dúvidas sobre boletos, parcelas, atrasos e comprovantes de pagamento, com agilidade e empatia.

COMPORTAMENTO:
- Seja sempre educada, empática e profissional
- Use linguagem simples e direta em português brasileiro
- Nunca invente valores, datas ou informações — use apenas os dados fornecidos
- Responda de forma concisa (máximo 3 parágrafos curtos)
- Use emojis com moderação para deixar o tom mais amigável

SOBRE BOLETOS E PARCELAS:
- Você tem acesso aos boletos cadastrados do cliente (listados abaixo como DADOS DO CLIENTE)
- Se o cliente perguntar sobre parcela, vencimento ou valor, use os dados fornecidos
- Informe que o pagamento pode ser feito via Pix ou boleto bancário
- Para boletos vencidos, oriente o cliente a entrar em contato para atualização do boleto

SOBRE COMPROVANTES (imagens/documentos):
- Quando o cliente enviar um comprovante, confirme o recebimento: "Recebi seu comprovante! Aguarde enquanto verificamos o pagamento. ✅"
- Se a análise já estiver disponível no contexto:
  * Se STATUS = CONFIRMADO COMO PAGO: comemore e informe que o pagamento foi registrado
  * Se STATUS = PENDENTE DE CONFIRMAÇÃO: informe que está sob análise manual e que retornarão em breve

SOBRE ÁUDIO:
- Se receber transcrição de áudio, responda ao conteúdo da mensagem normalmente

QUANDO TRANSFERIR PARA ATENDENTE HUMANO:
Se alguma destas situações ocorrer, responda APENAS com:
ESCALAR_HUMANO: [motivo]

Situações que exigem escalação:
- Cliente solicita falar com atendente, humano, pessoa, gerente ou responsável
- Dúvida jurídica ou solicitação de acordo/renegociação especial
- Reclamação grave ou ameaça jurídica
- Situação que você não consegue resolver com os dados disponíveis
- Cliente demonstra frustração extrema ou hostilidade

SAUDAÇÃO:
- Na primeira mensagem da conversa, cumprimente o cliente pelo nome (se disponível) e pergunte em que pode ajudar
`

// ── Handler principal ──────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  const { conversationId, messageId } = await req.json()

  if (!conversationId) {
    return new Response('conversationId required', { status: 400 })
  }

  try {
    // 1. Buscar conversa e verificar handled_by
    const { data: conv } = await supabase
      .from('chat_conversations')
      .select('id, handled_by, contact:chat_contacts(id, wa_id, name)')
      .eq('id', conversationId)
      .single()

    if (!conv) {
      return new Response('Conversation not found', { status: 404 })
    }

    // Não responder se humano está atendendo
    if (conv.handled_by === 'human') {
      return new Response(JSON.stringify({ skipped: true, reason: 'human handling' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const contact     = conv.contact as any
    const contactWaId = contact?.wa_id as string

    // 2. Buscar histórico de mensagens (últimas 25)
    const { data: rawMessages } = await supabase
      .from('chat_messages')
      .select('id, direction, type, content, metadata, ai_analysis, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(25)

    const history = (rawMessages || []).reverse()

    // 3. Buscar boletos do cliente no Sienge
    const { data: boletos } = await supabase
      .from('sienge_boletos')
      .select('parcela_descricao, due_date, amount, status')
      .eq('customer_phone', contactWaId)
      .order('due_date', { ascending: true })
      .limit(10)

    // 4. Construir contexto do cliente
    const customerName = contact?.name || 'Cliente'
    let customerContext = `Nome: ${customerName}\nTelefone: +${contactWaId}\n`

    if (boletos && boletos.length > 0) {
      customerContext += '\nBOLETOS CADASTRADOS:\n'
      for (const b of boletos) {
        const dueDate = new Date(b.due_date).toLocaleDateString('pt-BR')
        const amount  = new Intl.NumberFormat('pt-BR', {
          style:    'currency',
          currency: 'BRL',
        }).format(b.amount)
        const statusLabel =
          b.status === 'pago'                  ? '✅ Pago'               :
          b.status === 'comprovante_recebido'   ? '📨 Comprovante recebido':
          b.status === 'vencido'                ? '⚠️ Vencido'            :
          b.status === 'cancelado'              ? '❌ Cancelado'           :
                                                  '🔵 Em aberto'
        customerContext += `- ${b.parcela_descricao || 'Parcela'}: ${amount} | Vencimento: ${dueDate} | ${statusLabel}\n`
      }
    } else {
      customerContext += '\nNenhum boleto encontrado no sistema para este número.\n'
    }

    // 5. Montar mensagens para OpenAI
    const openAiMessages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
      {
        role:    'system',
        content: SYSTEM_PROMPT + '\n\n--- DADOS DO CLIENTE ---\n' + customerContext,
      },
    ]

    // Converter histórico para formato OpenAI
    for (const msg of history) {
      const role = msg.direction === 'in' ? 'user' : 'assistant'
      let content = ''

      if (msg.type === 'audio' && (msg.metadata as any)?.transcription) {
        content = `[Áudio transcrito]: ${(msg.metadata as any).transcription}`
      } else if (
        (msg.type === 'image' || msg.type === 'document') &&
        (msg.ai_analysis as any)
      ) {
        const analysis = msg.ai_analysis as any
        if (analysis.sienge_status) {
          const statusText =
            analysis.sienge_status === 'pago'
              ? 'CONFIRMADO COMO PAGO'
              : 'PENDENTE DE CONFIRMAÇÃO'
          content =
            `[Cliente enviou comprovante de pagamento]\n` +
            `Análise extraída: Beneficiário: ${analysis.beneficiario || 'N/A'}, ` +
            `Valor: ${analysis.valor || 'N/A'}, ` +
            `Data pagamento: ${analysis.data_pagamento || 'N/A'}\n` +
            `STATUS NO SISTEMA: ${statusText}`
        } else if (msg.direction === 'in') {
          content = `[Cliente enviou ${msg.type === 'image' ? 'uma imagem' : 'um documento'}]`
        }
      } else if (msg.content) {
        content = msg.content
      } else if (msg.direction === 'in') {
        content = `[${msg.type}]`
      }

      if (content) {
        openAiMessages.push({ role, content })
      }
    }

    // 6. Chamar OpenAI
    const openAiResp = await fetch('https://api.openai.com/v1/chat/completions', {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model:       'gpt-4o-mini',
        max_tokens:  600,
        temperature: 0.6,
        messages:    openAiMessages,
      }),
    })

    if (!openAiResp.ok) {
      const errText = await openAiResp.text()
      console.error('OpenAI error:', errText)
      return new Response(JSON.stringify({ error: 'OpenAI error', detail: errText }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const openAiData = await openAiResp.json()
    const botReply   = (openAiData.choices?.[0]?.message?.content || '').trim()

    if (!botReply) {
      return new Response(JSON.stringify({ ok: true, skipped: true, reason: 'empty reply' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // 7. Verificar se deve escalar para atendente humano
    const shouldEscalate = botReply.startsWith('ESCALAR_HUMANO:')

    let messageToSend = botReply
    if (shouldEscalate) {
      messageToSend =
        'Entendido! Vou encaminhar você para um de nossos atendentes agora mesmo. Por favor, aguarde um momento. 🙏'

      await supabase
        .from('chat_conversations')
        .update({ handled_by: 'pending_human' })
        .eq('id', conversationId)
    }

    // 8. Enviar mensagem pelo WhatsApp
    let waMessageId: string | null = null

    const waResp = await fetch(
      `https://graph.facebook.com/v20.0/${WA_PHONE_NUMBER_ID}/messages`,
      {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${WA_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to:                contactWaId,
          type:              'text',
          text:              { body: messageToSend },
        }),
      }
    )

    if (waResp.ok) {
      const waData = await waResp.json()
      waMessageId  = waData.messages?.[0]?.id || null
    } else {
      console.error('WhatsApp send error:', await waResp.text())
    }

    // 9. Salvar mensagem do bot no banco
    await supabase.from('chat_messages').insert({
      conversation_id: conversationId,
      wa_message_id:   waMessageId,
      direction:       'out',
      type:            'text',
      content:         messageToSend,
      metadata:        { sent_by: 'bot' },
    })

    // Atualizar conversa
    await supabase
      .from('chat_conversations')
      .update({
        last_message_at:      new Date().toISOString(),
        last_message_preview: messageToSend.substring(0, 120),
      })
      .eq('id', conversationId)

    return new Response(
      JSON.stringify({ ok: true, escalated: shouldEscalate }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.error('ai-responder error:', err)
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
})
