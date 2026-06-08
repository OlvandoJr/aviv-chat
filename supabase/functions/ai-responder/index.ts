import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { executeApiConfig } from '../_shared/apiExec.ts'

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

// ── Regras de escalação (EDITÁVEIS na UI do agente) ────────────────────────────
// Usado como fallback quando o agente não tem escalation_rules configurado.
// O admin pode sobrescrever no campo "Regras de escalação" do quadro Escalação.
const DEFAULT_ESCALATION_RULES = `--- REGRAS DE ESCALAÇÃO PARA ATENDENTE HUMANO ---
Use EXATAMENTE o token ESCALAR_HUMANO: <motivo> como sua resposta COMPLETA (sem mais nada) APENAS nos seguintes casos:
1. O cliente pede explicitamente falar com um humano, atendente, gerente ou responsável.
2. A dúvida envolve cláusulas contratuais, jurídico, distrato ou negociação/parcelamento especial.
3. O cliente demonstra clara insatisfação ou frustração após você já ter tentado ajudar ao menos uma vez.
4. Reclamação grave ou ameaça de ação legal.

NUNCA escale nestes casos (responda normalmente):
- Saudações, cumprimentos ou primeira mensagem (ex.: "oi", "olá", "bom dia"). Cumprimente o cliente e pergunte, de forma cordial, como pode ajudar e com quem está falando.
- Quando você ainda não tem os dados do cliente: pergunte educadamente o nome e o que ele precisa — NÃO escale por falta de dados.
- Dúvidas simples dentro do seu escopo (boleto, comprovante, agendamento, vencimento).

Exemplos de uso correto:
- ESCALAR_HUMANO: cliente pergunta sobre cláusula de rescisão contratual
- ESCALAR_HUMANO: cliente solicita negociação especial de boleto vencido
- ESCALAR_HUMANO: solicitou falar com atendente

Na dúvida entre escalar ou ajudar, PREFIRA ajudar. Só escale se um dos casos 1-4 acima for claramente atendido. NUNCA use ESCALAR_HUMANO: em saudações ou respostas de rotina.`

// ── Proteção técnica do sistema (NÃO editável — sempre injetada) ───────────────
// Impede vazamento de tokens internos para o cliente. Não depende do agente.
const SYSTEM_TOKEN_PROTECTION = `

REGRA CRÍTICA: NUNCA inclua tokens internos (como Atualiza_base_dados, UPDATE_DB, ou qualquer instrução no formato token { ... }) na sua resposta ao cliente. Esses tokens são processados internamente e JAMAIS devem aparecer na mensagem enviada ao cliente.`

