import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const OPENAI_API_KEY     = Deno.env.get('OPENAI_API_KEY') || ''
const WA_ACCESS_TOKEN    = Deno.env.get('WHATSAPP_ACCESS_TOKEN') || ''
const WA_PHONE_NUMBER_ID = Deno.env.get('WHATSAPP_PHONE_NUMBER_ID') || ''

const SIENGE_BASE = 'https://api.sienge.com.br/avivconstrutora/public/api/v1'
const siengeAuth  = () =>
  `Basic ${btoa(`${Deno.env.get('SIENGE_USER')}:${Deno.env.get('SIENGE_PASSWORD')}`)}`

// ── Prompt de fallback ─────────────────────────────────────────────────────────
const FALLBACK_SYSTEM_PROMPT = `Você é um assistente virtual de atendimento ao cliente.
Seja educado, empático e profissional. Responda em português brasileiro.`

// ── Sufixo de escalação — sempre injetado ao final do system prompt ────────────
// Garante que QUALQUER agente (customizado ou fallback) saiba quando escalar.
const ESCALATION_SUFFIX = `

--- REGRAS DE ESCALAÇÃO PARA ATENDENTE HUMANO ---
Use EXATAMENTE o token ESCALAR_HUMANO: <motivo> como sua resposta COMPLETA (sem mais nada) nos seguintes casos:
1. O cliente pede explicitamente falar com um humano, atendente ou responsável.
2. A dúvida envolve cláusulas contratuais, jurídico, distrato ou situação específica do contrato.
3. O cliente demonstra confusão ou insatisfação mesmo após 2 ou mais tentativas de explicação.
4. A pergunta exige acesso a dados que você não possui (ex.: saldo atualizado, negociação, parcelamento especial).
5. O cliente está visivelmente frustrado, com reclamação grave ou ameaça de ação legal.
6. Você não tem certeza suficiente para responder com segurança.

Exemplos de uso correto:
- ESCALAR_HUMANO: cliente pergunta sobre cláusula de rescisão contratual
- ESCALAR_HUMANO: cliente solicita negociação especial de boleto vencido
- ESCALAR_HUMANO: cliente frustrado após múltiplas explicações
- ESCALAR_HUMANO: solicitou falar com atendente

Se nenhuma dessas condições se aplica, responda normalmente. NUNCA use ESCALAR_HUMANO: em respostas de rotina.`

