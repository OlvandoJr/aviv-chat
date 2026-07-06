import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { executeApiConfig } from '../_shared/apiExec.ts'
import {
  sendTemplateMessage,
  ensureConversation,
  normalizeWaId,
  type TemplateRow,
} from '../_shared/whatsapp.ts'

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

REGRA CRÍTICA: NUNCA inclua tokens internos (como Atualiza_base_dados, UPDATE_DB, ou qualquer instrução no formato token { ... }) na sua resposta ao cliente. Esses tokens são processados internamente e JAMAIS devem aparecer na mensagem enviada ao cliente.

DELEGAÇÃO: se uma tarefa de um especialista (função delegar_*) já estiver em andamento na conversa — por exemplo, uma coleta de dados em várias etapas (endereço, agendamento) — continue encaminhando ao MESMO especialista até concluir, em vez de responder por conta própria.`

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

    // ── 1a. DEBOUNCE ("espera, junta e responde") ─────────────────────────────
    // Cada mensagem do cliente aciona o ai-responder. Esperamos DEBOUNCE_MS e, se
    // tiver chegado mensagem NOVA do cliente nesse intervalo, abortamos — a invocação
    // da mensagem mais recente é que responde, lendo todo o histórico de uma vez.
    // (last-writer-wins; usa CONTAGEM de mensagens 'in' pra ser imune à precisão do timestamp.)
    {
      const DEBOUNCE_MS = 8000
      const inCount = async () => {
        const { count } = await supabase
          .from('chat_messages').select('id', { count: 'exact', head: true })
          .eq('conversation_id', conversationId).eq('direction', 'in')
        return count || 0
      }
      const before = await inCount()
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS))
      const after = await inCount()
      if (after > before) {
        return new Response(JSON.stringify({ skipped: true, reason: 'debounced (newer message arrived)' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
      // Humano pode ter assumido durante a espera → não responder por cima dele.
      const { data: fresh } = await supabase
        .from('chat_conversations').select('handled_by').eq('id', conversationId).single()
      if (fresh && (fresh.handled_by === 'human' || fresh.handled_by === 'pending_human')) {
        return new Response(JSON.stringify({ skipped: true, reason: 'human took over during debounce' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
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

    // ── 1c. Roteador de fluxos de subagente (gatilho + fluxo ativo) ───────────
    // Se a mensagem pertence a um fluxo de subagente (ex.: "Indique e Ganhe"),
    // ele responde e encerramos aqui — o bot de cobrança não entra.
    if (await routeSubagentFlow({ conversationId, conv, phoneNumberId, accessToken })) {
      return new Response(JSON.stringify({ ok: true, routed: 'subagent_flow' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
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

    // Tools para OpenAI. O agente principal é ORQUESTRADOR: NÃO expõe ferramentas
    // cruas — elas pertencem aos subagentes (ver §2d delegar_<slug>). Aqui ficam
    // apenas as delegações + os built-ins (atualizar_conversa, enviar_segunda_via_boleto).
    const openAiTools: any[] = []

    // ── 2d. Subagentes ON_DEMAND — expostos ao principal como delegar_<slug> ───
    // O agente principal é orquestrador: quando o cliente pede algo que é de um
    // especialista (ex.: agendar pagamento), ele chama delegar_<slug>. A execução
    // real (com prompt + ferramentas do subagente) acontece em runSubagent().
    const onDemandSubs: Record<string, any> = {}   // nome-da-função → subagente
    if (agent?.id) {
      const { data: subs } = await supabase
        .from('chat_subagents')
        .select('*')
        .eq('agent_id', agent.id)
        .eq('invocation', 'on_demand')
        .eq('is_active', true)
        .order('sort_order')
      for (const sub of subs || []) {
        let fn = 'delegar_' + String(sub.name || sub.id).toLowerCase()
          .normalize('NFD').replace(/[̀-ͯ]/g, '')
          .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)
        while (onDemandSubs[fn]) fn += '_'
        onDemandSubs[fn] = sub
        openAiTools.push({
          type: 'function',
          function: {
            name: fn,
            description:
              (sub.delegation_description || `Encaminhe ao especialista "${sub.name}".`) +
              ' Chame esta função (sem responder você mesmo) quando o pedido se encaixar; ' +
              'descreva no parâmetro "pedido" o que o cliente quer em uma frase.',
            parameters: {
              type: 'object',
              required: ['pedido'],
              properties: {
                pedido: { type: 'string', description: 'O que o cliente está pedindo, em uma frase curta.' },
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
            'Envia ao cliente o boleto (PDF como documento) e retorna a linha digitável para pagamento. ' +
            'Identifique o boleto escolhido pelo campo emitido_id da lista "BOLETOS CADASTRADOS" do contexto (preferido — é único mesmo quando dois boletos vencem no MESMO dia); use vencimento só como fallback. ' +
            'Se houver MAIS DE UM boleto em aberto (inclusive dois no mesmo vencimento), primeiro liste-os (parcela, vencimento e valor) e pergunte qual o cliente deseja — só chame esta função após o cliente escolher. ' +
            'Se houver apenas UM, pode chamar diretamente quando o cliente pedir o boleto. ' +
            'NUNCA ofereça pagar parcelas futuras/antecipação por aqui — para isso, escale para atendente.',
          parameters: {
            type: 'object',
            required: [],
            properties: {
              emitido_id:         { type: 'string', description: 'ID do boleto escolhido (campo emitido_id da lista). Use SEMPRE que disponível.' },
              vencimento:         { type: 'string', description: 'Fallback — vencimento do boleto no formato AAAA-MM-DD (campo vencimento_id da lista).' },
              receivable_bill_id: { type: 'number', description: 'Opcional — ID do título Sienge, se a lista exibir [IDs: ...].' },
              installment_id:     { type: 'number', description: 'Opcional — ID da parcela Sienge, se a lista exibir [IDs: ...].' },
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
      // Fonte PRIMÁRIA: boletos EMITIDOS no banco (lote de 2ª via) — valor real (com
      // juros/multa) + linha digitável + PDF no Storage. Sienge vira só fallback.
      const { data: emit } = await supabase
        .from('vw_boleto_chat')
        .select('emitido_id, client_id, customer_name, customer_cpf, parcela_descricao, due_date, amount, status, linha_digitavel, pdf_path, receivable_bill_id, installment_id')
        .eq('phone_norm', normalizePhone(contactWaId))
        .order('due_date', { ascending: true })
        .limit(10)
      if (emit && emit.length > 0) {
        boletos = emit.map((b: any) => ({ ...b, customer_id: b.client_id, source: 'emitido' }))
        boletoSource = 'emitido'
      } else {
        // Sem boleto emitido → tenta SGL (boleto com LINK real) ANTES das parcelas
        // Sienge. Cliente pode estar nas duas bases; sienge_boletos são só PARCELAS
        // (sem boleto gerado) e a 2ª via via Sienge falha — o SGL tem link de verdade.
        const sgl = await loadSglBoletos(contactWaId)
        if (sgl.length > 0) {
          boletos = sgl
          boletoSource = 'sgl'
        } else {
          // Último recurso: parcelas Sienge (2ª via via API, pode não ter boleto gerado)
          const { data } = await supabase
            .from('sienge_boletos')
            .select('parcela_descricao, due_date, amount, status, receivable_bill_id, installment_id')
            .eq('phone_norm', normalizePhone(contactWaId))
            .not('status', 'in', '("pago","cancelado")')
            .order('due_date', { ascending: true })
            .limit(10)
          boletos = data || []
          if (boletos.length > 0) boletoSource = 'sienge'
        }
      }
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

    // (5c) SGL agora é tentado no bloco 5, ANTES das parcelas Sienge — ver loadSglBoletos.

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

    // Boletos (emitido / Sienge / SGL)
    if (boletos.length > 0) {
      const sourceLabel = boletoSource === 'sgl' ? 'SGL' : boletoSource === 'emitido' ? 'Banco' : 'Sienge'
      customerContext += `\nBOLETOS CADASTRADOS (${sourceLabel}):\n`

      for (const b of boletos) {
        const vIso    = b.due_date ? String(b.due_date).slice(0, 10) : ''
        const dueDate = new Date(b.due_date).toLocaleDateString('pt-BR')
        const amount  = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(b.amount || 0)
        const statusLabel =
          b.status === 'pago'                ? '✅ Pago'                :
          b.status === 'comprovante_recebido' ? '📨 Comprovante recebido' :
          b.status === 'vencido'              ? '⚠️ Vencido'             :
          b.status === 'cancelado'            ? '❌ Cancelado'            :
                                               '🔵 Em aberto'

        // Identificador para a IA acionar a 2ª via: emitido → emitido_id (único por
        // boleto — vencimento fica ambíguo com 2 boletos no mesmo dia); Sienge → IDs
        const ids = boletoSource === 'emitido'
          ? ` [emitido_id=${(b as any).emitido_id}, vencimento_id=${vIso}]`
          : (b.receivable_bill_id && b.installment_id)
            ? ` [IDs: receivable_bill_id=${b.receivable_bill_id}, installment_id=${b.installment_id}]`
            : ''
        customerContext += `- ${b.parcela_descricao || 'Parcela'}: ${amount} | Vencimento: ${dueDate} | ${statusLabel}${ids}\n`

        // Incluir link do boleto no contexto (SGL sempre tem link)
        if (b.link_boleto) {
          customerContext += `  Link para pagamento: ${b.link_boleto}\n`
        }
      }

      // Instrução de uso conforme a origem do boleto
      if (boletoSource === 'emitido') {
        customerContext += boletos.length > 1
          ? '\nHá MAIS DE UM boleto em aberto. Quando o cliente pedir o boleto, LISTE as opções (vencimento e valor) e pergunte qual ele deseja. Após a escolha, chame enviar_segunda_via_boleto com o vencimento_id correspondente (AAAA-MM-DD). O sistema já tem o PDF e a linha digitável no banco — não invente valores.\n'
          : '\nQuando o cliente pedir o boleto, chame enviar_segunda_via_boleto com o vencimento_id deste boleto (AAAA-MM-DD). O sistema já tem o PDF e a linha digitável no banco.\n'
        customerContext += 'IMPORTANTE: ofereça SOMENTE o(s) boleto(s) acima (o do mês carregado). NÃO ofereça pagar parcelas futuras nem antecipação. Se o cliente quiser ANTECIPAR/QUITAR parcelas futuras, NÃO tente resolver — diga que vai encaminhar para um atendente e use ESCALAR_HUMANO.\n'

        // ── Gate de identidade (Fase 4) ──────────────────────────────────────
        // recentTpl = o disparo partiu de nós (template nas últimas 24h) → cliente já conhecido.
        // Sem template (mensagem avulsa) → confirmar nome completo + CPF ANTES de enviar o boleto.
        if (!recentTpl) {
          const confName = (boletos[0] as any)?.customer_name || ''
          const confCpf  = (boletos[0] as any)?.customer_cpf || ''
          customerContext += '\nVERIFICAÇÃO DE IDENTIDADE (mensagem avulsa — o cliente nos procurou): ' +
            'ANTES de enviar qualquer boleto, peça ao cliente o NOME COMPLETO e o CPF e confira com os dados do cadastro. ' +
            'NÃO envie o boleto enquanto não confirmar. NUNCA revele o nome ou o CPF do cadastro — o cliente é que deve informar. ' +
            'Se o nome informado bater com o cadastro (ignore acentos/maiúsculas; aceite nome contido) e, havendo CPF no cadastro, o CPF também bater, prossiga e envie o boleto. ' +
            'Se não bater após 2 tentativas, não envie e ofereça atendente (ESCALAR_HUMANO).\n' +
            `DADOS DO CADASTRO PARA CONFERÊNCIA (NÃO revele ao cliente): nome="${confName}"${confCpf ? `, cpf="${confCpf}"` : ' (CPF não disponível — confira só o nome)'}.\n`
        }
      } else if (boletoSource === 'sienge') {
        customerContext += boletos.length > 1
          ? '\nHá MAIS DE UM boleto em aberto. Quando o cliente pedir o boleto, LISTE as opções (vencimento e valor) e pergunte qual ele deseja. Após a escolha, chame a função enviar_segunda_via_boleto com os IDs correspondentes.\n'
          : '\nQuando o cliente pedir o boleto, chame a função enviar_segunda_via_boleto com os IDs deste boleto.\n'
      } else if (boletoSource === 'sgl') {
        // Clientes legados do SGL: o link de pagamento JÁ está na base — NÃO usar a 2ª via do Sienge.
        // Só a ÚLTIMA cobrança é oferecida (o SGL não manda baixa; as parcelas antigas
        // podem já estar pagas). Qualquer outra parcela → atendente humano.
        customerContext +=
          '\nO boleto acima já possui LINK de pagamento (campo "Link para pagamento"). Quando o cliente pedir, ENVIE esse link diretamente no texto. NUNCA use a função enviar_segunda_via_boleto para este boleto.\n' +
          'IMPORTANTE: ofereça SOMENTE o boleto acima (a última cobrança enviada — o boleto do mês). ' +
          'Se o cliente quiser pagar OUTRA parcela (atrasada ou futura), antecipar, quitar ou negociar, NÃO tente resolver e NÃO invente valores ou links — ' +
          'diga que vai encaminhar para um atendente e use ESCALAR_HUMANO: cliente quer tratar de outras parcelas (SGL).\n'
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
        .eq('invocation', 'auto_context')   // só os que injetam contexto a cada mensagem (não os on_demand)
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
          let delegated  = false   // delegamos a um subagente → usamos a resposta dele direto

          if (onDemandSubs[toolName]) {
            // Delegação ao subagente especialista: roda o loop dele (prompt +
            // ferramentas próprias) e usa a resposta diretamente — preserva a
            // redação e a eventual escalação do especialista.
            delegated = true
            botReply = await runSubagent(onDemandSubs[toolName], {
              conv, contact, contactWaId, boletos, capturedAttrs,
              phoneNumberId, accessToken, conversationId,
              history, customerContext,
              pedido: (toolArgs?.pedido as string) || lastUserText,
              fallbackModel: model, temperature, maxTokens,
            })
          } else if (toolName === 'atualizar_conversa') {
            toolResult = await handleAtualizarConversa(toolArgs, conversationId, updateDefs)
          } else if (toolName === 'enviar_segunda_via_boleto') {
            toolResult = await handleEnviarBoleto(
              toolArgs, boletos, phoneNumberId, accessToken, contactWaId, conversationId,
              agent?.name, agent?.avatar_emoji,
            )
          }

          // Segunda chamada ao OpenAI com o resultado da ferramenta.
          // Pulada quando delegamos — a resposta do especialista já está em botReply.
          if (!delegated) {
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

    // O modelo às vezes emite os campos de atualização como TEXTO JSON em vez de
    // chamar a tool atualizar_conversa — ex.: {"status_cobranca":"comprovante_confirmado"}.
    // Esse JSON vazava para o cliente. Aqui: aplica a intenção (reuso de
    // handleAtualizarConversa) e remove o bloco da mensagem. Reconhece um objeto
    // {…} (chaves citadas ou não) que contenha alguma chave interna conhecida.
    const internalKeys = new Set<string>([
      ...updateDefs.map((d: any) => String(d.key)),
      'status', 'cw_status', 'status_cobranca',
    ])
    async function stripInternalJson(text: string): Promise<string> {
      let out = text
      for (const m of (text.match(/\{[^{}]*\}/g) || [])) {
        if (![...internalKeys].some(k => m.includes(k))) continue
        try {
          const parsed = JSON.parse(m)
          if (parsed && typeof parsed === 'object') {
            await handleAtualizarConversa(parsed, conversationId, updateDefs)
          }
        } catch { /* pseudo-JSON (chaves sem aspas): só remove */ }
        out = out.replace(m, '')
      }
      return out.replace(/\n{3,}/g, '\n\n').trim()
    }

    // Usa o token formal → substitui pela mensagem amigável configurada
    // Usa frase do agente  → mantém a resposta original (já é amigável)
    // Em qualquer caso → filtra tokens internos que jamais devem ir ao cliente
    const rawMessage = botReply.includes('ESCALAR_HUMANO:')
      ? escalationMessage
      : botReply
    let messageToSend = await stripInternalJson(stripInternalTokens(rawMessage))
    // Salvaguarda: se sobrou só o token (mensagem vazia), não manda balão vazio
    if (!messageToSend) {
      console.warn('ai-responder: resposta vazia após remover tokens internos — nada enviado', { conversationId })
      return new Response(JSON.stringify({ ok: true, skipped: 'resposta vazia após sanitização', escalated: shouldEscalate }),
        { headers: { 'Content-Type': 'application/json' } })
    }

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

// ── Carrega o(s) boleto(s) SGL (mensagens_cobranca) do cliente, deduplicado por ──
// parcela. Boleto SGL tem LINK real de pagamento → preferido sobre parcelas Sienge.
async function loadSglBoletos(waId: string): Promise<any[]> {
  if (!waId) return []
  const cols = 'id, pessoanomecompleto, unidadeempreendimento, unidadequadraandar, unidadeloteapartamento, contasreceberparcela, contasrecebervencimento, contasrecebervalor, linkboleto, status, created_at'
  let { data } = await supabase.from('mensagens_cobranca').select(cols)
    .eq('phone_norm', normalizePhone(waId)).order('created_at', { ascending: false }).limit(20)
  let rows = data || []
  if (rows.length === 0) {
    const { data: exact } = await supabase.from('mensagens_cobranca').select(cols)
      .eq('phone', waId).order('created_at', { ascending: false }).limit(20)
    rows = exact || []
  }
  if (rows.length === 0) return []
  const seen = new Set<string>()
  const uniq: any[] = []
  for (const b of rows) {
    const k = b.contasreceberparcela || String(b.id)
    if (seen.has(k)) continue
    seen.add(k); uniq.push(b)
  }
  // mensagens_cobranca é um LOG de cobranças, não um extrato: o SGL não manda
  // baixa — parcela paga simplesmente PARA de ser cobrada, e as linhas antigas
  // ficam com status de "aberta" para sempre. Enquanto não houver baixa
  // automática do SGL, o bot oferece SOMENTE a ÚLTIMA cobrança enviada (o
  // boleto do mês); outras parcelas → escalar para humano (instrução no prompt).
  return uniq.slice(0, 1).map((b: any) => ({
    parcela_descricao: [
      b.contasreceberparcela, b.unidadeempreendimento,
      [b.unidadequadraandar, b.unidadeloteapartamento].filter(Boolean).join(' — '),
    ].filter(Boolean).join(' | '),
    due_date:    b.contasrecebervencimento,
    amount:      parseSglAmount(b.contasrecebervalor),
    status:      mapSglStatus(b.status),
    link_boleto: b.linkboleto,
    source:      'sgl',
  }))
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

// Regras do agendador (editáveis no config da ferramenta payment_scheduler).
function schedulerRules(config: any): { offsets: number[]; maxOffsetDays: number; maxReschedules: number } {
  const offsets: number[] = Array.isArray(config?.business_day_offsets) && config.business_day_offsets.length
    ? config.business_day_offsets.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n) && n > 0)
    : [3, 5, 10]
  const maxOffsetDays  = Number(config?.max_offset_days) > 0 ? Number(config.max_offset_days) : Math.max(...offsets)
  const maxReschedules = Number(config?.max_reschedules) > 0 ? Number(config.max_reschedules) : 99
  return { offsets, maxOffsetDays, maxReschedules }
}

// Datas oferecidas ao cliente, conforme os offsets (dias úteis) do config.
function calcularDatasDisponiveis(config?: any): { datas: { label: string; iso: string }[] } {
  const { offsets } = schedulerRules(config)
  const hoje = new Date()
  const datas = offsets.map((off) => {
    const d = adicionarDiasUteis(hoje, off)
    return { label: formatarDataBR(d), iso: d.toISOString().split('T')[0] }
  })
  return { datas }
}

// ── Loop do subagente especialista (delegação on_demand) ──────────────────────
// Roda um ciclo de OpenAI com o prompt e as FERRAMENTAS do próprio subagente,
// reaproveitando os handlers já existentes. Retorna o texto a enviar ao cliente
// (pode conter ESCALAR_HUMANO:, que a escalação do fluxo principal detecta).
// deno-lint-ignore no-explicit-any
async function runSubagent(sub: any, ctx: any): Promise<string> {
  if (!OPENAI_API_KEY) return sub.escalation_message || 'Vou te encaminhar para um atendente. 🙏'

  // 1. Ferramentas do subagente
  const { data: subTools } = await supabase
    .from('chat_agent_tools')
    .select('*, api_connection:chat_api_connections(*)')
    .eq('subagent_id', sub.id)
    .eq('is_active', true)
    .order('sort_order')

  const tools: any[] = []
  const apiFns: Record<string, any> = {}
  const msgFns: Record<string, any> = {}
  let schedulerTool: any = null

  for (const t of subTools || []) {
    if (t.tool_type === 'payment_scheduler') {
      schedulerTool = t
      tools.push({ type: 'function', function: {
        name: 'calcular_datas_pagamento',
        description: 'Calcula as datas úteis disponíveis para o cliente agendar o pagamento do boleto.',
        parameters: { type: 'object', properties: {} },
      } })
      tools.push({ type: 'function', function: {
        name: 'confirmar_agendamento',
        description: 'Registra o agendamento do pagamento para a data escolhida pelo cliente (uma das datas oferecidas).',
        parameters: {
          type: 'object', required: ['data_escolhida'],
          properties: {
            data_escolhida: { type: 'string', description: 'Data escolhida no formato DD/MM/YYYY' },
            observacoes:    { type: 'string', description: 'Observações adicionais do cliente (opcional)' },
          },
        },
      } })
    } else if (t.tool_type === 'api_call') {
      const cfg = t.config || {}
      let fn = 'api_' + String(t.name || t.id).toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48)
      while (apiFns[fn]) fn += '_'
      const properties: Record<string, any> = {}
      const required: string[] = []
      for (const p of (cfg.parameters || [])) {
        if (!p?.name) continue
        properties[p.name] = { type: p.type || 'string', description: p.description || '' }
        if (p.required) required.push(p.name)
      }
      apiFns[fn] = t
      tools.push({ type: 'function', function: {
        name: fn, description: t.description || t.name || 'Chama uma integração externa.',
        parameters: { type: 'object', properties, required },
      } })
    } else if (t.tool_type === 'send_message') {
      // Ferramenta de MENSAGEM: notifica um terceiro (ex.: o corretor) por WhatsApp.
      const cfg = t.config || {}
      let fn = 'msg_' + String(t.name || t.id).toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48)
      while (msgFns[fn] || apiFns[fn]) fn += '_'
      const properties: Record<string, any> = {}
      const required: string[] = []
      for (const p of (cfg.parameters || [])) {
        if (!p?.name) continue
        properties[p.name] = { type: p.type || 'string', description: p.description || '' }
        if (p.required) required.push(p.name)
      }
      msgFns[fn] = t
      tools.push({ type: 'function', function: {
        name: fn, description: t.description || t.name || 'Envia uma mensagem WhatsApp para um destinatário.',
        parameters: { type: 'object', properties, required },
      } })
    }
  }

  // 2. Prompt + contexto + histórico recente
  const today = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
  const sys = (sub.instructions || '')
    + `\n\nHoje é ${today}.`
    + (ctx.customerContext ? `\n\n--- DADOS DO CLIENTE ---\n${ctx.customerContext}` : '')
    + (ctx.pedido ? `\n\nO cliente está pedindo: ${ctx.pedido}` : '')

  const messages: any[] = [{ role: 'system', content: sys }]
  for (const m of (ctx.history || [])) {
    const role = m.direction === 'in' ? 'user' : 'assistant'
    const content = m.content || ''
    if (content) messages.push({ role, content })
  }
  if (!messages.some((m: any) => m.role === 'user')) {
    messages.push({ role: 'user', content: ctx.pedido || 'Olá' })
  }

  const model = sub.model || ctx.fallbackModel || 'gpt-4o-mini'

  // 3. Loop de tool-calls (até 4 rodadas)
  for (let round = 0; round < 4; round++) {
    const body: any = { model, max_completion_tokens: ctx.maxTokens, temperature: ctx.temperature, messages }
    if (tools.length) { body.tools = tools; body.tool_choice = 'auto' }

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!resp.ok) {
      console.error(`runSubagent(${sub.name}) OpenAI ${resp.status}:`, await resp.text())
      return sub.escalation_message || 'Vou te encaminhar para um atendente. 🙏'
    }
    const choice = (await resp.json()).choices?.[0]

    if (choice?.finish_reason === 'tool_calls' && choice.message?.tool_calls?.length > 0) {
      messages.push(choice.message)
      for (const tc of choice.message.tool_calls) {
        const name = tc.function.name
        const args = JSON.parse(tc.function.arguments || '{}')
        let result = ''

        if (name === 'calcular_datas_pagamento') {
          result = JSON.stringify(calcularDatasDisponiveis(schedulerTool?.config))
        } else if (name === 'confirmar_agendamento') {
          result = await handleConfirmarAgendamento(args, ctx.conv, ctx.contact, ctx.boletos, schedulerTool)
          // Regra excedida → escala de forma determinística (não depende do modelo).
          try {
            const parsed = JSON.parse(result)
            if (parsed?.escalate) return `ESCALAR_HUMANO: ${parsed.reason || 'agendamento fora das regras'}`
          } catch { /* ignore */ }
        } else if (apiFns[name]) {
          const apiTool = apiFns[name]
          const cpfAttr   = Object.values(ctx.capturedAttrs || {}).find((a: any) => a.fieldType === 'cpf_cnpj') as any
          const emailAttr = Object.values(ctx.capturedAttrs || {}).find((a: any) => a.fieldType === 'email') as any
          const contactCtx = {
            wa_id:       ctx.contactWaId,
            telefone:    ctx.contactWaId,
            cpf:         cpfAttr ? String(cpfAttr.value).replace(/\D/g, '') : '',
            email:       emailAttr ? String(emailAttr.value) : '',
            customer_id: (ctx.boletos?.[0] as any)?.customer_id || ctx.capturedAttrs?.['sienge_customer_id']?.value || '',
          }
          const { data: apiCfg } = await supabase
            .from('chat_api_configs').select('*').eq('id', apiTool.config?.api_config_id).maybeSingle()
          if (!apiCfg) {
            result = JSON.stringify({ ok: false, erro: 'Integração não configurada.' })
          } else {
            const r = await executeApiConfig(apiCfg, { variables: args, contact: contactCtx })
            let bodyStr = typeof r.body === 'string' ? r.body : JSON.stringify(r.body)
            if (bodyStr.length > 3000) bodyStr = bodyStr.slice(0, 3000) + '…'
            result = JSON.stringify({ ok: r.ok, status: r.status, resposta: bodyStr })
          }
          markTerminal(ctx, sub, apiFns[name], result)
        } else if (msgFns[name]) {
          result = JSON.stringify(await executeSendMessage(msgFns[name].config || {}, args, {
            inboxId: ctx.conv?.inbox_id,
            phoneNumberId: ctx.phoneNumberId,
            accessToken: ctx.accessToken,
            clientWaId: ctx.contactWaId,
          }))
          markTerminal(ctx, sub, msgFns[name], result)
        } else {
          result = JSON.stringify({ ok: false, erro: 'ferramenta desconhecida' })
        }
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result })
      }
      continue
    }

    // Resposta final do especialista
    const reply = (choice?.message?.content || '').trim()
    if (reply) return reply
    break
  }
  return sub.escalation_message || 'Vou te encaminhar para um atendente para tratar isso. 🙏'
}

// ── Roteador de fluxos de subagente (gatilho determinístico + fluxo ativo) ─────
// Antes do bot principal, decide se a mensagem pertence a um FLUXO de subagente
// (ex.: resposta de campanha "Indique e Ganhe"). Se sim, roda o subagente com a
// mesma engine do delegar_ e encerra — o principal (cobrança) não responde.
async function routeSubagentFlow(env: {
  conversationId: string; conv: any; phoneNumberId: string; accessToken: string;
}): Promise<boolean> {
  const { conversationId, conv } = env

  const { data: inMsg } = await supabase
    .from('chat_messages').select('type, content')
    .eq('conversation_id', conversationId).eq('direction', 'in')
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (!inMsg) return false
  const text = String(inMsg.content || '').trim()

  // 1) Fluxo já ativo nesta conversa? → roda o subagente dono do fluxo.
  let sub: any = null
  const { data: flow } = await supabase
    .from('chat_active_flows').select('subagent_id, status')
    .eq('conversation_id', conversationId).eq('status', 'active').maybeSingle()
  if (flow) {
    const { data } = await supabase.from('chat_subagents')
      .select('*').eq('id', flow.subagent_id).eq('is_active', true).maybeSingle()
    if (!data) {
      await supabase.from('chat_active_flows').update({ status: 'done' }).eq('conversation_id', conversationId)
      return false
    }
    sub = data
  } else {
    // 2) Gatilho de início (resposta de campanha com reply_flow).
    sub = await matchTriggerSubagent(conversationId, inMsg)
    if (!sub) return false
    await supabase.from('chat_active_flows').upsert({
      conversation_id: conversationId, subagent_id: sub.id, status: 'active',
      updated_at: new Date().toISOString(),
    })
  }

  // 3) Executa o subagente (engine configurável — mesmas ferramentas do subagente).
  const { data: contact } = await supabase.from('chat_contacts').select('*').eq('id', conv.contact_id).maybeSingle()
  const contactWaId = normalizeWaId(contact?.wa_id || '') || String(contact?.wa_id || '')
  const { data: hist } = await supabase.from('chat_messages')
    .select('direction, content').eq('conversation_id', conversationId)
    .order('created_at', { ascending: false }).limit(16)

  const ctx: any = {
    conv, contact, contactWaId, boletos: [], capturedAttrs: {},
    phoneNumberId: env.phoneNumberId, accessToken: env.accessToken, conversationId,
    history: (hist || []).reverse(), customerContext: '', pedido: text,
    fallbackModel: sub.model || 'gpt-4o-mini', temperature: Number(sub.temperature ?? 0.3), maxTokens: 700,
  }
  let reply = await runSubagent(sub, ctx)

  if (typeof reply === 'string' && reply.startsWith('ESCALAR_HUMANO')) {
    await supabase.from('chat_conversations').update({ handled_by: 'pending_human' }).eq('id', conversationId)
    await supabase.from('chat_active_flows').update({ status: 'done', updated_at: new Date().toISOString() }).eq('conversation_id', conversationId)
    reply = sub.escalation_message || 'Vou te encaminhar para um de nossos atendentes. 🙏'
  } else if (ctx._terminalDone) {
    // A ferramenta terminal (ex.: notificar corretor) rodou → fluxo concluído.
    await supabase.from('chat_active_flows').update({ status: 'done', updated_at: new Date().toISOString() }).eq('conversation_id', conversationId)
  }

  if (reply) {
    await sendPlainText(
      { phone_number_id: env.phoneNumberId, access_token: env.accessToken },
      contactWaId, reply, conversationId,
    )
  }
  return true
}

// Acha um subagente cujo GATILHO casa com a resposta de campanha desta conversa.
async function matchTriggerSubagent(conversationId: string, inMsg: any): Promise<any | null> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const { data: tmsg } = await supabase.from('chat_messages')
    .select('metadata').eq('conversation_id', conversationId)
    .eq('direction', 'out').eq('type', 'template')
    .gte('created_at', since).order('created_at', { ascending: false }).limit(1).maybeSingle()
  const campaignId = tmsg?.metadata?.campaign_id
  if (!campaignId) return null
  const { data: camp } = await supabase.from('chat_campaigns').select('reply_flow').eq('id', campaignId).maybeSingle()
  const replyFlow = camp?.reply_flow
  if (!replyFlow) return null

  const { data: subs } = await supabase.from('chat_subagents')
    .select('*').eq('is_active', true).not('trigger', 'is', null)
  const content = String(inMsg.content || '').toLowerCase()
  for (const s of subs || []) {
    const trg = s.trigger || {}
    if (trg.kind !== 'campaign_reply') continue
    if (trg.reply_flow && trg.reply_flow !== replyFlow) continue
    const buttons: string[] = Array.isArray(trg.buttons) ? trg.buttons : []
    if (inMsg.type === 'button' && (buttons.length === 0 || buttons.some((b) => content.includes(String(b).toLowerCase())))) {
      return s
    }
  }
  return null
}

// Marca o fluxo como concluído quando a ferramenta TERMINAL do subagente roda com ok.
function markTerminal(ctx: any, sub: any, tool: any, resultJson: string) {
  if (!sub?.terminal_tool || !tool?.name || tool.name !== sub.terminal_tool) return
  try { if (JSON.parse(resultJson)?.ok) ctx._terminalDone = true } catch { /* ignore */ }
}

// Ferramenta send_message: envia template/texto WhatsApp a um destinatário (3º).
async function executeSendMessage(
  cfg: any, args: Record<string, any>,
  env: { inboxId: string | null; phoneNumberId: string; accessToken: string; clientWaId: string },
): Promise<{ ok: boolean; erro?: string; status?: number }> {
  if (!env.inboxId) return { ok: false, erro: 'sem inbox' }
  const to = normalizeWaId(String(args[cfg.to_param || 'telefone'] || ''))
  if (!to || to.length < 12) return { ok: false, erro: 'telefone do destinatário inválido' }

  const special: Record<string, string> = { cliente_telefone: formatBrPhone(env.clientWaId) }

  const conv = await ensureConversation(
    supabase, env.inboxId, to, String(args[cfg.name_param || 'nome'] || '') || undefined, null,
  )
  if (!conv) return { ok: false, erro: 'falha ao criar conversa do destinatário' }
  // Destinatário é interno (corretor) → atendimento humano, o bot não responde por cima.
  await supabase.from('chat_conversations').update({ handled_by: 'human' }).eq('id', conv.conversationId)

  const inbox = { phone_number_id: env.phoneNumberId, access_token: env.accessToken }

  if ((cfg.message_type || 'template') === 'text') {
    const body = interpolate(String(cfg.text || ''), { ...args, ...special })
    return { ok: await sendPlainText(inbox, to, body, conv.conversationId) }
  }

  const { data: tpl } = await supabase
    .from('chat_wa_templates')
    .select('id, name, language, header_text, header_var_count, body_var_count, body_text, header_type')
    .eq('inbox_id', env.inboxId).eq('name', cfg.template_name).eq('status', 'APPROVED')
    .limit(1).maybeSingle()
  if (!tpl) return { ok: false, erro: `template "${cfg.template_name}" não aprovado nesta inbox` }

  const variables = (cfg.variables || []).map((v: string) =>
    special[v] !== undefined ? special[v] : String(args[v] ?? ''))

  const res = await sendTemplateMessage({
    admin: supabase, inbox, toWaId: to, tpl: tpl as TemplateRow,
    variables, conversationId: conv.conversationId,
    metaExtra: { via: 'send_message', cliente_wa: env.clientWaId },
  })
  return { ok: res.ok, status: res.ok ? 200 : undefined }
}

async function sendPlainText(
  inbox: { phone_number_id: string; access_token: string },
  to: string, body: string, conversationId: string,
): Promise<boolean> {
  let waMessageId: string | null = null
  const resp = await fetch(`https://graph.facebook.com/v20.0/${inbox.phone_number_id}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${inbox.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
  })
  if (resp.ok) waMessageId = (await resp.json()).messages?.[0]?.id || null
  else { console.error('sendPlainText erro', resp.status, await resp.text().catch(() => '')); return false }
  await supabase.from('chat_messages').insert({
    conversation_id: conversationId, wa_message_id: waMessageId, direction: 'out', type: 'text',
    content: body, metadata: { sent_by: 'bot', via: 'send_message' },
  })
  await supabase.from('chat_conversations').update({
    last_message_at: new Date().toISOString(), last_message_preview: body.slice(0, 120),
  }).eq('id', conversationId)
  return true
}