// Normaliza telefone BR → DDD + 8 últimos dígitos (espelha normalize_phone do SQL)
function normalizePhone(raw: string): string {
  let d = (raw || '').replace(/\D/g, '')
  if (!d) return ''
  if (d.startsWith('55') && d.length >= 12) d = d.slice(2)
  if (d.startsWith('0')) d = d.slice(1)
  if (d.length >= 11 && d[2] === '9') d = d.slice(0, 2) + d.slice(3)
  return d.slice(-10)
}

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

    // ── 2. Buscar agente (regra da janela de 24h do template) ─────────────────
    // Se houve um TEMPLATE de cobrança (out) nas últimas 24h, a conversa está na
    // "janela de campanha" → agente de cobrança (default/Vivi). Caso contrário, é
    // uma mensagem avulsa do cliente → agente da regra de inbox (Contato Inteligente).
    let agent: any = null

    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { data: recentTpl } = await supabase
      .from('chat_messages').select('id')
      .eq('conversation_id', conversationId)
      .eq('direction', 'out').eq('type', 'template')
      .gte('created_at', since24h)
      .limit(1).maybeSingle()

    if (recentTpl) {
      const { data } = await supabase
        .from('chat_agents').select('*')
        .eq('is_default', true).eq('is_active', true).maybeSingle()
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

    // Contextos configurados pelo admin — injetados como regras extras
    const agentContexts   = (agent?.escalation_contexts   as string | null) || ''
    const agentBotPhrases = (agent?.escalation_bot_phrases as string[] | null) || []

    // Regras de escalação editáveis na UI (fallback para o default do sistema)
    const escalationRules = ((agent?.escalation_rules as string | null) || '').trim() || DEFAULT_ESCALATION_RULES

    const contextRules = agentContexts.trim()
      ? '\n\nCONTEXTOS ADICIONAIS QUE DEVEM ESCALAR (configurados pelo administrador):\n' + agentContexts
      : ''

    // Prompt final = prompt do agente + regras de escalação (UI) + contextos + proteção técnica fixa
    const systemPrompt = (agent?.system_prompt || FALLBACK_SYSTEM_PROMPT)
      + '\n\n' + escalationRules
      + contextRules
      + SYSTEM_TOKEN_PROTECTION

    console.log(`Using agent: ${agent?.name || 'fallback'} | model: ${model}`)

    // ── 2b. Buscar ferramentas ativas do agente ───────────────────────────────
    let agentTools: any[] = []
    if (agent?.id) {
      const { data: tools } = await supabase
        .from('chat_agent_tools')
        .select('*, api_connection:chat_api_connections(*)')
        .eq('agent_id', agent.id)
        .eq('is_active', true)
        .order('sort_order')
      agentTools = tools || []
    }

    // ── 2c. Buscar campos de atualização configurados ─────────────────────────
    let updateDefs: any[] = []
    if (agent?.id) {
      const { data: defs } = await supabase
        .from('chat_conversation_update_defs')
        .select('*')
        .eq('agent_id', agent.id)
        .order('sort_order')
      updateDefs = defs || []
    }

    // Construir array de tools para OpenAI
    const openAiTools: any[] = []
    const apiToolFns: Record<string, any> = {}   // nome-da-function → tool (api_call)
    for (const tool of agentTools) {
      if (tool.tool_type === 'api_call') {
        const cfg = tool.config || {}
        let fn = 'api_' + String(tool.name || tool.id).toLowerCase()
          .normalize('NFD').replace(/[̀-ͯ]/g, '')
          .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48)
        while (apiToolFns[fn]) fn += '_'
        const properties: Record<string, any> = {}
        const required: string[] = []
        for (const p of (cfg.parameters || [])) {
          if (!p?.name) continue
          properties[p.name] = { type: p.type || 'string', description: p.description || '' }
          if (p.required) required.push(p.name)
        }
        apiToolFns[fn] = tool
        openAiTools.push({
          type: 'function',
          function: {
            name:        fn,
            description: tool.description || tool.name || 'Chama uma integração externa.',
            parameters:  { type: 'object', properties, required },
          },
        })
        continue
      }
      if (tool.tool_type === 'payment_scheduler') {
        openAiTools.push({
          type: 'function',
          function: {
            name: 'calcular_datas_pagamento',
            description: tool.description || 'Calcula as próximas datas úteis disponíveis para o cliente agendar o pagamento do boleto. Use quando o cliente quiser pagar em outra data.',
            parameters: { type: 'object', properties: {} },
          },
        })
        openAiTools.push({
          type: 'function',
          function: {
            name: 'confirmar_agendamento',
            description: 'Confirma e registra o agendamento do pagamento para a data escolhida pelo cliente. Use depois que o cliente escolher uma das datas oferecidas.',
            parameters: {
              type: 'object',
              required: ['data_escolhida'],
              properties: {
                data_escolhida: {
                  type: 'string',
                  description: 'Data escolhida pelo cliente no formato DD/MM/YYYY',
                },
                observacoes: {
                  type: 'string',
                  description: 'Observações adicionais do cliente sobre o agendamento',
                },
              },
            },
          },
        })
      }
    }

    // Adicionar atualizar_conversa se há campos de atualização configurados
    if (updateDefs.length > 0) {
      const properties: Record<string, any> = {}
      for (const def of updateDefs) {
        let prop: any = {
          description: def.description || `Valor para o campo: ${def.name}`,
        }
        if (def.field_type === 'select' && def.options?.length > 0) {
          prop.type = 'string'
          prop.enum = def.options
        } else if (def.field_type === 'number') {
          prop.type = 'number'
        } else if (def.field_type === 'boolean') {
          prop.type = 'boolean'
        } else {
          prop.type = 'string'
        }
        properties[def.key] = prop
      }

      openAiTools.push({
        type: 'function',
        function: {
          name: 'atualizar_conversa',
          description:
            'Atualiza os campos de status desta conversa no sistema interno. ' +
            'Use para registrar silenciosamente informações importantes identificadas durante o atendimento. ' +
            'Após chamar esta função, continue a conversa normalmente com sua resposta ao cliente.',
          parameters: {
            type: 'object',
            properties,
          },
        },
      })
    }

    // Ferramenta de 2ª via — a IA chama quando o cliente confirma QUAL boleto quer
    if (includeBoletos) {
      openAiTools.push({
        type: 'function',
        function: {
          name: 'enviar_segunda_via_boleto',
          description:
            'Gera a 2ª via do boleto escolhido, envia o PDF ao cliente como documento e retorna a linha digitável. ' +
            'Use os IDs (receivable_bill_id e installment_id) do boleto exatamente como aparecem na lista "BOLETOS CADASTRADOS" do contexto. ' +
            'Se houver MAIS DE UM boleto em aberto, primeiro liste-os (vencimento e valor) e pergunte qual o cliente deseja — só chame esta função após o cliente escolher. ' +
            'Se houver apenas UM, pode chamar diretamente quando o cliente pedir o boleto.',
          parameters: {
            type: 'object',
            required: ['receivable_bill_id', 'installment_id'],
            properties: {
              receivable_bill_id: { type: 'number', description: 'ID do título (receivable_bill_id) do boleto escolhido.' },
              installment_id:     { type: 'number', description: 'ID da parcela (installment_id) do boleto escolhido.' },
            },
          },
        },
      })
    }

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

    // Texto da última mensagem recebida do cliente (para subagentes de texto)
    const lastUserText = [...history].reverse()
      .find((m: any) => m.direction === 'in' && m.content)?.content || ''

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
        .select('parcela_descricao, due_date, amount, status, receivable_bill_id, installment_id')
        .eq('phone_norm', normalizePhone(contactWaId))   // comparação normalizada
        .not('status', 'in', '("pago","cancelado")')
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
              if (found) {
                boletos = [found]; boletoSource = 'sienge'
                if (found.customer_id) {
                  await supabase.from('chat_contact_attributes').upsert({
                    contact_id: conv.contact_id, attribute_key: 'sienge_customer_id',
                    attribute_value: String(found.customer_id), attribute_label: 'ID Cliente Sienge',
                    captured_in_conversation_id: conversationId, captured_at: new Date().toISOString(),
                  }, { onConflict: 'contact_id,attribute_key' })
                  capturedAttrs['sienge_customer_id'] = { value: String(found.customer_id), label: 'ID Cliente Sienge', fieldType: 'text' }
                }
              }
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
              if (found) {
                boletos = [found]; boletoSource = 'sienge'
                if (found.customer_id) {
                  await supabase.from('chat_contact_attributes').upsert({
                    contact_id: conv.contact_id, attribute_key: 'sienge_customer_id',
                    attribute_value: String(found.customer_id), attribute_label: 'ID Cliente Sienge',
                    captured_in_conversation_id: conversationId, captured_at: new Date().toISOString(),
                  }, { onConflict: 'contact_id,attribute_key' })
                  capturedAttrs['sienge_customer_id'] = { value: String(found.customer_id), label: 'ID Cliente Sienge', fieldType: 'text' }
                }
              }
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
      const sglCols =
        'id, pessoanomecompleto, unidadeempreendimento, unidadequadraandar, ' +
        'unidadeloteapartamento, contasreceberparcela, contasrecebervencimento, ' +
        'contasrecebervalor, linkboleto, status, created_at'

      // Busca por telefone normalizado (cobre formatos com/sem 9º dígito, DDI, 0 no DDD)
      const { data: sglRows } = await supabase
        .from('mensagens_cobranca')
        .select(sglCols)
        .eq('phone_norm', normalizePhone(contactWaId))
        .order('created_at', { ascending: false })
        .limit(5)

      sglBoletos = sglRows || []

      // Fallback: telefone exato (caso algum registro antigo não normalize)
      if (sglBoletos.length === 0) {
        const { data: exact } = await supabase
          .from('mensagens_cobranca')
          .select(sglCols)
          .eq('phone', contactWaId)
          .order('created_at', { ascending: false })
          .limit(5)
        sglBoletos = exact || []
      }

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

        // IDs para a IA acionar a ferramenta de 2ª via (boletos do Sienge)
        const ids = (b.receivable_bill_id && b.installment_id)
          ? ` [IDs: receivable_bill_id=${b.receivable_bill_id}, installment_id=${b.installment_id}]`
          : ''
        customerContext += `- ${b.parcela_descricao || 'Parcela'}: ${amount} | Vencimento: ${dueDate} | ${statusLabel}${ids}\n`

        // Incluir link do boleto no contexto (SGL sempre tem link)
        if (b.link_boleto) {
          customerContext += `  Link para pagamento: ${b.link_boleto}\n`
        }
      }

      // Instrução de uso conforme a origem do boleto
      if (boletoSource === 'sienge') {
        customerContext += boletos.length > 1
          ? '\nHá MAIS DE UM boleto em aberto. Quando o cliente pedir o boleto, LISTE as opções (vencimento e valor) e pergunte qual ele deseja. Após a escolha, chame a função enviar_segunda_via_boleto com os IDs correspondentes.\n'
          : '\nQuando o cliente pedir o boleto, chame a função enviar_segunda_via_boleto com os IDs deste boleto.\n'
      } else if (boletoSource === 'sgl') {
        // Clientes legados do SGL: o link de pagamento JÁ está na base — NÃO usar a 2ª via do Sienge
        customerContext += boletos.length > 1
          ? '\nOs boletos acima já possuem LINK de pagamento (no campo "Link para pagamento"). Quando o cliente pedir o boleto, LISTE as opções (vencimento e valor) e pergunte qual ele deseja; depois ENVIE o link correspondente diretamente no texto. NUNCA use a função enviar_segunda_via_boleto para estes boletos.\n'
          : '\nO boleto acima já possui LINK de pagamento (campo "Link para pagamento"). Quando o cliente pedir, ENVIE esse link diretamente no texto. NUNCA use a função enviar_segunda_via_boleto para este boleto.\n'
      }
    } else if (includeBoletos) {
      customerContext += '\nEste número ainda não possui boletos vinculados no sistema. ' +
        'Isso é NORMAL e NÃO é motivo para escalar. Cumprimente o cliente normalmente, ' +
        'pergunte com quem está falando (nome/CPF) e como pode ajudar. Só escale se o cliente ' +
        'pedir atendente ou se a situação realmente exigir (negociação, jurídico).\n'
    }

    // Cliente legado do SGL tem link direto → remover a ferramenta de 2ª via do Sienge
    if (boletoSource === 'sgl') {
      const i = openAiTools.findIndex((t: any) => t.function?.name === 'enviar_segunda_via_boleto')
      if (i >= 0) openAiTools.splice(i, 1)
    }

    if (customContext) {
      customerContext += `\nINFORMAÇÕES ADICIONAIS:\n${customContext}\n`
    }

    // Campos de atualização configurados — buscar valores atuais da conversa
    if (updateDefs.length > 0) {
      const { data: fullConv } = await supabase
        .from('chat_conversations')
        .select('*')
        .eq('id', conversationId)
        .single()

      const activeValues: string[] = []
      if (fullConv) {
        for (const def of updateDefs) {
          const colName = `cf_${def.key}`
          if (colName in fullConv && fullConv[colName] != null && fullConv[colName] !== '') {
            activeValues.push(`- ${def.name}: ${fullConv[colName]}`)
          }
        }
      }
      if (activeValues.length > 0) {
        customerContext += '\nCAMPOS DE STATUS DESTA CONVERSA:\n' + activeValues.join('\n') + '\n'
      }

      // Injetar instruções de atualização no contexto (quando usar cada campo)
      const instrucoes = updateDefs
        .filter((d: any) => d.description)
        .map((d: any) => {
          const opcoes = d.field_type === 'select' && d.options?.length
            ? ` (opções: ${d.options.join(', ')})`
            : ''
          return `- ${d.name}${opcoes}: ${d.description}`
        })
      if (instrucoes.length > 0) {
        customerContext +=
          '\nREGRAS PARA atualizar_conversa — use a função quando identificar estes dados:\n' +
          instrucoes.join('\n') + '\n'
      }
    }

    // ── 6c. Subagentes de TEXTO — consultam a base e injetam contexto ─────────
    if (agent?.id) {
      const { data: textSubs } = await supabase
        .from('chat_subagents')
        .select('*, datasources:chat_subagent_datasources(*)')
        .eq('agent_id', agent.id)
        .eq('trigger_type', 'text')
        .eq('is_active', true)
        .order('sort_order')

      for (const sub of textSubs || []) {
        const subVars = {
          contato: contactWaId, telefone: contactWaId, telefone_norm: normalizePhone(contactWaId),
          cpf: '', texto: lastUserText || '',
          now: new Date().toISOString(), hoje: new Date().toISOString().slice(0, 10),
        }
        const dsVars = await runSubagentDatasources(sub.datasources || [], subVars)
        // Operações de escrita configuradas (insert/update/upsert)
        await runWriteOpsText(sub.datasources || [], subVars)
        // Injeta cada placeholder preenchido + instruções do subagente
        let block = ''
        for (const [k, v] of Object.entries(dsVars)) {
          if (v) block += `\n${v}\n`
        }
        if (sub.instructions?.trim()) {
          block += '\n' + fillSubagentPlaceholders(sub.instructions, dsVars) + '\n'
        }
        if (block.trim()) {
          customerContext += `\n--- ${sub.name} ---\n${block}`
        }
      }
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
      console.log(`OpenAI → model=${model} tokens=${maxTokens} msgs=${openAiMessages.length} legacy=${legacyMessages.length} boleto_src=${boletoSource || 'none'} tools=${openAiTools.length}`)

      const openAiBody: any = {
        model,
        max_completion_tokens: maxTokens,
        temperature,
        messages: openAiMessages,
      }
      if (openAiTools.length > 0) {
        openAiBody.tools = openAiTools
      }

      const openAiResp = await fetch('https://api.openai.com/v1/chat/completions', {
        method:  'POST',
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(openAiBody),
      })

      if (!openAiResp.ok) {
        const errText = await openAiResp.text()
        console.error(`OpenAI ERRO ${openAiResp.status}:`, errText)
        botReply = 'Olá! Recebi sua mensagem. Nossa equipe está analisando e retornará em breve. 😊'
      } else {
        const openAiData = await openAiResp.json()
        const choice = openAiData.choices?.[0]

        // ── Tool calling ────────────────────────────────────────────────────
        if (choice?.finish_reason === 'tool_calls' && choice.message?.tool_calls?.length > 0) {
          const toolCall = choice.message.tool_calls[0]
          const toolName = toolCall.function.name
          const toolArgs = JSON.parse(toolCall.function.arguments || '{}')
          console.log(`Tool call: ${toolName}`, toolArgs)

          let toolResult = ''

          if (toolName === 'calcular_datas_pagamento') {
            const { d3, d5, d10 } = calcularDatasDisponiveis()
            toolResult = JSON.stringify({
              datas: [
                { label: formatarDataBR(d3),  iso: d3.toISOString().split('T')[0]  },
                { label: formatarDataBR(d5),  iso: d5.toISOString().split('T')[0]  },
                { label: formatarDataBR(d10), iso: d10.toISOString().split('T')[0] },
              ],
            })
          } else if (toolName === 'confirmar_agendamento') {
            const paymentTool = agentTools.find((t: any) => t.tool_type === 'payment_scheduler')
            toolResult = await handleConfirmarAgendamento(toolArgs, conv, contact, boletos, paymentTool)
          } else if (toolName === 'atualizar_conversa') {
            toolResult = await handleAtualizarConversa(toolArgs, conversationId, updateDefs)
          } else if (toolName === 'enviar_segunda_via_boleto') {
            const via = await siengeSegundaVia(toolArgs.receivable_bill_id, toolArgs.installment_id)
            if (via && (via.url || via.digitavel)) {
              let pdfOk = false
              if (via.url) {
                pdfOk = await enviarBoletoPDF(
                  phoneNumberId, accessToken, contactWaId, conversationId,
                  via.url, `Boleto ${toolArgs.receivable_bill_id}-${toolArgs.installment_id}`,
                  agent?.name, agent?.avatar_emoji,
                )
              }
              toolResult = JSON.stringify({
                sucesso: true, pdf_enviado: pdfOk,
                linha_digitavel: via.digitavel || null,
                instrucao: 'Confirme ao cliente que o boleto foi enviado e informe a linha digitável (se houver) para pagamento.',
              })
            } else {
              toolResult = JSON.stringify({ sucesso: false, erro: 'Não foi possível gerar a 2ª via agora. Peça para o cliente aguardar ou ofereça atendente.' })
            }
          } else if (apiToolFns[toolName]) {
            const apiTool   = apiToolFns[toolName]
            const cpfAttr   = Object.values(capturedAttrs).find((a: any) => a.fieldType === 'cpf_cnpj') as any
            const emailAttr = Object.values(capturedAttrs).find((a: any) => a.fieldType === 'email') as any
            const contactCtx = {
              wa_id:       contactWaId,
              telefone:    contactWaId,
              cpf:         cpfAttr ? String(cpfAttr.value).replace(/\D/g, '') : '',
              email:       emailAttr ? String(emailAttr.value) : '',
              customer_id: (boletos[0] as any)?.customer_id || capturedAttrs['sienge_customer_id']?.value || '',
            }
            const { data: apiCfg } = await supabase
              .from('chat_api_configs').select('*').eq('id', apiTool.config?.api_config_id).maybeSingle()
            if (!apiCfg) {
              toolResult = JSON.stringify({ ok: false, erro: 'Integração não configurada.' })
            } else {
              const r = await executeApiConfig(apiCfg, { variables: toolArgs, contact: contactCtx })
              let bodyStr = typeof r.body === 'string' ? r.body : JSON.stringify(r.body)
              if (bodyStr.length > 3000) bodyStr = bodyStr.slice(0, 3000) + '…'
              toolResult = JSON.stringify({
                ok: r.ok, status: r.status, resposta: bodyStr,
                instrucao: r.ok
                  ? 'Use os dados acima para responder o cliente de forma clara e curta (sem expor JSON).'
                  : 'A consulta falhou. Informe que houve um problema e ofereça falar com atendente.',
              })
            }
          }

          // Segunda chamada ao OpenAI com o resultado da ferramenta
          const messagesWithTool = [
            ...openAiMessages,
            choice.message,                          // mensagem com tool_calls
            {
              role:         'tool',
              tool_call_id: toolCall.id,
              content:      toolResult,
            },
          ]

          const finalResp = await fetch('https://api.openai.com/v1/chat/completions', {
            method:  'POST',
            headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model,
              max_completion_tokens: maxTokens,
              temperature,
              messages: messagesWithTool,
            }),
          })

          if (finalResp.ok) {
            const finalData = await finalResp.json()
            botReply = (finalData.choices?.[0]?.message?.content || '').trim()
            console.log(`OpenAI tool-result OK — resposta: ${botReply.substring(0, 80)}...`)
          } else {
            console.error('OpenAI second call error:', finalResp.status, await finalResp.text())
            botReply = 'Olá! Recebi sua mensagem. Nossa equipe está analisando e retornará em breve. 😊'
          }
        } else {
          // Resposta normal (sem tool call)
          botReply = (choice?.message?.content || '').trim()
          if (!botReply) {
            console.error('OpenAI retornou conteúdo vazio')
            botReply = 'Olá! Recebi sua mensagem. Nossa equipe está analisando e retornará em breve. 😊'
          } else {
            console.log(`OpenAI OK — resposta: ${botReply.substring(0, 80)}...`)
          }
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

    // ── 9b. Remover tokens internos antes de enviar ao cliente ─────────────────
    // Tokens como Atualiza_base_dados { ... } NUNCA devem chegar ao cliente.
    // São instruções internas do system prompt e devem ser filtradas aqui.
    function stripInternalTokens(text: string): string {
      return text
        // Remove tokens snake_case seguidos de { ... }
        // Padrão: palavra_com_underscore { ... }
        // Ex: Atualiza_base_dados { status: "encaminhado_financeiro", cw_status: "close" }
        .replace(/\b[A-Za-z][a-zA-Z0-9]*(?:_[a-zA-Z][a-zA-Z0-9]*)+\s*\{[^}]*\}\s*/g, '')
        .replace(/\n{3,}/g, '\n\n')   // colapsar múltiplas linhas vazias em excesso
        .trim()
    }

    // Usa o token formal → substitui pela mensagem amigável configurada
    // Usa frase do agente  → mantém a resposta original (já é amigável)
    // Em qualquer caso → filtra tokens internos que jamais devem ir ao cliente
    const rawMessage = botReply.includes('ESCALAR_HUMANO:')
      ? escalationMessage
      : botReply
    const messageToSend = stripInternalTokens(rawMessage)

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
      metadata:        { sent_by: 'bot', agent_id: agent?.id || null, agent_name: agent?.name || null, agent_emoji: agent?.avatar_emoji || null },
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

