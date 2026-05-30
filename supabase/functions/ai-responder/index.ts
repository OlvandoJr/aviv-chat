import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const OPENAI_API_KEY     = Deno.env.get('OPENAI_API_KEY') || ''
const WA_ACCESS_TOKEN    = Deno.env.get('WHATSAPP_ACCESS_TOKEN') || ''
const WA_PHONE_NUMBER_ID = Deno.env.get('WHATSAPP_PHONE_NUMBER_ID') || ''

// ── Prompt de fallback (caso nenhum agente esteja configurado no DB) ───────────
const FALLBACK_SYSTEM_PROMPT = `Você é um assistente virtual de atendimento ao cliente.
Seja educado, empático e profissional. Responda em português brasileiro.
Quando o cliente solicitar falar com um atendente humano, responda apenas: ESCALAR_HUMANO: solicitou atendimento humano`

// ── Handler principal ──────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  const { conversationId } = await req.json()

  if (!conversationId) {
    return new Response('conversationId required', { status: 400 })
  }

  if (!OPENAI_API_KEY) console.error('CRITICAL: OPENAI_API_KEY not set')
  if (!WA_ACCESS_TOKEN) console.error('CRITICAL: WHATSAPP_ACCESS_TOKEN not set')
  if (!WA_PHONE_NUMBER_ID) console.error('CRITICAL: WHATSAPP_PHONE_NUMBER_ID not set')

  try {
    // 1. Buscar conversa
    const { data: conv, error: convErr } = await supabase
      .from('chat_conversations')
      .select('id, handled_by, contact_id, agent_id, inbox_id')
      .eq('id', conversationId)
      .single()

    if (convErr || !conv) {
      console.error('conv query error:', convErr)
      return new Response('Conversation not found', { status: 404 })
    }

    if (conv.handled_by === 'human') {
      return new Response(JSON.stringify({ skipped: true, reason: 'human handling' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }

    // 1b. Buscar credenciais da inbox (phone_number_id e access_token por número)
    let phoneNumberId = WA_PHONE_NUMBER_ID
    let accessToken   = WA_ACCESS_TOKEN

    if (conv.inbox_id) {
      const { data: inbox } = await supabase
        .from('chat_inboxes')
        .select('phone_number_id, access_token')
        .eq('id', conv.inbox_id)
        .single()

      if (inbox?.phone_number_id) phoneNumberId = inbox.phone_number_id
      if (inbox?.access_token)    accessToken   = inbox.access_token
    }

    // 2. Buscar configuração do agente (por conversa → inbox rule → padrão)
    let agent: any = null

    if (conv.agent_id) {
      const { data } = await supabase
        .from('chat_agents')
        .select('*')
        .eq('id', conv.agent_id)
        .eq('is_active', true)
        .maybeSingle()
      agent = data
    }

    // Roteamento por inbox: se não há agent_id na conversa, busca regra de inbox
    if (!agent && conv.inbox_id) {
      const { data: rule } = await supabase
        .from('chat_agent_rules')
        .select('agent_id')
        .eq('rule_type', 'inbox')
        .eq('rule_value', conv.inbox_id)
        .order('priority')
        .limit(1)
        .maybeSingle()

      if (rule?.agent_id) {
        const { data } = await supabase
          .from('chat_agents')
          .select('*')
          .eq('id', rule.agent_id)
          .eq('is_active', true)
          .maybeSingle()
        agent = data
      }
    }

    if (!agent) {
      const { data } = await supabase
        .from('chat_agents')
        .select('*')
        .eq('is_default', true)
        .eq('is_active', true)
        .maybeSingle()
      agent = data
    }

    // Config do agente (com defaults se não houver agente no DB)
    const systemPrompt        = agent?.system_prompt        || FALLBACK_SYSTEM_PROMPT
    const model               = agent?.model                || 'gpt-4o-mini'
    const temperature         = Number(agent?.temperature   ?? 0.6)
    const maxTokens           = agent?.max_tokens           || 600
    const memoryLimit         = agent?.memory_messages      || 25
    const includeBoletos      = agent?.include_boletos      ?? true
    const includeContactInfo  = agent?.include_contact_info ?? true
    const customContext       = agent?.custom_context       || ''
    const escalationMessage   = agent?.escalation_message   ||
      'Entendido! Vou encaminhar você para um de nossos atendentes agora mesmo. Por favor, aguarde um momento. 🙏'

    console.log(`Using agent: ${agent?.name || 'fallback'} | model: ${model}`)

    // 3. Buscar contato
    const { data: contact } = await supabase
      .from('chat_contacts')
      .select('id, wa_id, name')
      .eq('id', conv.contact_id)
      .single()

    const contactWaId = (contact?.wa_id as string) || ''

    // 4. Histórico de mensagens
    const { data: rawMessages } = await supabase
      .from('chat_messages')
      .select('id, direction, type, content, metadata, ai_analysis, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(memoryLimit)

    const history = (rawMessages || []).reverse()

    // 5. Boletos do cliente (se ativado no agente)
    let boletos: any[] = []
    if (includeBoletos) {
      const { data } = await supabase
        .from('sienge_boletos')
        .select('parcela_descricao, due_date, amount, status')
        .eq('customer_phone', contactWaId)
        .order('due_date', { ascending: true })
        .limit(10)
      boletos = data || []
    }

    // 6. Construir contexto do cliente
    const customerName = (contact?.name as string) || 'Cliente'
    let customerContext = ''

    if (includeContactInfo) {
      customerContext += `Nome: ${customerName}\nTelefone: +${contactWaId}\n`
    }

    if (boletos.length > 0) {
      customerContext += '\nBOLETOS CADASTRADOS:\n'
      for (const b of boletos) {
        const dueDate = new Date(b.due_date).toLocaleDateString('pt-BR')
        const amount  = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(b.amount)
        const statusLabel =
          b.status === 'pago'                ? '✅ Pago'                :
          b.status === 'comprovante_recebido' ? '📨 Comprovante recebido' :
          b.status === 'vencido'              ? '⚠️ Vencido'             :
          b.status === 'cancelado'            ? '❌ Cancelado'            :
                                               '🔵 Em aberto'
        customerContext += `- ${b.parcela_descricao || 'Parcela'}: ${amount} | Vencimento: ${dueDate} | ${statusLabel}\n`
      }
    } else if (includeBoletos) {
      customerContext += '\nNenhum boleto encontrado no sistema para este número.\n'
    }

    if (customContext) {
      customerContext += `\nINFORMAÇÕES ADICIONAIS:\n${customContext}\n`
    }

    // 7. Montar mensagens para OpenAI
    const openAiMessages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
      {
        role:    'system',
        content: systemPrompt + (customerContext ? '\n\n--- DADOS DO CLIENTE ---\n' + customerContext : ''),
      },
    ]

    for (const msg of history) {
      const role = msg.direction === 'in' ? 'user' : 'assistant'
      let content = ''

      if (msg.type === 'audio' && (msg.metadata as any)?.transcription) {
        content = `[Áudio transcrito]: ${(msg.metadata as any).transcription}`
      } else if ((msg.type === 'image' || msg.type === 'document') && (msg.ai_analysis as any)) {
        const analysis = msg.ai_analysis as any
        if (analysis.nao_comprovante) {
          content = `[Cliente enviou ${msg.type === 'image' ? 'uma imagem' : 'um documento'} — não identificado como comprovante de pagamento]`
        } else if (analysis.verdict) {
          // Veredicto completo disponível — passar direto para o agente responder
          content = `[Cliente enviou comprovante de pagamento]\nResultado da análise: ${analysis.verdict}`
        } else if (analysis.sienge_status) {
          // Fallback legado (análise sem veredicto)
          const statusText = analysis.sienge_status === 'pago' ? 'CONFIRMADO COMO PAGO' : 'PENDENTE DE CONFIRMAÇÃO'
          content =
            `[Cliente enviou comprovante de pagamento]\n` +
            `Beneficiário: ${analysis.beneficiario || 'N/A'}, Valor: ${analysis.valor || 'N/A'}, ` +
            `Pagamento: ${analysis.data_pagamento || 'N/A'} — STATUS: ${statusText}`
        } else if (msg.direction === 'in') {
          content = `[Cliente enviou ${msg.type === 'image' ? 'uma imagem' : 'um documento'}]`
        }
      } else if (msg.content) {
        content = msg.content
      } else if (msg.direction === 'in') {
        content = `[${msg.type}]`
      }

      if (content) openAiMessages.push({ role, content })
    }

    if (!openAiMessages.some((m) => m.role === 'user')) {
      openAiMessages.push({ role: 'user', content: 'Olá' })
    }

    // 8. Chamar OpenAI
    let botReply = ''

    if (!OPENAI_API_KEY) {
      botReply = 'Olá! Recebi sua mensagem. Nossa equipe está analisando e retornará em breve. 😊'
    } else {
      const openAiResp = await fetch('https://api.openai.com/v1/chat/completions', {
        method:  'POST',
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: maxTokens, temperature, messages: openAiMessages }),
      })

      if (!openAiResp.ok) {
        const errText = await openAiResp.text()
        console.error('OpenAI error:', openAiResp.status, errText)
        botReply = 'Olá! Recebi sua mensagem. Nossa equipe está analisando e retornará em breve. 😊'
      } else {
        const openAiData = await openAiResp.json()
        botReply = (openAiData.choices?.[0]?.message?.content || '').trim()
        if (!botReply) {
          console.error('OpenAI returned empty content')
          botReply = 'Olá! Recebi sua mensagem. Nossa equipe está analisando e retornará em breve. 😊'
        }
      }
    }

    // 9. Escalação
    const shouldEscalate = botReply.startsWith('ESCALAR_HUMANO:')
    let messageToSend = botReply

    if (shouldEscalate) {
      messageToSend = escalationMessage
      await supabase
        .from('chat_conversations')
        .update({ handled_by: 'pending_human' })
        .eq('id', conversationId)
    }

    // 10. Enviar pelo WhatsApp
    let waMessageId: string | null = null

    if (accessToken && phoneNumberId && contactWaId) {
      const waResp = await fetch(
        `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`,
        {
          method:  'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to:   contactWaId,
            type: 'text',
            text: { body: messageToSend },
          }),
        }
      )

      if (waResp.ok) {
        const waData = await waResp.json()
        waMessageId  = waData.messages?.[0]?.id || null
      } else {
        console.error('WhatsApp send error:', waResp.status, await waResp.text())
      }
    } else {
      console.error('WhatsApp credentials missing', { accessToken: !!accessToken, phoneNumberId: !!phoneNumberId, contactWaId: !!contactWaId })
    }

    // 11. Salvar no banco
    const { error: insertErr } = await supabase.from('chat_messages').insert({
      conversation_id: conversationId,
      wa_message_id:   waMessageId,
      direction:       'out',
      type:            'text',
      content:         messageToSend,
      metadata:        { sent_by: 'bot', agent_id: agent?.id || null },
    })
    if (insertErr) console.error('Insert message error:', JSON.stringify(insertErr))

    await supabase
      .from('chat_conversations')
      .update({
        last_message_at:      new Date().toISOString(),
        last_message_preview: messageToSend.substring(0, 120),
      })
      .eq('id', conversationId)

    return new Response(
      JSON.stringify({ ok: true, escalated: shouldEscalate, waMessageId, agentName: agent?.name || 'fallback' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.error('ai-responder error:', err)
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
})