function interpolate(tpl: string, vars: Record<string, any>): string {
  return tpl.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, k) => String(vars[k] ?? ''))
}

function formatBrPhone(wa: string): string {
  const d = String(wa || '').replace(/\D/g, '')
  const local = d.startsWith('55') ? d.slice(2) : d
  if (local.length < 10) return '+' + d
  const ddd = local.slice(0, 2), num = local.slice(2)
  const meio = num.length === 9 ? num.slice(0, 5) : num.slice(0, 4)
  const fim = num.length === 9 ? num.slice(5) : num.slice(4)
  return `+55 (${ddd}) ${meio}-${fim}`
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

    // ── Regras configuráveis: prazo máximo + limite de reagendamentos ─────────
    const { maxOffsetDays, maxReschedules } = schedulerRules(tool?.config)
    const hoje    = new Date()
    const todayIso = hoje.toISOString().split('T')[0]
    const maxIso   = adicionarDiasUteis(hoje, maxOffsetDays).toISOString().split('T')[0]

    if (scheduledDate < todayIso) {
      return JSON.stringify({ success: false, error: 'A data escolhida está no passado. Peça uma data dentro das opções oferecidas.' })
    }
    if (scheduledDate > maxIso) {
      return JSON.stringify({
        success: false, escalate: true,
        reason: `cliente quer agendar para ${args.data_escolhida}, além do prazo máximo permitido (até ${formatarDataBR(adicionarDiasUteis(hoje, maxOffsetDays))})`,
      })
    }

    // Limite de agendamentos por contato (ignora cancelados)
    const { count: jaAgendados } = await supabase
      .from('chat_scheduled_payments')
      .select('id', { count: 'exact', head: true })
      .eq('contact_id', conv.contact_id)
      .neq('status', 'cancelado')
    if ((jaAgendados || 0) >= maxReschedules) {
      return JSON.stringify({
        success: false, escalate: true,
        reason: `cliente já possui ${jaAgendados} agendamento(s) — atingiu o limite de ${maxReschedules}`,
      })
    }

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

// ── Normaliza "20/06/2026" | "2026-06-20" → "2026-06-20" ──────────────────────
function toISODateStr(v: unknown): string {
  const s = String(v ?? '').trim()
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/)
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` }
  return s
}

// ── Envia o boleto ao cliente: PRIMEIRO do banco (boleto emitido: PDF no Storage
// + linha digitável), e só usa o Sienge (2ª via) como fallback quando não há
// boleto emitido carregado. Resolve o alvo por vencimento ou pelos IDs do Sienge.
async function handleEnviarBoleto(
  args: any, boletos: any[],
  phoneNumberId: string, accessToken: string, waId: string, conversationId: string,
  agentName?: string | null, agentEmoji?: string | null,
): Promise<string> {
  // 1. Resolver qual boleto o cliente escolheu (emitido_id primeiro — único por
  // boleto, funciona mesmo com 2 boletos no mesmo vencimento)
  let target: any = null
  if (args.emitido_id) {
    target = boletos.find((b) => String(b.emitido_id) === String(args.emitido_id))
  }
  if (!target && args.receivable_bill_id && args.installment_id) {
    target = boletos.find((b) =>
      Number(b.receivable_bill_id) === Number(args.receivable_bill_id) &&
      Number(b.installment_id) === Number(args.installment_id))
  }
  if (!target && args.vencimento) {
    const v = toISODateStr(args.vencimento)
    target = boletos.find((b) => String(b.due_date).slice(0, 10) === v)
  }
  if (!target && boletos.length === 1) target = boletos[0]
  if (!target) {
    return JSON.stringify({ sucesso: false, erro: 'Não identifiquei qual boleto. Liste os boletos (vencimento e valor) e peça para o cliente escolher.' })
  }

  const parcela = target.parcela_descricao || 'Boleto'

  // 2. Boleto EMITIDO no banco → PDF do Storage + linha digitável (sem tocar no Sienge)
  if (target.pdf_path || target.linha_digitavel) {
    let pdfOk = false
    if (target.pdf_path) {
      const { data: signed } = await supabase.storage.from('boletos').createSignedUrl(target.pdf_path, 600)
      if (signed?.signedUrl) {
        pdfOk = await enviarBoletoPDF(phoneNumberId, accessToken, waId, conversationId, signed.signedUrl, parcela, agentName, agentEmoji)
      }
    }
    return JSON.stringify({
      sucesso: true, pdf_enviado: pdfOk,
      linha_digitavel: target.linha_digitavel || null,
      instrucao: 'Confirme ao cliente que o boleto foi enviado em PDF e informe a linha digitável para pagamento.',
    })
  }

  // 3. Fallback Sienge (cliente sem boleto emitido carregado)
  if (target.receivable_bill_id && target.installment_id) {
    const via = await siengeSegundaVia(target.receivable_bill_id, target.installment_id)
    if (via && (via.url || via.digitavel)) {
      let pdfOk = false
      if (via.url) pdfOk = await enviarBoletoPDF(phoneNumberId, accessToken, waId, conversationId, via.url, parcela, agentName, agentEmoji)
      return JSON.stringify({
        sucesso: true, pdf_enviado: pdfOk,
        linha_digitavel: via.digitavel || null,
        instrucao: 'Confirme ao cliente que o boleto foi enviado e informe a linha digitável para pagamento.',
      })
    }
  }
  return JSON.stringify({ sucesso: false, erro: 'Não foi possível enviar o boleto agora. Ofereça atendente.' })
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
    // URL ASSINADA p/ a Meta buscar o documento (bucket privado).
    const { data: signed } = await supabase.storage.from('chat-media').createSignedUrl(path, 3600)
    const sendLink = signed?.signedUrl || publicUrl

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
          document:          { link: sendLink, filename },
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