// ── Dias úteis (business days) ────────────────────────────────────────────────
function isDiaUtil(date: Date): boolean {
  return date.getDay() !== 0 && date.getDay() !== 6
}

function adicionarDiasUteis(data: Date, diasUteis: number): Date {
  const d = new Date(data)
  let count = 0
  while (count < diasUteis) {
    d.setDate(d.getDate() + 1)
    if (isDiaUtil(d)) count++
  }
  return d
}

function formatarDataBR(data: Date): string {
  return data.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
}

function calcularDatasDisponiveis(): { d3: Date; d5: Date; d10: Date } {
  const hoje = new Date()
  return {
    d3:  adicionarDiasUteis(hoje, 3),
    d5:  adicionarDiasUteis(hoje, 5),
    d10: adicionarDiasUteis(hoje, 10),
  }
}

// ── Confirmar agendamento de pagamento ────────────────────────────────────────
async function handleConfirmarAgendamento(
  args: { data_escolhida: string; observacoes?: string },
  conv: any,
  contact: any,
  boletos: any[],
  tool: any
): Promise<string> {
  try {
    // Parse DD/MM/YYYY → YYYY-MM-DD
    const parts = args.data_escolhida.split('/')
    if (parts.length !== 3) {
      return JSON.stringify({ success: false, error: 'Formato de data inválido. Use DD/MM/YYYY.' })
    }
    const [dd, mm, yyyy] = parts.map(Number)
    if (!dd || !mm || !yyyy) {
      return JSON.stringify({ success: false, error: 'Data inválida.' })
    }
    const scheduledDate = `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`

    const boleto = boletos[0] || null

    // 1. Salvar em chat_scheduled_payments
    const { data: payment, error: payErr } = await supabase
      .from('chat_scheduled_payments')
      .insert({
        conversation_id: conv.id,
        contact_id:      conv.contact_id,
        contact_name:    contact?.name   || null,
        contact_wa_id:   contact?.wa_id  || null,
        scheduled_date:  scheduledDate,
        boleto_parcela:  boleto?.parcela_descricao || null,
        boleto_valor:    boleto?.amount  || null,
        notes:           args.observacoes || null,
      })
      .select('id')
      .single()

    if (payErr || !payment) {
      console.error('Error saving scheduled payment:', payErr)
      return JSON.stringify({ success: false, error: 'Erro ao salvar agendamento.' })
    }

    // 2. Criar evento no Google Calendar (se api_connection configurada)
    let googleEventUrl: string | null = null
    const conn = tool?.api_connection
    if (conn?.provider === 'google_calendar' && conn.is_active) {
      const calendarId     = conn.config?.calendar_id
      const serviceAccount = conn.credentials
      if (calendarId && serviceAccount?.private_key) {
        const eventId = await criarEventoCalendario(serviceAccount, calendarId, {
          summary:     `Pagamento agendado — ${contact?.name || 'Cliente'}`,
          description: boleto
            ? `Parcela: ${boleto.parcela_descricao}\nValor: R$ ${Number(boleto.amount).toFixed(2)}\nCliente: ${contact?.name} (${contact?.wa_id})`
            : `Pagamento agendado via WhatsApp\nCliente: ${contact?.name || 'Desconhecido'} (${contact?.wa_id})`,
          startDate:   scheduledDate,
        })
        if (eventId) {
          googleEventUrl = `https://calendar.google.com/calendar/event?eid=${eventId}`
          await supabase
            .from('chat_scheduled_payments')
            .update({ google_event_id: eventId })
            .eq('id', payment.id)
        }
      }
    }

    // 3. Marcar conversa com payment_scheduled_id
    await supabase
      .from('chat_conversations')
      .update({ payment_scheduled_id: payment.id })
      .eq('id', conv.id)

    return JSON.stringify({
      success:          true,
      payment_id:       payment.id,
      scheduled_date:   args.data_escolhida,
      google_event_url: googleEventUrl,
    })
  } catch (err) {
    console.error('handleConfirmarAgendamento error:', err)
    return JSON.stringify({ success: false, error: String(err) })
  }
}