// ── Handler principal ──────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  const { conversationId } = await req.json()
  if (!conversationId) {
    return new Response('conversationId required', { status: 400 })
  }

  if (!OPENAI_API_KEY)     console.error('CRITICAL: OPENAI_API_KEY not set')
  if (!WA_ACCESS_TOKEN)    console.error('CRITICAL: WHATSAPP_ACCESS_TOKEN not set')
  if (!WA_PHONE_NUMBER_ID) console.error('CRITICAL: WHATSAPP_PHONE_NUMBER_ID not set')

  try {
    // ── 1. Buscar conversa ────────────────────────────────────────────────────
    const { data: conv, error: convErr } = await supabase
      .from('chat_conversations')
      .select('id, handled_by, contact_id, agent_id, inbox_id')
      .eq('id', conversationId)
      .single()

    if (convErr || !conv) {
      console.error('conv query error:', convErr)
      return new Response('Conversation not found', { status: 404 })
    }

    if (conv.handled_by === 'human' || conv.handled_by === 'pending_human') {
      return new Response(JSON.stringify({ skipped: true, reason: 'human handling' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }

    // ── 1b. Credenciais da inbox ──────────────────────────────────────────────
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

    // ── 2. Buscar agente (conversa → inbox rule → padrão) ─────────────────────
    let agent: any = null

    if (conv.agent_id) {
      const { data } = await supabase
        .from('chat_agents').select('*')
        .eq('id', conv.agent_id).eq('is_active', true).maybeSingle()
      agent = data
    }
    if (!agent && conv.inbox_id) {
      const { data: rule } = await supabase
        .from('chat_agent_rules').select('agent_id')
        .eq('rule_type', 'inbox').eq('rule_value', conv.inbox_id)
        .order('priority').limit(1).maybeSingle()
      if (rule?.agent_id) {
        const { data } = await supabase
          .from('chat_agents').select('*')
          .eq('id', rule.agent_id).eq('is_active', true).maybeSingle()
        agent = data
      }
    }
    if (!agent) {
      const { data } = await supabase
        .from('chat_agents').select('*')
        .eq('is_default', true).eq('is_active', true).maybeSingle()
      agent = data
    }

    const model              = agent?.model                || 'gpt-4o-mini'
    const temperature        = Number(agent?.temperature   ?? 0.6)
    const maxTokens          = agent?.max_tokens           || 600
    const memoryLimit        = agent?.memory_messages      || 25
    const includeBoletos     = agent?.include_boletos      ?? true
    const includeContactInfo = agent?.include_contact_info ?? true
    const customContext      = agent?.custom_context       || ''
    const escalationMessage  = agent?.escalation_message   ||
      'Entendido! Vou encaminhar você para um de nossos atendentes agora mesmo. Por favor, aguarde um momento. 🙏'

    // Contextos configurados pelo admin — injetados como regras extras no ESCALATION_SUFFIX
    const agentContexts   = (agent?.escalation_contexts   as string | null) || ''
    const agentBotPhrases = (agent?.escalation_bot_phrases as string[] | null) || []

    const contextRules = agentContexts.trim()
      ? '\n\nCONTEXTOS ADICIONAIS QUE DEVEM ESCALAR (configurados pelo administrador):\n' + agentContexts
      : ''

    const systemPrompt = (agent?.system_prompt || FALLBACK_SYSTEM_PROMPT) + ESCALATION_SUFFIX + contextRules

    console.log(`Using agent: ${agent?.name || 'fallback'} | model: ${model}`)

    // ── 3. Buscar contato ─────────────────────────────────────────────────────
    const { data: contact } = await supabase
      .from('chat_contacts').select('id, wa_id, name')
      .eq('id', conv.contact_id).single()

    const contactWaId = (contact?.wa_id as string) || ''

    // ── 4. Histórico de mensagens (sistema atual) ─────────────────────────────
    const { data: rawMessages } = await supabase
      .from('chat_messages')
      .select('id, direction, type, content, metadata, ai_analysis, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(memoryLimit)

    const history = (rawMessages || []).reverse()

    // ── 4b. Histórico legado do n8n (sistema SGL anterior) ────────────────────
    // Carregado apenas quando a conversa no nosso sistema ainda é nova (≤ 5 msgs),
    // evitando poluir conversas longas com contexto antigo irrelevante.
    let legacyMessages: { role: 'user' | 'assistant'; content: string }[] = []

    if (history.length <= 5 && contactWaId) {
      const { data: n8nRows } = await supabase
        .from('n8n_chat_histories')
        .select('id, message')
        .eq('session_id', contactWaId)
        .order('id', { ascending: true })
        .limit(20)  // últimas 20 trocas do histórico n8n

      for (const row of (n8nRows || [])) {
        const msg = row.message as any
        if (msg?.type === 'human' && msg.content) {
          legacyMessages.push({ role: 'user', content: msg.content })
        } else if (msg?.type === 'ai' && msg.content) {
          legacyMessages.push({ role: 'assistant', content: msg.content })
        }
      }

      if (legacyMessages.length > 0) {
        console.log(`Loaded ${legacyMessages.length} legacy n8n messages for ${contactWaId}`)
      }
    }

    // ── 5. Boletos Sienge (por telefone na base local) ────────────────────────
    let boletos: any[]      = []
    let boletoSource        = ''   // 'sienge' | 'sgl'

    if (includeBoletos) {
      const { data } = await supabase
        .from('sienge_boletos')
        .select('parcela_descricao, due_date, amount, status')
        .eq('customer_phone', contactWaId)
        .order('due_date', { ascending: true })
        .limit(10)
      boletos = data || []
      if (boletos.length > 0) boletoSource = 'sienge'
    }

    // ── 5b. Campos a capturar (contact attribute defs) ────────────────────────
    let attrDefs: any[] = []
    const capturedAttrs: Record<string, { value: string; label: string; fieldType: string }> = {}

    if (agent?.id) {
      const { data: defs } = await supabase
        .from('chat_contact_attribute_defs').select('*')
        .eq('agent_id', agent.id).order('sort_order')
      attrDefs = defs || []
    }

    if (attrDefs.length > 0) {
      const { data: existing } = await supabase
        .from('chat_contact_attributes').select('*')
        .eq('contact_id', conv.contact_id)

      for (const attr of (existing || [])) {
        const def = attrDefs.find((d: any) => d.key === attr.attribute_key)
        capturedAttrs[attr.attribute_key] = {
          value:     attr.attribute_value,
          label:     attr.attribute_label || attr.attribute_key,
          fieldType: def?.field_type || 'text',
        }
      }

      // Tentar capturar da última mensagem recebida
      const lastUserMsg  = history.filter(m => m.direction === 'in').slice(-1)[0]
      const incomingText = lastUserMsg?.content || ''

      if (incomingText) {
        for (const def of attrDefs) {
          if (capturedAttrs[def.key]) continue
          const regex = getAttrRegex(def.field_type, def.capture_regex)
          if (!regex) continue
          const match = incomingText.match(regex)
          if (!match) continue
          const normalized = normalizeAttrValue(match[0], def.field_type)

          await supabase.from('chat_contact_attributes').upsert({
            contact_id:                  conv.contact_id,
            attribute_key:               def.key,
            attribute_value:             normalized,
            attribute_label:             def.name,
            captured_in_conversation_id: conversationId,
            captured_at:                 new Date().toISOString(),
          }, { onConflict: 'contact_id,attribute_key' })

          capturedAttrs[def.key] = { value: normalized, label: def.name, fieldType: def.field_type }
          console.log(`Captured attr "${def.key}" = "${normalized}"`)

          if (
            def.action === 'save_and_lookup_sienge' &&
            def.field_type === 'cpf_cnpj' &&
            boletos.length === 0
          ) {
            const cpfDigits = normalized.replace(/\D/g, '')
            if (cpfDigits.length >= 11) {
              const found = await fetchBoletoFromSiengeAPI(cpfDigits, contactWaId)
              if (found) { boletos = [found]; boletoSource = 'sienge' }
            }
          }
        }
      }

      // CPF já capturado antes, mas boleto ainda não encontrado por telefone
      if (boletos.length === 0) {
        for (const [key, captured] of Object.entries(capturedAttrs)) {
          const def = attrDefs.find((d: any) => d.key === key)
          if (def?.field_type === 'cpf_cnpj' && def?.action === 'save_and_lookup_sienge') {
            const cpfDigits = captured.value.replace(/\D/g, '')
            if (cpfDigits.length >= 11) {
              const found = await fetchBoletoFromSiengeAPI(cpfDigits, contactWaId)
              if (found) { boletos = [found]; boletoSource = 'sienge' }
              break
            }
          }
        }
      }
    }

    // ── 5c. Fallback SGL: mensagens_cobranca (quando Sienge não retornou) ─────
    // NÃO modifica o esquema da tabela — apenas leitura + UPDATE de status quando necessário.
    let sglBoletos: any[] = []

    if (boletos.length === 0 && contactWaId) {
      const { data: sglRows } = await supabase
        .from('mensagens_cobranca')
        .select(
          'id, pessoanomecompleto, unidadeempreendimento, unidadequadraandar, ' +
          'unidadeloteapartamento, contasreceberparcela, contasrecebervencimento, ' +
          'contasrecebervalor, linkboleto, status, created_at'
        )
        .eq('phone', contactWaId)
        .order('created_at', { ascending: false })
        .limit(5)

      sglBoletos = sglRows || []

      if (sglBoletos.length > 0) {
        boletoSource = 'sgl'
        console.log(`SGL boleto found for ${contactWaId}: ${sglBoletos.length} registro(s)`)
        // Converter para formato compatível com o contexto do bot
        boletos = sglBoletos.map(b => ({
          parcela_descricao: [
            b.contasreceberparcela,
            b.unidadeempreendimento,
            [b.unidadequadraandar, b.unidadeloteapartamento].filter(Boolean).join(' — '),
          ].filter(Boolean).join(' | '),
          due_date:   b.contasrecebervencimento,
          amount:     parseSglAmount(b.contasrecebervalor),
          status:     mapSglStatus(b.status),
          link_boleto: b.linkboleto,   // campo extra — só existe em SGL
          source:     'sgl',
        }))
      }
    }

    // ── 6. Construir contexto do cliente ──────────────────────────────────────
    const customerName = (contact?.name as string) || 'Cliente'
    let customerContext = ''

    if (includeContactInfo) {
      customerContext += `Nome: ${customerName}\nTelefone: +${contactWaId}\n`
    }

    // Campos capturados
    if (Object.keys(capturedAttrs).length > 0) {
      customerContext += '\nCAMPOS CAPTURADOS DO CLIENTE:\n'
      for (const [, captured] of Object.entries(capturedAttrs)) {
        customerContext += `- ${captured.label}: ${captured.value}\n`
      }
    }

    // Boletos (Sienge ou SGL)
    if (boletos.length > 0) {
      const sourceLabel = boletoSource === 'sgl' ? 'SGL' : 'Sienge'
      customerContext += `\nBOLETOS CADASTRADOS (${sourceLabel}):\n`

      for (const b of boletos) {
        const dueDate = new Date(b.due_date).toLocaleDateString('pt-BR')
        const amount  = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(b.amount || 0)
        const statusLabel =
          b.status === 'pago'                ? '✅ Pago'                :
          b.status === 'comprovante_recebido' ? '📨 Comprovante recebido' :
          b.status === 'vencido'              ? '⚠️ Vencido'             :
          b.status === 'cancelado'            ? '❌ Cancelado'            :
                                               '🔵 Em aberto'

        customerContext += `- ${b.parcela_descricao || 'Parcela'}: ${amount} | Vencimento: ${dueDate} | ${statusLabel}\n`

        // Incluir link do boleto no contexto (SGL sempre tem link)
        if (b.link_boleto) {
          customerContext += `  Link para pagamento: ${b.link_boleto}\n`
        }
      }
    } else if (includeBoletos) {
      customerContext += '\nNenhum boleto encontrado no sistema para este número.\n'
    }

    if (customContext) {
      customerContext += `\nINFORMAÇÕES ADICIONAIS:\n${customContext}\n`
    }

    // ── 7. Montar mensagens para OpenAI ───────────────────────────────────────
    const openAiMessages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
      {
        role:    'system',
        content: systemPrompt + (customerContext ? '\n\n--- DADOS DO CLIENTE ---\n' + customerContext : ''),
      },
    ]

    // Injetar histórico legado do n8n ANTES do histórico atual
    // Isso dá ao modelo contexto de conversas anteriores no sistema SGL
    if (legacyMessages.length > 0) {
      openAiMessages.push({
        role:    'system',
        content: '--- HISTÓRICO DE ATENDIMENTO ANTERIOR (sistema legado) ---',
      })
      openAiMessages.push(...legacyMessages)
      openAiMessages.push({
        role:    'system',
        content: '--- FIM DO HISTÓRICO ANTERIOR — CONVERSA ATUAL ABAIXO ---',
      })
    }

    // Histórico atual (chat_messages do novo sistema)
    for (const msg of history) {
      const role = msg.direction === 'in' ? 'user' : 'assistant'
      let content = ''

      if (msg.type === 'audio') {
        const transcription = (msg.metadata as any)?.transcription
        content = transcription
          ? `[Áudio transcrito]: ${transcription}`
          : `[Cliente enviou um áudio — transcrição indisponível]`
      } else if ((msg.type === 'image' || msg.type === 'document') && (msg.ai_analysis as any)) {
        const analysis = msg.ai_analysis as any
        if (analysis.nao_comprovante) {
          content = `[Cliente enviou ${msg.type === 'image' ? 'uma imagem' : 'um documento'} — não identificado como comprovante de pagamento]`
        } else if (analysis.verdict) {
          content = `[Cliente enviou comprovante de pagamento]\nResultado da análise: ${analysis.verdict}`
        } else if (analysis.sienge_status) {
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

    // ── 8. Chamar OpenAI ──────────────────────────────────────────────────────
    let botReply = ''

    if (!OPENAI_API_KEY) {
      console.error('CRITICAL: OPENAI_API_KEY vazio!')
      botReply = 'Olá! Recebi sua mensagem. Nossa equipe está analisando e retornará em breve. 😊'
    } else {
      console.log(`OpenAI → model=${model} tokens=${maxTokens} msgs=${openAiMessages.length} legacy=${legacyMessages.length} boleto_src=${boletoSource || 'none'}`)
      const openAiResp = await fetch('https://api.openai.com/v1/chat/completions', {
        method:  'POST',
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          max_completion_tokens: maxTokens,
          temperature,
          messages: openAiMessages,
        }),
      })

      if (!openAiResp.ok) {
        const errText = await openAiResp.text()
        console.error(`OpenAI ERRO ${openAiResp.status}:`, errText)
        botReply = 'Olá! Recebi sua mensagem. Nossa equipe está analisando e retornará em breve. 😊'
      } else {
        const openAiData = await openAiResp.json()
        botReply = (openAiData.choices?.[0]?.message?.content || '').trim()
        if (!botReply) {
          console.error('OpenAI retornou conteúdo vazio')
          botReply = 'Olá! Recebi sua mensagem. Nossa equipe está analisando e retornará em breve. 😊'
        } else {
          console.log(`OpenAI OK — resposta: ${botReply.substring(0, 80)}...`)
        }
      }
    }

    // ── 9. Escalação ──────────────────────────────────────────────────────────
    // Frases padrão + frases configuradas pelo admin no agente (escalation_bot_phrases)
    const DEFAULT_ESCALATION_PHRASES = [
      'ESCALAR_HUMANO:',
      'nossos atendentes já vai falar',
      'atendente já vai falar',
      'vou encaminhar para um atendente',
      'vou encaminhar seu caso',
      'encaminhar para nossa equipe',
      'um atendente entrará em contato',
      'atendente irá te ajudar',
    ]
    const allEscalationPhrases = [...DEFAULT_ESCALATION_PHRASES, ...agentBotPhrases]
    const shouldEscalate = allEscalationPhrases.some(p =>
      botReply.toLowerCase().includes(p.toLowerCase())
    )
    // Usa o token formal → substitui pela mensagem amigável configurada
    // Usa frase do agente  → mantém a resposta original (já é amigável)
    const messageToSend = botReply.includes('ESCALAR_HUMANO:')
      ? escalationMessage
      : botReply

    if (shouldEscalate) {
      await supabase
        .from('chat_conversations')
        .update({ handled_by: 'pending_human' })
        .eq('id', conversationId)
      console.log(`Escalated conversation ${conversationId}`)
    }

    // ── 10. Enviar pelo WhatsApp ───────────────────────────────────────────────
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

    // ── 11. Salvar no banco ───────────────────────────────────────────────────
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
      JSON.stringify({
        ok:          true,
        escalated:   shouldEscalate,
        waMessageId,
        agentName:   agent?.name || 'fallback',
        boletoSource: boletoSource || 'none',
        legacyMsgs:  legacyMessages.length,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.error('ai-responder error:', err)
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// ── Parsear valor SGL: "575,74" ou "1.234,56" → number ───────────────────────
function parseSglAmount(value: string | null): number {
  if (!value) return 0
  // Remove separadores de milhar (.) e substitui vírgula decimal por ponto
  return parseFloat(value.replace(/\./g, '').replace(',', '.')) || 0
}

// ── Mapear status SGL para o padrão interno ───────────────────────────────────
function mapSglStatus(status: string | null): string {
  switch (status) {
    case 'pago':                  return 'pago'
    case 'comprovante_recebido':  return 'comprovante_recebido'
    case 'cancelado':             return 'cancelado'
    case 'vencido':               return 'vencido'
    default:                      return 'em_aberto'
  }
}

// ── Regex por tipo de campo (contact attributes) ──────────────────────────────
function getAttrRegex(fieldType: string, customRegex?: string | null): RegExp | null {
  if (customRegex) {
    try { return new RegExp(customRegex, 'i') } catch { return null }
  }
  switch (fieldType) {
    case 'cpf_cnpj':
      return /\b\d{3}\.?\d{3}\.?\d{3}[-.]?\d{2}\b|\b\d{2}\.?\d{3}\.?\d{3}[\/.]?\d{4}[-.]?\d{2}\b/
    case 'email':
      return /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/
    case 'phone':
      return /\b(?:\+?55\s?)?(?:\(?\d{2}\)?\s?)?(?:9\s?)?\d{4}[-\s]?\d{4}\b/
    case 'number':
      return /\b\d+(?:[.,]\d+)?\b/
    default:
      return null
  }
}

// ── Normalizar valor capturado ─────────────────────────────────────────────────
function normalizeAttrValue(value: string, fieldType: string): string {
  if (fieldType === 'cpf_cnpj' || fieldType === 'phone') {
    return value.replace(/\D/g, '')
  }
  return value.trim()
}

// ── Buscar boleto via API Sienge por CPF ──────────────────────────────────────
async function fetchBoletoFromSiengeAPI(cpfDigits: string, waId: string): Promise<any | null> {
  try {
    const auth = siengeAuth()

    const custResp = await fetch(
      `${SIENGE_BASE}/customers?cpf=${cpfDigits}&onlyActive=false&limit=5`,
      { headers: { Authorization: auth } }
    )
    if (!custResp.ok) { console.warn('Sienge customers error:', custResp.status); return null }
    const custData = await custResp.json()
    const customer = custData.results?.[0]
    if (!customer) { console.log('No Sienge customer for CPF:', cpfDigits); return null }
    console.log('Sienge customer:', customer.id, customer.name)

    const billsResp = await fetch(
      `${SIENGE_BASE}/accounts-receivable/receivable-bills?customerId=${customer.id}&paidOff=false&limit=20`,
      { headers: { Authorization: auth } }
    )
    if (!billsResp.ok) { console.warn('Sienge bills error:', billsResp.status); return null }
    const bills: any[] = (await billsResp.json()).results || []
    if (!bills.length) { console.log('No open bills for customer:', customer.id); return null }

    for (const bill of bills) {
      const instResp = await fetch(
        `${SIENGE_BASE}/accounts-receivable/receivable-bills/${bill.receivableBillId}/installments`,
        { headers: { Authorization: auth } }
      )
      if (!instResp.ok) continue
      const openInst = ((await instResp.json()).results || [])
        .find((i: any) => Number(i.balanceDue || 0) > 0)
      if (!openInst) continue

      const payload = {
        receivable_bill_id: bill.receivableBillId,
        installment_id:     openInst.installmentId,
        customer_id:        customer.id,
        customer_name:      customer.name,
        customer_phone:     waId,
        customer_cpf:       cpfDigits,
        due_date:           openInst.dueDate,
        amount:             openInst.balanceDue,
        parcela_descricao:  `Parcela ${openInst.installmentId}`,
        status:             'em_aberto',
        updated_at:         new Date().toISOString(),
      }

      const { data: upserted } = await supabase
        .from('sienge_boletos')
        .upsert(payload, { onConflict: 'receivable_bill_id,installment_id' })
        .select('parcela_descricao, due_date, amount, status')
        .maybeSingle()

      return upserted || payload
    }
    return null
  } catch (err) {
    console.error('fetchBoletoFromSiengeAPI error:', err)
    return null
  }
}