// ── Google Calendar — Service Account ────────────────────────────────────────
async function getGoogleAccessToken(serviceAccount: any): Promise<string | null> {
  try {
    const now = Math.floor(Date.now() / 1000)

    const encodeB64url = (s: string) =>
      btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')

    const header64  = encodeB64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    const payload64 = encodeB64url(JSON.stringify({
      iss:   serviceAccount.client_email,
      scope: 'https://www.googleapis.com/auth/calendar',
      aud:   'https://oauth2.googleapis.com/token',
      exp:   now + 3600,
      iat:   now,
    }))

    const signingInput = `${header64}.${payload64}`

    // Import RSA private key
    const pemBody = serviceAccount.private_key
      .replace('-----BEGIN PRIVATE KEY-----', '')
      .replace('-----END PRIVATE KEY-----', '')
      .replace(/\s/g, '')
    const binaryDer = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0))

    const cryptoKey = await crypto.subtle.importKey(
      'pkcs8',
      binaryDer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    )

    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      new TextEncoder().encode(signingInput)
    )

    const sig64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')

    const jwt = `${signingInput}.${sig64}`

    // Trocar JWT por access_token
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    })

    if (!tokenResp.ok) {
      console.error('Google token error:', tokenResp.status, await tokenResp.text())
      return null
    }

    const tokenData = await tokenResp.json()
    return tokenData.access_token || null
  } catch (err) {
    console.error('getGoogleAccessToken error:', err)
    return null
  }
}

async function criarEventoCalendario(
  serviceAccount: any,
  calendarId: string,
  evento: { summary: string; description: string; startDate: string }
): Promise<string | null> {
  try {
    const accessToken = await getGoogleAccessToken(serviceAccount)
    if (!accessToken) return null

    const resp = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          summary:     evento.summary,
          description: evento.description,
          start: { date: evento.startDate },   // evento de dia inteiro
          end:   { date: evento.startDate },
        }),
      }
    )

    if (!resp.ok) {
      console.error('Google Calendar create event error:', resp.status, await resp.text())
      return null
    }

    const data = await resp.json()
    console.log(`Google Calendar event created: ${data.id}`)
    return data.id || null
  } catch (err) {
    console.error('criarEventoCalendario error:', err)
    return null
  }
}

// ── Atualizar campos configuráveis da conversa ────────────────────────────────
async function handleAtualizarConversa(
  args:            Record<string, any>,
  conversationId:  string,
  updateDefs:      any[]
): Promise<string> {
  try {
    const updates: Record<string, any> = {}

    for (const [key, value] of Object.entries(args)) {
      // Aceitar SOMENTE chaves registradas nas definições (previne injeção de colunas)
      const def = updateDefs.find((d: any) => d.key === key)
      if (!def) {
        console.warn(`atualizar_conversa: campo "${key}" não está nas definições — ignorado`)
        continue
      }
      updates[`cf_${key}`] = value
    }

    if (Object.keys(updates).length === 0) {
      return JSON.stringify({ success: false, error: 'Nenhum campo válido para atualizar.' })
    }

    const { error } = await supabase
      .from('chat_conversations')
      .update(updates)
      .eq('id', conversationId)

    if (error) {
      console.error('handleAtualizarConversa error:', error)
      return JSON.stringify({ success: false, error: error.message })
    }

    const updatedKeys = Object.keys(updates)
    console.log(`atualizar_conversa: campos atualizados [${updatedKeys.join(', ')}] em conversa ${conversationId}`)
    return JSON.stringify({ success: true, updated: updatedKeys })
  } catch (err) {
    console.error('handleAtualizarConversa error:', err)
    return JSON.stringify({ success: false, error: String(err) })
  }
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
      // Parcela mais ANTIGA em aberto (a cobrar primeiro) — ordena por vencimento
      const openInst = ((await instResp.json()).results || [])
        .filter((i: any) => Number(i.balanceDue || 0) > 0)
        .sort((a: any, b: any) => String(a.dueDate || '').localeCompare(String(b.dueDate || '')))[0]
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
        parcela_descricao:  `${openInst.conditionTypeId || 'Parcela'} - ${openInst.installmentId}`,
        status:             'aberto',
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

// ── Subagentes de texto: consultar fontes de dados e preencher placeholders ───
function fillSubagentPlaceholders(tpl: string, vars: Record<string, string>): string {
  let out = tpl || ''
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, 'g'), v ?? '')
  }
  return out
}

function formatSubagentRows(name: string, rows: any[]): string {
  if (!rows.length) return `${name}: nenhum registro encontrado na base.`
  const lines = rows.map(r =>
    '- ' + Object.entries(r).map(([k, v]) => {
      const val = (v && typeof v === 'object') ? JSON.stringify(v) : (v ?? '—')
      return `${k}: ${val}`
    }).join(', ')
  )
  return `${name} (${rows.length}):\n${lines.join('\n')}`
}

async function runSubagentDatasources(
  datasources: any[],
  baseVars: Record<string, string>,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const ds of datasources || []) {
    if (ds.operation && ds.operation !== 'select') continue   // escrita roda em runWriteOpsText
    try {
      let filterVal = ds.filter_template || ''
      for (const [k, v] of Object.entries(baseVars)) {
        filterVal = filterVal.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, 'g'), v ?? '')
      }
      const looksNumeric = /^[\d.\-/()\s]+$/.test(filterVal)
      const cleanVal = looksNumeric ? filterVal.replace(/\D/g, '') : filterVal

      let q = supabase.from(ds.table_name).select(ds.columns || '*').limit(ds.max_rows || 5)
      if (ds.filter_column && cleanVal) q = q.eq(ds.filter_column, cleanVal)

      const { data: rows, error } = await q
      out[ds.output_placeholder] = error
        ? `${ds.name}: erro ao consultar (${error.message}).`
        : formatSubagentRows(ds.name, rows || [])
    } catch (e) {
      out[ds.output_placeholder] = `${ds.name}: falha na consulta.`
    }
  }
  return out
}

// Operações de ESCRITA dos subagentes de texto (insert/update/upsert)
function resolveTplText(tpl: string, vars: Record<string, string>): string {
  let out = String(tpl ?? '')
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, 'g'), v ?? '')
  }
  return out
}
async function runWriteOpsText(datasources: any[], baseVars: Record<string, string>): Promise<void> {
  for (const ds of datasources || []) {
    if (!ds.operation || ds.operation === 'select') continue
    try {
      const payload: Record<string, any> = {}
      for (const [col, valTpl] of Object.entries(ds.value_map || {})) {
        payload[col] = resolveTplText(String(valTpl), baseVars).trim()
      }
      const keyVal = ds.filter_column ? resolveTplText(ds.filter_template || '', baseVars).trim() : ''
      if (ds.operation === 'insert') {
        await supabase.from(ds.table_name).insert(payload)
      } else if (ds.operation === 'update') {
        if (!ds.filter_column || !keyVal) continue
        await supabase.from(ds.table_name).update(payload).eq(ds.filter_column, keyVal)
      } else if (ds.operation === 'upsert') {
        if (!ds.filter_column || !keyVal) continue
        await supabase.from(ds.table_name).upsert({ ...payload, [ds.filter_column]: keyVal }, { onConflict: ds.filter_column })
      }
    } catch (e) {
      console.error('runWriteOpsText error:', e)
    }
  }
}

// ── 2ª via do boleto no Sienge (link expira ~5min; linha digitável não) ───────
async function siengeSegundaVia(billId: number, instId: number): Promise<{ url: string; digitavel: string } | null> {
  try {
    const url = `${SIENGE_BASE}/payment-slip-notification?billReceivableId=${billId}&installmentId=${instId}`
    const r = await fetch(url, { headers: { Authorization: siengeAuth(), Accept: 'application/json' } })
    if (!r.ok) {
      console.error('siengeSegundaVia HTTP', r.status, await r.text().catch(() => ''))
      return null
    }
    const j = await r.json()
    const b = (j.results || [])[0] || {}
    return { url: b.urlReport || '', digitavel: b.digitableNumber || '' }
  } catch (e) {
    console.error('siengeSegundaVia error:', e)
    return null
  }
}

// ── Baixa o PDF da 2ª via, sobe no Storage e envia como documento ao cliente ──
async function enviarBoletoPDF(
  phoneNumberId: string, accessToken: string, waId: string, conversationId: string,
  pdfUrl: string, parcela: string,
  agentName?: string | null, agentEmoji?: string | null,
): Promise<boolean> {
  try {
    // 1. Baixar o PDF (dentro da validade do link)
    const pdfResp = await fetch(pdfUrl)
    if (!pdfResp.ok) { console.error('Falha ao baixar PDF da 2ª via:', pdfResp.status); return false }
    const pdfBytes = new Uint8Array(await pdfResp.arrayBuffer())

    // 2. Subir no Supabase Storage (URL permanente, também aparece no chat interno)
    const path = `chat/${conversationId}/boleto-${Date.now()}.pdf`
    const { error: upErr } = await supabase.storage
      .from('chat-media')
      .upload(path, pdfBytes, { contentType: 'application/pdf', upsert: true })
    if (upErr) { console.error('Storage upload PDF erro:', upErr.message); return false }
    const { data: { publicUrl } } = supabase.storage.from('chat-media').getPublicUrl(path)

    // 3. Enviar como documento via WhatsApp (por link → não precisa reupload)
    const filename = `Boleto ${parcela}.pdf`.replace(/[\/\\]/g, '-')
    const sendResp = await fetch(
      `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`,
      {
        method:  'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to:                waId,
          type:              'document',
          document:          { link: publicUrl, filename },
        }),
      }
    )
    if (!sendResp.ok) { console.error('WhatsApp send document erro:', await sendResp.text()); return false }
    const sendData    = await sendResp.json()
    const waMessageId = sendData.messages?.[0]?.id ?? null

    // 4. Registrar no histórico do chat
    await supabase.from('chat_messages').insert({
      conversation_id: conversationId,
      wa_message_id:   waMessageId,
      direction:       'out',
      type:            'document',
      content:         null,
      media_url:       publicUrl,
      media_mime_type: 'application/pdf',
      media_filename:  filename,
      wa_status:       'sent',
      metadata:        { sent_by: 'bot', kind: 'boleto_2via', agent_name: agentName || null, agent_emoji: agentEmoji || null },
    })
    return true
  } catch (e) {
    console.error('enviarBoletoPDF error:', e)
    return false
  }
}
