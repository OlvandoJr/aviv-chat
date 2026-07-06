'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import {
  ArrowLeft, Save, Bot, Cpu, MessageSquare, Database,
  AlertTriangle, GitBranch, Star, Trash2, Plus, X, Tags, Wrench, RefreshCw, Plug,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type {
  Agent, AgentModel, AgentRule, AgentRuleType, Inbox,
  ContactAttributeDef, AttributeFieldType, AttributeAction,
  AgentTool, ApiConnection, ConversationUpdateDef, UpdateFieldType,
  Subagent, SubagentTrigger, SubagentInvocation,
} from '@/lib/types'
import ToolEditor from './ToolEditor'

interface Props {
  agent:           Agent | null
  rules:           AgentRule[]
  inboxes:         Inbox[]
  availableModels: string[]
  attrDefs:        ContactAttributeDef[]
  tools:           AgentTool[]
  apiConnections:  ApiConnection[]
  updateDefs:      ConversationUpdateDef[]
  subagents:       Subagent[]
}

interface DatasourceDraft {
  id?:                string
  connection_id:      string | null
  name:               string
  operation:          'select' | 'insert' | 'update' | 'upsert'
  table_name:         string
  filter_column:      string
  filter_template:    string
  value_map:          { col: string; val: string }[]   // editor de coluna=valor (escrita)
  columns:            string
  max_rows:           number
  output_placeholder: string
}

interface SubagentDraft {
  id?:               string
  name:              string
  trigger_type:      SubagentTrigger
  invocation:        SubagentInvocation
  delegation_description: string
  escalation_message:     string
  triggerReplyFlow:  string
  triggerButtons:    string
  terminalTool:      string
  extraction_prompt: string
  extraction_model:  string
  instructions:      string
  output_format:     string
  model:             string
  is_active:         boolean
  sort_order:        number
  datasources:       DatasourceDraft[]
  tools:             AgentTool[]
}

interface AttrDefDraft {
  id?:           string
  name:          string
  key:           string
  field_type:    AttributeFieldType
  action:        AttributeAction
  capture_regex: string
  sort_order:    number
}

interface UpdateDefDraft {
  id?:         string
  name:        string
  key:         string
  field_type:  UpdateFieldType
  options:     string
  description: string
  sort_order:  number
  // estado interno
  _creating?:  boolean   // true enquanto o RPC de criação da coluna está rodando
  _error?:     string
}


export default function AgentEditor({ agent, rules: initialRules, inboxes, availableModels, attrDefs: initialAttrDefs, tools: initialTools, apiConnections, updateDefs: initialUpdateDefs, subagents: initialSubagents }: Props) {
  const router  = useRouter()
  const supabase = createClient()
  const isNew   = !agent

  // ── Estado do formulário ───────────────────────────────────────────────────
  const [name,                setName]               = useState(agent?.name || '')
  const [description,         setDescription]        = useState(agent?.description || '')
  const [avatarEmoji,         setAvatarEmoji]        = useState(agent?.avatar_emoji || '🤖')
  const [isActive,            setIsActive]           = useState(agent?.is_active ?? true)
  const [isDefault,           setIsDefault]          = useState(agent?.is_default ?? false)

  const [model,               setModel]              = useState(agent?.model || 'gpt-4o-mini')
  const [temperature,         setTemperature]        = useState(agent?.temperature ?? 0.7)
  const [maxTokens,           setMaxTokens]          = useState(agent?.max_tokens ?? 600)
  const [memoryMessages,      setMemoryMessages]     = useState(agent?.memory_messages ?? 25)

  const [systemPrompt,        setSystemPrompt]       = useState(agent?.system_prompt || '')
  const [greetingMessage,     setGreetingMessage]    = useState(agent?.greeting_message || '')
  const [offHoursMessage,     setOffHoursMessage]    = useState(agent?.off_hours_message || '')

  const [includeBoletos,      setIncludeBoletos]     = useState(agent?.include_boletos ?? true)
  const [includeContactInfo,  setIncludeContactInfo] = useState(agent?.include_contact_info ?? true)
  const [customContext,       setCustomContext]       = useState(agent?.custom_context || '')

  const [escalationKeywords,    setEscalationKeywords]   = useState<string[]>(agent?.escalation_keywords   || [])
  const [escalationContexts,    setEscalationContexts]   = useState<string>((agent as any)?.escalation_contexts   || '')
  const [escalationBotPhrases,  setEscalationBotPhrases] = useState<string[]>((agent as any)?.escalation_bot_phrases || [])
  const [escalationMessage,     setEscalationMessage]    = useState(agent?.escalation_message || '')
  const [escalationRules,       setEscalationRules]      = useState<string>((agent as any)?.escalation_rules || '')
  const [newKeyword,            setNewKeyword]           = useState('')
  const [newBotPhrase,          setNewBotPhrase]         = useState('')

  // Regras de inbox separadas (checkboxes) das regras genéricas (tag/keyword)
  const [selectedInboxIds,    setSelectedInboxIds]   = useState<string[]>(
    initialRules.filter(r => r.rule_type === 'inbox').map(r => r.rule_value)
  )
  const [rules,               setRules]              = useState<Omit<AgentRule, 'id' | 'created_at'>[]>(
    initialRules
      .filter(r => r.rule_type !== 'inbox')
      .map(r => ({ agent_id: r.agent_id, rule_type: r.rule_type, rule_value: r.rule_value, priority: r.priority }))
  )
  const [newRuleType,         setNewRuleType]        = useState<AgentRuleType>('tag')
  const [newRuleValue,        setNewRuleValue]       = useState('')

  // Campos a capturar (contact attribute definitions)
  const [attrDefs,            setAttrDefs]           = useState<AttrDefDraft[]>(
    initialAttrDefs.map(d => ({
      id:            d.id,
      name:          d.name,
      key:           d.key,
      field_type:    d.field_type,
      action:        d.action,
      capture_regex: d.capture_regex || '',
      sort_order:    d.sort_order,
    }))
  )

  // Ferramentas do agente (CRUD independente — salvas diretamente no ToolEditor)
  const [tools,               setTools]              = useState<AgentTool[]>(initialTools)
  const [toolEditorOpen,      setToolEditorOpen]     = useState(false)
  const [editingTool,         setEditingTool]        = useState<AgentTool | null>(null)
  const [editingToolSubIdx,   setEditingToolSubIdx]  = useState<number | null>(null)  // índice do subagente dono da tool sendo editada (null = nível agente)

  // Campos de Atualização de Conversa
  const [updateDefs,          setUpdateDefs]         = useState<UpdateDefDraft[]>(
    initialUpdateDefs.map(d => ({
      id:          d.id,
      name:        d.name,
      key:         d.key,
      field_type:  d.field_type,
      options:     d.options.join('\n'),
      description: d.description,
      sort_order:  d.sort_order,
    }))
  )

  // Subagentes
  const [subagents, setSubagents] = useState<SubagentDraft[]>(
    initialSubagents.map(s => ({
      id:                s.id,
      name:              s.name,
      trigger_type:      s.trigger_type,
      invocation:        (s.invocation || 'auto_context') as SubagentInvocation,
      delegation_description: s.delegation_description || '',
      escalation_message:     s.escalation_message || '',
      triggerReplyFlow:  (s.trigger as any)?.reply_flow || '',
      triggerButtons:    ((s.trigger as any)?.buttons || []).join(', '),
      terminalTool:      s.terminal_tool || '',
      extraction_prompt: s.extraction_prompt || '',
      extraction_model:  s.extraction_model,
      instructions:      s.instructions,
      output_format:     s.output_format,
      model:             s.model,
      is_active:         s.is_active,
      sort_order:        s.sort_order,
      tools:             (s.tools || []) as AgentTool[],
      datasources:       (s.datasources || []).map(d => ({
        id:                 d.id,
        connection_id:      d.connection_id,
        name:               d.name,
        operation:          (d.operation || 'select') as DatasourceDraft['operation'],
        table_name:         d.table_name,
        filter_column:      d.filter_column || '',
        filter_template:    d.filter_template || '',
        value_map:          Object.entries(d.value_map || {}).map(([col, val]) => ({ col, val: String(val) })),
        columns:            d.columns || '*',
        max_rows:           d.max_rows ?? 5,
        output_placeholder: d.output_placeholder,
      })),
    }))
  )

  // Schema do banco (tabelas → colunas) para os dropdowns das fontes de dados
  const [dbSchema, setDbSchema] = useState<Record<string, string[]>>({})
  useEffect(() => {
    supabase.rpc('get_public_schema').then(({ data }) => {
      if (data && typeof data === 'object') setDbSchema(data as Record<string, string[]>)
    })
  }, [])

  const [loading,             setLoading]            = useState(false)
  const [error,               setError]              = useState('')
  const [saved,               setSaved]              = useState(false)

  // ── Helpers ────────────────────────────────────────────────────────────────
  function addKeyword() {
    const kw = newKeyword.trim().toLowerCase()
    if (kw && !escalationKeywords.includes(kw))
      setEscalationKeywords([...escalationKeywords, kw])
    setNewKeyword('')
  }

  function addBotPhrase() {
    const p = newBotPhrase.trim()
    if (p && !escalationBotPhrases.includes(p))
      setEscalationBotPhrases([...escalationBotPhrases, p])
    setNewBotPhrase('')
  }

  function addRule() {
    const val = newRuleValue.trim()
    if (!val) return
    setRules([...rules, { agent_id: agent?.id || '', rule_type: newRuleType, rule_value: val, priority: rules.length }])
    setNewRuleValue('')
  }

  // ── Salvar ─────────────────────────────────────────────────────────────────
  async function handleSave() {
    if (!name.trim()) { setError('O nome do agente é obrigatório'); return }
    setLoading(true)
    setError('')

    const agentData = {
      name:                 name.trim(),
      description:          description.trim() || null,
      avatar_emoji:         avatarEmoji,
      is_active:            isActive,
      is_default:           isDefault,
      model,
      temperature:          Number(temperature),
      max_tokens:           maxTokens,
      memory_messages:      memoryMessages,
      system_prompt:        systemPrompt,
      greeting_message:     greetingMessage.trim() || null,
      off_hours_message:    offHoursMessage.trim() || null,
      include_boletos:      includeBoletos,
      include_contact_info: includeContactInfo,
      custom_context:       customContext.trim() || null,
      escalation_keywords:    escalationKeywords,
      escalation_contexts:    escalationContexts.trim()    || null,
      escalation_bot_phrases: escalationBotPhrases,
      escalation_message:     escalationMessage.trim()     || null,
      escalation_rules:       escalationRules.trim()       || null,
      updated_at:           new Date().toISOString(),
    }

    let agentId = agent?.id

    if (isNew) {
      const { data, error: insertErr } = await supabase
        .from('chat_agents')
        .insert(agentData)
        .select('id')
        .single()

      if (insertErr || !data) {
        setError('Erro ao criar agente: ' + (insertErr?.message || 'desconhecido'))
        setLoading(false)
        return
      }
      agentId = data.id
    } else {
      const { error: updateErr } = await supabase
        .from('chat_agents')
        .update(agentData)
        .eq('id', agentId!)

      if (updateErr) {
        setError('Erro ao salvar: ' + updateErr.message)
        setLoading(false)
        return
      }
    }

    // Se marcado como padrão, remover padrão dos outros
    if (isDefault) {
      await supabase
        .from('chat_agents')
        .update({ is_default: false })
        .neq('id', agentId!)
    }

    // Salvar regras (apagar e reinserir)
    await supabase.from('chat_agent_rules').delete().eq('agent_id', agentId!)

    const inboxRules = selectedInboxIds.map((inboxId, i) => ({
      agent_id:   agentId,
      rule_type:  'inbox' as AgentRuleType,
      rule_value: inboxId,
      priority:   i,
    }))

    const otherRules = rules.map((r, i) => ({
      agent_id:   agentId,
      rule_type:  r.rule_type,
      rule_value: r.rule_value,
      priority:   selectedInboxIds.length + i,
    }))

    const allRules = [...inboxRules, ...otherRules]
    if (allRules.length > 0) {
      await supabase.from('chat_agent_rules').insert(allRules)
    }

    // Salvar campos a capturar (apagar e reinserir)
    await supabase.from('chat_contact_attribute_defs').delete().eq('agent_id', agentId!)
    const validDefs = attrDefs.filter(d => d.name.trim())
    if (validDefs.length > 0) {
      await supabase.from('chat_contact_attribute_defs').insert(
        validDefs.map((d, i) => ({
          agent_id:      agentId,
          name:          d.name.trim(),
          key:           (d.key.trim() || d.name.toLowerCase().replace(/[^a-z0-9]/g, '_')),
          field_type:    d.field_type,
          action:        d.action,
          capture_regex: d.capture_regex.trim() || null,
          sort_order:    i,
        }))
      )
    }

    // Salvar campos de atualização (apagar e reinserir + garantir coluna no banco)
    await supabase.from('chat_conversation_update_defs').delete().eq('agent_id', agentId!)
    const validUpdateDefs = updateDefs.filter(d => d.name.trim() && d.key.trim())
    if (validUpdateDefs.length > 0) {
      // 1. Criar colunas cf_<key> para cada campo (idempotente via IF NOT EXISTS)
      await Promise.all(
        validUpdateDefs.map(d =>
          supabase.rpc('create_conversation_field', { p_key: d.key.trim(), p_type: d.field_type })
        )
      )
      // 2. Persistir as definições
      await supabase.from('chat_conversation_update_defs').insert(
        validUpdateDefs.map((d, i) => ({
          agent_id:    agentId,
          name:        d.name.trim(),
          key:         d.key.trim(),
          field_type:  d.field_type,
          options:     d.field_type === 'select'
                         ? d.options.split('\n').map(o => o.trim()).filter(Boolean)
                         : [],
          description: d.description.trim(),
          sort_order:  i,
        }))
      )
    }

    // Salvar subagentes — UPSERT preservando IDs (não apagar: as fontes têm FK cascade)
    const validSubagents = subagents.filter(s => s.name.trim() && s.instructions.trim())

    // Remover subagentes que foram excluídos na UI
    const keptIds = validSubagents.map(s => s.id).filter(Boolean) as string[]
    const { data: existingSubs } = await supabase.from('chat_subagents').select('id').eq('agent_id', agentId!)
    const toDelete = (existingSubs || []).map(x => x.id).filter(id => !keptIds.includes(id))
    if (toDelete.length) await supabase.from('chat_subagents').delete().in('id', toDelete)

    // Upsert cada subagente e salvar suas fontes
    for (let i = 0; i < validSubagents.length; i++) {
      const s = validSubagents[i]
      const payload = {
        agent_id:          agentId,
        name:              s.name.trim(),
        trigger_type:      s.trigger_type,
        invocation:        s.invocation,
        delegation_description: s.invocation === 'on_demand' ? (s.delegation_description.trim() || null) : null,
        escalation_message:     s.escalation_message.trim() || null,
        trigger:                s.invocation === 'flow'
          ? { kind: 'campaign_reply',
              reply_flow: s.triggerReplyFlow.trim() || null,
              buttons: s.triggerButtons.split(',').map(b => b.trim()).filter(Boolean) }
          : null,
        terminal_tool:          s.invocation === 'flow' ? (s.terminalTool.trim() || null) : null,
        extraction_prompt: s.extraction_prompt.trim() || null,
        extraction_model:  s.extraction_model.trim() || 'gpt-4o-mini',
        instructions:      s.instructions,
        output_format:     s.output_format,
        model:             s.model.trim() || 'gpt-4o-mini',
        is_active:         s.is_active,
        sort_order:        i,
      }

      let subId = s.id
      if (subId) {
        await supabase.from('chat_subagents').update(payload).eq('id', subId)
      } else {
        const { data: created } = await supabase.from('chat_subagents').insert(payload).select('id').single()
        subId = created?.id
      }
      if (!subId) continue

      // Fontes de dados (delete + reinsert por subagente — id estável)
      await supabase.from('chat_subagent_datasources').delete().eq('subagent_id', subId)
      const validDs = s.datasources.filter(d =>
        d.table_name.trim() && (d.operation === 'select' ? d.output_placeholder.trim() : (d.value_map || []).some(v => v.col.trim())))
      if (validDs.length) {
        await supabase.from('chat_subagent_datasources').insert(
          validDs.map((d, j) => ({
            subagent_id:        subId,
            connection_id:      d.connection_id || null,
            name:               d.name.trim() || d.table_name.trim(),
            operation:          d.operation || 'select',
            table_name:         d.table_name.trim(),
            filter_column:      d.filter_column.trim() || null,
            filter_template:    d.filter_template.trim() || null,
            value_map:          Object.fromEntries((d.value_map || []).filter(v => v.col.trim()).map(v => [v.col.trim(), v.val])),
            columns:            d.columns.trim() || '*',
            max_rows:           d.max_rows || 5,
            output_placeholder: d.output_placeholder.trim() || null,
            sort_order:         j,
          }))
        )
      }
    }

    setLoading(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)

    if (isNew) router.push(`/agents/${agentId}`)
    else router.refresh()
  }

  // ── Excluir ────────────────────────────────────────────────────────────────
  async function handleDelete() {
    if (!agent || !confirm('Tem certeza? Esta ação não pode ser desfeita.')) return
    await supabase.from('chat_agents').delete().eq('id', agent.id)
    router.push('/agents')
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-3xl mx-auto p-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push('/agents')}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-500 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div>
            <h1 className="text-xl font-bold text-gray-900">
              {isNew ? 'Novo Agente' : name || 'Editar Agente'}
            </h1>
            <p className="text-xs text-gray-400 mt-0.5">
              {isNew ? 'Configure seu novo agente de IA' : 'Edite as configurações do agente'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {!isNew && (
            <button
              onClick={handleDelete}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg text-red-600 hover:bg-red-50 border border-red-200 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Excluir
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={loading}
            className={cn(
              'flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg font-medium transition-colors',
              saved
                ? 'bg-emerald-100 text-emerald-700 border border-emerald-200'
                : 'bg-emerald-600 text-white hover:bg-emerald-700'
            )}
          >
            <Save className="w-3.5 h-3.5" />
            {loading ? 'Salvando...' : saved ? 'Salvo ✓' : 'Salvar'}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="space-y-6">

        {/* ── IDENTIDADE ── */}
        <Section icon={<Bot className="w-4 h-4" />} title="Identidade">
          <div className="grid grid-cols-[auto_1fr] gap-4 items-start">
            {/* Emoji picker simples */}
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Emoji</label>
              <input
                value={avatarEmoji}
                onChange={(e) => setAvatarEmoji(e.target.value)}
                maxLength={4}
                className="w-16 h-10 text-center text-xl border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Nome *</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ex: Avi, Atendente Vendas..."
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Descrição</label>
                <input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Breve descrição do propósito deste agente"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
            </div>
          </div>

          <div className="flex gap-6 mt-2">
            <Toggle label="Ativo" checked={isActive} onChange={setIsActive} />
            <Toggle
              label={
                <span className="flex items-center gap-1">
                  <Star className="w-3 h-3 text-amber-500" />
                  Agente padrão
                </span>
              }
              checked={isDefault}
              onChange={setIsDefault}
              hint="Atende todas as conversas sem agente definido"
            />
          </div>
        </Section>

        {/* ── INSTRUÇÕES ── */}
        <Section icon={<MessageSquare className="w-4 h-4" />} title="Instruções (System Prompt)">
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="Descreva o comportamento, missão e regras do agente..."
            rows={14}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-y"
          />
          <p className="text-xs text-gray-400 mt-1">
            Para escalar para humano, instrua o agente a responder com: <code className="bg-gray-100 px-1 rounded">ESCALAR_HUMANO: [motivo]</code>
          </p>
        </Section>

        {/* ── CONFIGURAÇÃO IA ── */}
        <Section icon={<Cpu className="w-4 h-4" />} title="Configuração da IA">
          {/* Modelo */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs text-gray-500">Modelo</label>
              {availableModels.length > 0 && (
                <span className="text-[10px] text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">
                  {availableModels.length} modelos disponíveis
                </span>
              )}
            </div>

            {/* Combobox: digita livremente ou escolhe da lista da API */}
            <input
              list="openai-models-list"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="Ex: gpt-4o-mini"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
            {availableModels.length > 0 && (
              <datalist id="openai-models-list">
                {availableModels.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            )}

            <p className="text-[11px] text-gray-400 mt-1.5">
              {availableModels.length > 0
                ? 'Digite o nome ou clique no campo para ver todos os modelos da sua conta OpenAI.'
                : 'Digite o ID exato do modelo (ex: gpt-4o-mini). Consulte platform.openai.com/docs/models.'}
            </p>
          </div>

          {/* Sliders */}
          <div className="space-y-4 mt-4">
            <Slider
              label="Temperatura"
              value={temperature}
              min={0} max={1.5} step={0.1}
              onChange={setTemperature}
              leftLabel="Mais preciso"
              rightLabel="Mais criativo"
              format={(v) => v.toFixed(1)}
            />
            <Slider
              label="Máximo de tokens (tamanho da resposta)"
              value={maxTokens}
              min={100} max={2000} step={50}
              onChange={setMaxTokens}
              leftLabel="Mais curto"
              rightLabel="Mais longo"
              format={(v) => `${v}`}
            />
            <Slider
              label="Mensagens de contexto (histórico)"
              value={memoryMessages}
              min={5} max={50} step={5}
              onChange={setMemoryMessages}
              leftLabel="Menos memória"
              rightLabel="Mais memória"
              format={(v) => `${v} msgs`}
            />
          </div>
        </Section>

        {/* ── SAUDAÇÃO ── */}
        <Section icon={<MessageSquare className="w-4 h-4" />} title="Saudação e Mensagens">
          <div className="space-y-3">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Mensagem de boas-vindas</label>
              <input
                value={greetingMessage}
                onChange={(e) => setGreetingMessage(e.target.value)}
                placeholder='Ex: "Olá! Sou a Avi, assistente virtual da Aviv Construtora. Como posso ajudar?"'
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
              <p className="text-[11px] text-gray-400 mt-1">Inclua no system prompt ou use como referência</p>
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Mensagem fora do horário</label>
              <input
                value={offHoursMessage}
                onChange={(e) => setOffHoursMessage(e.target.value)}
                placeholder='Ex: "Nosso horário de atendimento é de segunda a sexta, das 8h às 18h..."'
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>
          </div>
        </Section>

        {/* ── DADOS ── */}
        <Section icon={<Database className="w-4 h-4" />} title="Dados Injetados no Contexto">
          <div className="space-y-3">
            <Toggle
              label="Incluir boletos do Sienge"
              checked={includeBoletos}
              onChange={setIncludeBoletos}
              hint="Busca e injeta boletos do cliente no contexto da conversa"
            />
            <Toggle
              label="Incluir informações do contato"
              checked={includeContactInfo}
              onChange={setIncludeContactInfo}
              hint="Injeta nome e telefone do cliente no contexto"
            />
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Contexto adicional</label>
              <textarea
                value={customContext}
                onChange={(e) => setCustomContext(e.target.value)}
                placeholder="Informações extras que o agente deve sempre ter acesso (tabela de preços, endereços, políticas...)"
                rows={3}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-none"
              />
            </div>
          </div>
        </Section>

        {/* ── CAMPOS A CAPTURAR ── */}
        <Section icon={<Tags className="w-4 h-4" />} title="Campos a Capturar">
          <p className="text-xs text-gray-500 -mt-1 mb-3">
            Configure quais dados o agente deve detectar e salvar automaticamente durante as conversas
            (ex: CPF, e-mail, número de contrato). Os valores capturados ficam visíveis no painel do contato.
          </p>

          {attrDefs.length > 0 && (
            <div className="space-y-3 mb-4">
              {attrDefs.map((def, i) => (
                <div key={i} className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-2 items-start p-3 bg-gray-50 border border-gray-200 rounded-lg">
                  {/* Nome */}
                  <div className="space-y-1 col-span-5">
                    <input
                      value={def.name}
                      onChange={(e) => setAttrDefs(attrDefs.map((d, j) => j === i ? { ...d, name: e.target.value } : d))}
                      placeholder="Rótulo (ex: CPF do Cliente)"
                      className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    />
                  </div>
                  {/* Chave slug */}
                  <div className="col-span-2">
                    <label className="text-[10px] text-gray-400 mb-0.5 block">Chave (slug)</label>
                    <input
                      value={def.key}
                      onChange={(e) => setAttrDefs(attrDefs.map((d, j) => j === i ? { ...d, key: e.target.value.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '') } : d))}
                      placeholder="ex: cpf"
                      className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    />
                  </div>
                  {/* Tipo */}
                  <div className="col-span-2">
                    <label className="text-[10px] text-gray-400 mb-0.5 block">Tipo de campo</label>
                    <select
                      value={def.field_type}
                      onChange={(e) => setAttrDefs(attrDefs.map((d, j) => j === i ? { ...d, field_type: e.target.value as AttributeFieldType } : d))}
                      className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    >
                      <option value="cpf_cnpj">CPF / CNPJ</option>
                      <option value="email">E-mail</option>
                      <option value="phone">Telefone</option>
                      <option value="number">Número</option>
                      <option value="text">Texto livre</option>
                    </select>
                  </div>
                  {/* Ação */}
                  <div className="col-span-2">
                    <label className="text-[10px] text-gray-400 mb-0.5 block">Ação ao capturar</label>
                    <select
                      value={def.action}
                      onChange={(e) => setAttrDefs(attrDefs.map((d, j) => j === i ? { ...d, action: e.target.value as AttributeAction } : d))}
                      className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    >
                      <option value="save">Salvar apenas</option>
                      <option value="save_and_lookup_sienge">Salvar + buscar no Sienge</option>
                    </select>
                  </div>
                  {/* Regex personalizado + delete */}
                  <div className="col-span-4">
                    <label className="text-[10px] text-gray-400 mb-0.5 block">Regex personalizado (opcional)</label>
                    <input
                      value={def.capture_regex}
                      onChange={(e) => setAttrDefs(attrDefs.map((d, j) => j === i ? { ...d, capture_regex: e.target.value } : d))}
                      placeholder="Deixe em branco para usar o padrão do tipo"
                      className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    />
                  </div>
                  <div className="col-span-1 flex items-end justify-end pb-0.5">
                    <button
                      onClick={() => setAttrDefs(attrDefs.filter((_, j) => j !== i))}
                      className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-md transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <button
            onClick={() => setAttrDefs([...attrDefs, {
              name: '', key: '', field_type: 'text', action: 'save', capture_regex: '', sort_order: attrDefs.length,
            }])}
            className="flex items-center gap-1.5 px-3 py-2 text-xs text-emerald-700 border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 rounded-lg transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Adicionar campo
          </button>

          {attrDefs.some(d => d.field_type === 'cpf_cnpj' && d.action === 'save_and_lookup_sienge') && (
            <div className="mt-3 p-2.5 bg-blue-50 border border-blue-200 rounded-lg text-[11px] text-blue-700">
              💡 Quando o cliente enviar um CPF/CNPJ, o sistema vai automaticamente buscar os boletos dele no Sienge
              e injetar no contexto do bot.
            </div>
          )}
        </Section>

        {/* ── ESCALAÇÃO ── */}
        <Section icon={<AlertTriangle className="w-4 h-4" />} title="Escalação para Atendente Humano">
          <p className="text-xs text-gray-500 -mt-1">
            Configure quando o bot deve parar de responder e sinalizar que um humano precisa assumir.
          </p>

          {/* 0 — Regras base de escalação (editável) */}
          <div className="pt-1">
            <label className="text-xs font-medium text-gray-700 mb-0.5 block">
              Regras de escalação (instruções para a IA)
            </label>
            <p className="text-[11px] text-gray-400 mb-2">
              Estas regras dizem à IA <strong>quando</strong> usar <code className="bg-gray-100 px-1 rounded">ESCALAR_HUMANO:</code> e quando <strong>não</strong> escalar.
              São injetadas no prompt. Edite com cuidado — se deixar em branco, o sistema usa as regras padrão.
            </p>
            <textarea
              value={escalationRules}
              onChange={(e) => setEscalationRules(e.target.value)}
              rows={10}
              placeholder="--- REGRAS DE ESCALAÇÃO ---&#10;Use ESCALAR_HUMANO: <motivo> apenas quando...&#10;NUNCA escale em saudações..."
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-y"
            />
          </div>

          <div className="border-t border-gray-100 pt-3" />

          {/* 1 — Palavras-chave do cliente */}
          <div className="pt-1">
            <label className="text-xs font-medium text-gray-700 mb-0.5 block">
              Se o cliente disser estas palavras
            </label>
            <p className="text-[11px] text-gray-400 mb-2">
              Qualquer mensagem do cliente que contenha essas palavras dispara a escalação automaticamente, independente da IA.
            </p>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {escalationKeywords.map((kw) => (
                <span
                  key={kw}
                  className="flex items-center gap-1 px-2 py-0.5 bg-red-50 text-red-700 text-xs rounded-full border border-red-200"
                >
                  {kw}
                  <button onClick={() => setEscalationKeywords(escalationKeywords.filter(k => k !== kw))} className="hover:text-red-900">
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
              {escalationKeywords.length === 0 && (
                <span className="text-[11px] text-gray-400 italic">Nenhuma palavra-chave definida</span>
              )}
            </div>
            <div className="flex gap-2">
              <input
                value={newKeyword}
                onChange={(e) => setNewKeyword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addKeyword())}
                placeholder="Ex: rescisão, cancelar contrato, processarei..."
                className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
              <button onClick={addKeyword} className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm transition-colors">
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="border-t border-gray-100 pt-3" />

          {/* 2 — Contexto da conversa */}
          <div>
            <label className="text-xs font-medium text-gray-700 mb-0.5 block">
              Se a conversa tiver este contexto
            </label>
            <p className="text-[11px] text-gray-400 mb-2">
              Descreva as situações em que o bot deve escalar — o texto é injetado como regras no prompt. Seja específico.
            </p>
            <textarea
              value={escalationContexts}
              onChange={(e) => setEscalationContexts(e.target.value)}
              placeholder={`Ex:\n- Cliente perguntando sobre descumprimento de contrato ou o que foi prometido na venda\n- Cliente reclamando de cobranças que não reconhece ou valores que subiram sem aviso\n- Cliente pedindo negociação, carência ou renegociação de parcelas\n- Cliente demonstrando frustração após a segunda resposta do bot`}
              rows={5}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-y font-mono"
            />
          </div>

          <div className="border-t border-gray-100 pt-3" />

          {/* 3 — Frases do bot */}
          <div>
            <label className="text-xs font-medium text-gray-700 mb-0.5 block">
              Se o bot disser estas frases
            </label>
            <p className="text-[11px] text-gray-400 mb-2">
              Se a resposta gerada pelo bot <em>contiver</em> qualquer uma dessas frases, a conversa é marcada como aguardando atendente.
              Útil para detectar quando o bot promete encaminhamento sem usar o token formal.
            </p>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {escalationBotPhrases.map((p) => (
                <span
                  key={p}
                  className="flex items-center gap-1 px-2 py-0.5 bg-amber-50 text-amber-700 text-xs rounded-full border border-amber-200"
                >
                  {p}
                  <button onClick={() => setEscalationBotPhrases(escalationBotPhrases.filter(x => x !== p))} className="hover:text-amber-900">
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
              {escalationBotPhrases.length === 0 && (
                <span className="text-[11px] text-gray-400 italic">Nenhuma frase definida</span>
              )}
            </div>
            <div className="flex gap-2">
              <input
                value={newBotPhrase}
                onChange={(e) => setNewBotPhrase(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addBotPhrase())}
                placeholder="Ex: um atendente já vai falar com você..."
                className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
              <button onClick={addBotPhrase} className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm transition-colors">
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="border-t border-gray-100 pt-3" />

          {/* Mensagem ao escalar */}
          <div>
            <label className="text-xs font-medium text-gray-700 mb-0.5 block">Mensagem enviada ao cliente ao escalar</label>
            <p className="text-[11px] text-gray-400 mb-2">Enviada no lugar da resposta quando o token <code className="bg-gray-100 px-1 rounded">ESCALAR_HUMANO:</code> é detectado.</p>
            <textarea
              value={escalationMessage}
              onChange={(e) => setEscalationMessage(e.target.value)}
              placeholder='Ex: "Entendido! Vou encaminhar você para um atendente agora mesmo. Aguarde um momento. 🙏"'
              rows={2}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-none"
            />
          </div>
        </Section>

        {/* ── ROTEAMENTO ── */}
        <Section icon={<GitBranch className="w-4 h-4" />} title="Roteamento">
          {isDefault ? (
            <div className="flex items-center gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
              <Star className="w-4 h-4 text-amber-500 shrink-0" />
              Este é o agente padrão — atende todas as conversas que não possuem outro agente definido.
            </div>
          ) : (
            <div className="flex items-center gap-2 p-3 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-600">
              <Bot className="w-4 h-4 shrink-0" />
              Este agente não é o padrão. Associe caixas de entrada ou defina regras abaixo.
            </div>
          )}

          {/* Caixas de entrada */}
          <div className="mt-4">
            <label className="text-xs text-gray-500 mb-2 block font-medium">
              Caixas de entrada atendidas por este agente
            </label>
            {inboxes.length === 0 ? (
              <p className="text-xs text-gray-400 italic">
                Nenhuma caixa de entrada configurada.{' '}
                <a href="/inboxes/new" className="text-emerald-600 underline">Criar caixa →</a>
              </p>
            ) : (
              <div className="space-y-2">
                {inboxes.map((inbox) => {
                  const checked = selectedInboxIds.includes(inbox.id)
                  return (
                    <label
                      key={inbox.id}
                      className={cn(
                        'flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
                        checked
                          ? 'border-emerald-300 bg-emerald-50'
                          : 'border-gray-200 hover:border-gray-300 bg-white'
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedInboxIds([...selectedInboxIds, inbox.id])
                          } else {
                            setSelectedInboxIds(selectedInboxIds.filter(id => id !== inbox.id))
                          }
                        }}
                        className="accent-emerald-600 w-4 h-4 shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-gray-800">{inbox.name}</span>
                          {!inbox.is_active && (
                            <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded-full">Inativa</span>
                          )}
                        </div>
                        {inbox.description && (
                          <p className="text-xs text-gray-400 truncate">{inbox.description}</p>
                        )}
                        <p className="text-[11px] text-gray-400 font-mono">+{inbox.phone_number}</p>
                      </div>
                    </label>
                  )
                })}
              </div>
            )}
          </div>

          {/* Regras adicionais (tag / keyword) */}
          <div className="mt-5 pt-4 border-t border-gray-100">
            <label className="text-xs text-gray-500 mb-2 block font-medium">
              Regras adicionais (por tag ou palavra-chave)
            </label>

            {rules.length > 0 && (
              <div className="space-y-1.5 mb-3">
                {rules.map((rule, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm">
                    <span className="px-2 py-0.5 bg-blue-50 text-blue-700 rounded text-xs font-medium border border-blue-200">
                      {rule.rule_type === 'tag' ? 'Tag' : 'Palavra-chave'}
                    </span>
                    <span className="text-gray-700">= <strong>{rule.rule_value}</strong></span>
                    <span className="text-gray-400">→ usa este agente</span>
                    <button
                      onClick={() => setRules(rules.filter((_, j) => j !== i))}
                      className="ml-auto text-gray-400 hover:text-red-500 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex gap-2">
              <select
                value={newRuleType}
                onChange={(e) => setNewRuleType(e.target.value as AgentRuleType)}
                className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white"
              >
                <option value="tag">Tag</option>
                <option value="keyword">Palavra-chave</option>
              </select>
              <input
                value={newRuleValue}
                onChange={(e) => setNewRuleValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addRule())}
                placeholder={newRuleType === 'tag' ? 'nome-da-tag' : 'palavra chave'}
                className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
              <button
                onClick={addRule}
                className="flex items-center gap-1 px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm transition-colors"
              >
                <Plus className="w-4 h-4" />
                Adicionar
              </button>
            </div>
          </div>
        </Section>

        {/* Ferramentas não ficam mais no agente principal (orquestrador): cada
            ferramenta pertence a um SUBAGENTE e é configurada dentro dele
            (ver seção "Subagentes" abaixo). */}
        {!isNew && (
          <Section icon={<Wrench className="w-4 h-4" />} title="Ferramentas">
            <p className="text-xs text-gray-500">
              As ferramentas agora pertencem aos <strong>subagentes</strong> — o agente principal apenas
              orquestra e delega. Configure cada ferramenta dentro do subagente correspondente,
              na seção <strong>“Subagentes”</strong> abaixo.
            </p>
          </Section>
        )}

        {/* ── CAMPOS DE ATUALIZAÇÃO ── */}
        <Section icon={<RefreshCw className="w-4 h-4" />} title="Campos de Atualização da Conversa">
          <p className="text-xs text-gray-500 -mt-1 mb-3">
            Configure quais dados o agente pode gravar diretamente na conversa durante o atendimento.
            Cada campo cria automaticamente uma coluna <code className="bg-gray-100 px-1 rounded">cf_*</code> no banco ao salvar.
          </p>

          {updateDefs.length > 0 && (
            <div className="space-y-3 mb-4">
              {updateDefs.map((def, i) => (
                <div key={i} className="p-3 bg-gray-50 border border-gray-200 rounded-lg space-y-2">
                  <div className="grid grid-cols-[1fr_1fr] gap-2">
                    {/* Nome */}
                    <div>
                      <label className="text-[10px] text-gray-400 mb-0.5 block">Rótulo</label>
                      <input
                        value={def.name}
                        onChange={(e) => setUpdateDefs(updateDefs.map((d, j) => j === i ? { ...d, name: e.target.value } : d))}
                        placeholder="Ex: Status de Pagamento"
                        className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      />
                    </div>
                    {/* Chave */}
                    <div>
                      <label className="text-[10px] text-gray-400 mb-0.5 block">
                        Chave → coluna <code className="bg-gray-100 px-0.5 rounded">cf_<span className="text-emerald-700">{def.key || '...'}</span></code>
                      </label>
                      <input
                        value={def.key}
                        onChange={(e) => setUpdateDefs(updateDefs.map((d, j) => j === i ? {
                          ...d, key: e.target.value.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
                        } : d))}
                        placeholder="ex: status_pagamento"
                        className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-[1fr_1fr] gap-2">
                    {/* Tipo */}
                    <div>
                      <label className="text-[10px] text-gray-400 mb-0.5 block">Tipo</label>
                      <select
                        value={def.field_type}
                        onChange={(e) => setUpdateDefs(updateDefs.map((d, j) => j === i ? { ...d, field_type: e.target.value as UpdateFieldType } : d))}
                        className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      >
                        <option value="text">Texto livre</option>
                        <option value="select">Seleção (lista)</option>
                        <option value="number">Número</option>
                        <option value="boolean">Sim / Não</option>
                      </select>
                    </div>
                    {/* Opções (visível apenas para select) */}
                    {def.field_type === 'select' ? (
                      <div>
                        <label className="text-[10px] text-gray-400 mb-0.5 block">Opções (uma por linha)</label>
                        <textarea
                          value={def.options}
                          onChange={(e) => setUpdateDefs(updateDefs.map((d, j) => j === i ? { ...d, options: e.target.value } : d))}
                          placeholder={"pendente\npago\ncancelado"}
                          rows={3}
                          className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-none"
                        />
                      </div>
                    ) : (
                      <div />
                    )}
                  </div>

                  {/* Instrução para o AI */}
                  <div>
                    <label className="text-[10px] text-gray-400 mb-0.5 block">Instrução para o AI (quando atualizar e com qual valor)</label>
                    <input
                      value={def.description}
                      onChange={(e) => setUpdateDefs(updateDefs.map((d, j) => j === i ? { ...d, description: e.target.value } : d))}
                      placeholder='Ex: "Atualize para pendente quando o cliente mencionar pagamento atrasado"'
                      className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    />
                  </div>

                  <div className="flex justify-end pt-0.5">
                    <button
                      onClick={() => setUpdateDefs(updateDefs.filter((_, j) => j !== i))}
                      className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-md transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <button
            onClick={() => setUpdateDefs([...updateDefs, {
              name: '', key: '', field_type: 'text', options: '', description: '', sort_order: updateDefs.length,
            }])}
            className="flex items-center gap-1.5 px-3 py-2 text-xs text-emerald-700 border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 rounded-lg transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Adicionar campo
          </button>

          {updateDefs.length > 0 && (
            <div className="mt-3 p-2.5 bg-blue-50 border border-blue-200 rounded-lg text-[11px] text-blue-700">
              💡 As colunas são criadas automaticamente ao salvar o agente. O bot pode atualizar esses campos
              usando a função <code className="bg-blue-100 px-1 rounded">atualizar_conversa</code> durante a conversa.
            </div>
          )}
        </Section>

        {/* ── SUBAGENTES ── */}
        <Section icon={<GitBranch className="w-4 h-4" />} title="Subagentes (análise de mídia)">
          <p className="text-xs text-gray-500 -mt-1">
            Subagentes especializados acionados por tipo de mídia. Cada um tem seu próprio gatilho,
            instruções (critérios) e formato de saída. Use os placeholders{' '}
            <code className="bg-gray-100 px-1 rounded">{'{{dados_extraidos}}'}</code>,{' '}
            <code className="bg-gray-100 px-1 rounded">{'{{contexto_sienge}}'}</code>,{' '}
            <code className="bg-gray-100 px-1 rounded">{'{{empreendimentos}}'}</code>,{' '}
            <code className="bg-gray-100 px-1 rounded">{'{{transcricao}}'}</code> para injetar dados dinâmicos.
          </p>

          {subagents.length > 0 && (
            <div className="space-y-4 pt-1">
              {subagents.map((s, i) => (
                <div key={i} className="border border-gray-200 rounded-xl p-4 space-y-3 bg-gray-50/50">
                  {/* Linha topo: nome, gatilho, ativo, remover */}
                  <div className="flex items-center gap-2">
                    <input
                      value={s.name}
                      onChange={(e) => setSubagents(subagents.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                      placeholder="Nome do subagente"
                      className="flex-1 border border-gray-200 rounded-md px-2 py-1.5 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    />
                    <select
                      value={s.trigger_type}
                      onChange={(e) => setSubagents(subagents.map((x, j) => j === i ? { ...x, trigger_type: e.target.value as SubagentTrigger } : x))}
                      className="h-8 rounded-md border border-gray-200 bg-white px-2 text-xs"
                    >
                      <option value="text">💬 Texto</option>
                      <option value="image">📷 Imagem</option>
                      <option value="document">📄 Documento</option>
                      <option value="audio">🎙 Áudio</option>
                    </select>
                    <label className="flex items-center gap-1 text-xs text-gray-600 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={s.is_active}
                        onChange={(e) => setSubagents(subagents.map((x, j) => j === i ? { ...x, is_active: e.target.checked } : x))}
                      />
                      Ativo
                    </label>
                    <button
                      onClick={() => setSubagents(subagents.filter((_, j) => j !== i))}
                      className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-md transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {/* Invocação — como o subagente é acionado */}
                  <div>
                    <label className="text-[11px] font-medium text-gray-500 mb-0.5 block">Quando este subagente é acionado</label>
                    <select
                      value={s.invocation}
                      onChange={(e) => setSubagents(subagents.map((x, j) => j === i ? { ...x, invocation: e.target.value as SubagentInvocation } : x))}
                      className="w-full h-8 rounded-md border border-gray-200 bg-white px-2 text-xs"
                    >
                      <option value="auto_context">🔁 Sempre (injeta contexto a cada mensagem de texto)</option>
                      <option value="on_media">📎 Por mídia (gatilho de imagem/documento/áudio)</option>
                      <option value="on_demand">🎯 Sob demanda (o agente principal delega quando necessário)</option>
                      <option value="flow">🧩 Fluxo (acionado por gatilho — ex.: resposta de campanha)</option>
                    </select>
                  </div>

                  {/* Fluxo (flow) — gatilho determinístico */}
                  {s.invocation === 'flow' && (
                    <div className="space-y-3 rounded-lg border border-indigo-100 bg-indigo-50/40 p-3">
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-[11px] font-medium text-gray-500 mb-0.5 block">reply_flow da campanha</label>
                          <input
                            value={s.triggerReplyFlow}
                            onChange={(e) => setSubagents(subagents.map((x, j) => j === i ? { ...x, triggerReplyFlow: e.target.value } : x))}
                            placeholder="indique_ganhe"
                            className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white"
                          />
                        </div>
                        <div>
                          <label className="text-[11px] font-medium text-gray-500 mb-0.5 block">Botões que iniciam</label>
                          <input
                            value={s.triggerButtons}
                            onChange={(e) => setSubagents(subagents.map((x, j) => j === i ? { ...x, triggerButtons: e.target.value } : x))}
                            placeholder="indicar"
                            className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white"
                          />
                        </div>
                      </div>
                      <p className="text-[10px] text-gray-400 -mt-1">
                        Aciona quando a resposta for um botão que contenha esse texto, numa conversa de campanha marcada com esse <code>reply_flow</code>. Separe botões por vírgula.
                      </p>
                      <div>
                        <label className="text-[11px] font-medium text-gray-500 mb-0.5 block">Ferramenta que encerra o fluxo (terminal)</label>
                        <input
                          value={s.terminalTool}
                          onChange={(e) => setSubagents(subagents.map((x, j) => j === i ? { ...x, terminalTool: e.target.value } : x))}
                          placeholder="Notificar corretor"
                          className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white"
                        />
                        <p className="text-[10px] text-gray-400 mt-0.5">Nome exato de uma ferramenta abaixo. Quando ela roda com sucesso, o fluxo é dado como concluído.</p>
                      </div>
                      <div>
                        <label className="text-[11px] font-medium text-gray-500 mb-0.5 block">Mensagem ao escalar para humano (opcional)</label>
                        <input
                          value={s.escalation_message}
                          onChange={(e) => setSubagents(subagents.map((x, j) => j === i ? { ...x, escalation_message: e.target.value } : x))}
                          placeholder="Ex: Vou te encaminhar para um de nossos atendentes. 🙏"
                          className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white"
                        />
                      </div>
                    </div>
                  )}

                  {/* Delegação (on_demand) */}
                  {s.invocation === 'on_demand' && (
                    <div className="space-y-3 rounded-lg border border-emerald-100 bg-emerald-50/40 p-3">
                      <div>
                        <label className="text-[11px] font-medium text-gray-500 mb-0.5 block">Quando o agente principal deve delegar a este especialista</label>
                        <textarea
                          value={s.delegation_description}
                          onChange={(e) => setSubagents(subagents.map((x, j) => j === i ? { ...x, delegation_description: e.target.value } : x))}
                          rows={2}
                          placeholder="Ex: Use quando o cliente quiser pagar o boleto em outra data, reagendar ou adiar o pagamento."
                          className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-y bg-white"
                        />
                        <p className="text-[10px] text-gray-400 mt-0.5">É a descrição que o orquestrador usa para decidir delegar. Seja específico.</p>
                      </div>
                      <div>
                        <label className="text-[11px] font-medium text-gray-500 mb-0.5 block">Mensagem ao escalar para humano (opcional)</label>
                        <input
                          value={s.escalation_message}
                          onChange={(e) => setSubagents(subagents.map((x, j) => j === i ? { ...x, escalation_message: e.target.value } : x))}
                          placeholder="Ex: Vou te encaminhar para um atendente para tratar essa data. 🙏"
                          className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white"
                        />
                      </div>
                    </div>
                  )}

                  {/* Extração (não p/ áudio) */}
                  {( s.trigger_type === 'image' || s.trigger_type === 'document' ) && (
                    <div>
                      <label className="text-[11px] font-medium text-gray-500 mb-0.5 block">
                        Passo 1 — Extração de dados (prompt enviado junto com a mídia)
                      </label>
                      <textarea
                        value={s.extraction_prompt}
                        onChange={(e) => setSubagents(subagents.map((x, j) => j === i ? { ...x, extraction_prompt: e.target.value } : x))}
                        rows={3}
                        placeholder="Ex: Extraia da imagem: beneficiário, valor, vencimento... Responda em JSON."
                        className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-y"
                      />
                    </div>
                  )}

                  {/* Instruções / critérios */}
                  <div>
                    <label className="text-[11px] font-medium text-gray-500 mb-0.5 block">
                      {s.trigger_type === 'audio' ? 'Instruções (como interpretar o áudio)'
                        : s.trigger_type === 'text' ? 'Instruções (como a IA deve usar os dados consultados)'
                        : 'Passo 2 — Instruções / critérios de análise'}
                    </label>
                    <textarea
                      value={s.instructions}
                      onChange={(e) => setSubagents(subagents.map((x, j) => j === i ? { ...x, instructions: e.target.value } : x))}
                      rows={6}
                      placeholder="Critérios de avaliação, regras de classificação..."
                      className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-xs font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-y"
                    />
                  </div>

                  {/* Formato de saída */}
                  <div>
                    <label className="text-[11px] font-medium text-gray-500 mb-0.5 block">
                      Formato de saída (texto livre ou JSON)
                    </label>
                    <textarea
                      value={s.output_format}
                      onChange={(e) => setSubagents(subagents.map((x, j) => j === i ? { ...x, output_format: e.target.value } : x))}
                      rows={3}
                      placeholder="Ex: Texto corrido de 3 linhas: classificação, motivo, recomendação."
                      className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-y"
                    />
                  </div>

                  {/* Modelos */}
                  <div className="grid grid-cols-2 gap-2">
                    {( s.trigger_type === 'image' || s.trigger_type === 'document' ) && (
                      <div>
                        <label className="text-[11px] font-medium text-gray-500 mb-0.5 block">Modelo extração</label>
                        <input
                          value={s.extraction_model}
                          onChange={(e) => setSubagents(subagents.map((x, j) => j === i ? { ...x, extraction_model: e.target.value } : x))}
                          placeholder="gpt-4o-mini"
                          className="w-full border border-gray-200 rounded-md px-2 py-1 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500"
                        />
                      </div>
                    )}
                    <div>
                      <label className="text-[11px] font-medium text-gray-500 mb-0.5 block">Modelo análise</label>
                      <input
                        value={s.model}
                        onChange={(e) => setSubagents(subagents.map((x, j) => j === i ? { ...x, model: e.target.value } : x))}
                        placeholder="gpt-4o-mini"
                        className="w-full border border-gray-200 rounded-md px-2 py-1 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      />
                    </div>
                  </div>

                  {/* ── Fontes de dados do subagente ── */}
                  <div className="border-t border-gray-200 pt-3 mt-1">
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-[11px] font-semibold text-gray-600 flex items-center gap-1">
                        <Plug className="w-3 h-3" /> Fontes de dados (consultas à base)
                      </label>
                      <button
                        onClick={() => setSubagents(subagents.map((x, j) => j === i ? { ...x, datasources: [...x.datasources, {
                          connection_id: apiConnections.find(c => c.provider === 'supabase_db')?.id || null,
                          name: '', operation: 'select', table_name: '', filter_column: '', filter_template: '', value_map: [], columns: '*', max_rows: 5, output_placeholder: '',
                        }] } : x))}
                        className="text-[11px] text-emerald-600 hover:text-emerald-700"
                      >
                        + Adicionar operação
                      </button>
                    </div>
                    {s.datasources.length === 0 && (
                      <p className="text-[11px] text-gray-400 italic">Nenhuma fonte. O subagente usa só os dados extraídos da mídia.</p>
                    )}
                    {s.datasources.map((d, di) => {
                      const upd = (patch: Partial<DatasourceDraft>) => setSubagents(subagents.map((x, j) =>
                        j === i ? { ...x, datasources: x.datasources.map((y, k) => k === di ? { ...y, ...patch } : y) } : x))
                      return (
                        <div key={di} className="bg-white border border-gray-200 rounded-lg p-2.5 mb-2 space-y-2">
                          <div className="flex items-center gap-2">
                            <select
                              value={d.connection_id || ''}
                              onChange={(e) => upd({ connection_id: e.target.value || null })}
                              className="h-7 rounded border border-gray-200 bg-white px-1.5 text-[11px] shrink-0"
                            >
                              <option value="">— Conexão —</option>
                              {apiConnections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                            </select>
                            {apiConnections.find(c => c.id === d.connection_id)?.provider === 'supabase_db' && Object.keys(dbSchema).length ? (
                              <select
                                value={d.table_name}
                                onChange={(e) => upd({ table_name: e.target.value, filter_column: '' })}
                                className="flex-1 border border-gray-200 rounded px-2 py-1 text-[11px] font-mono bg-white"
                              >
                                <option value="">— Selecione a tabela —</option>
                                {Object.keys(dbSchema).sort().map(t => <option key={t} value={t}>{t}</option>)}
                              </select>
                            ) : (
                              <input
                                value={d.table_name}
                                onChange={(e) => upd({ table_name: e.target.value })}
                                placeholder="tabela (ex: sienge_boletos)"
                                className="flex-1 border border-gray-200 rounded px-2 py-1 text-[11px] font-mono"
                              />
                            )}
                            <button
                              onClick={() => setSubagents(subagents.map((x, j) =>
                                j === i ? { ...x, datasources: x.datasources.filter((_, k) => k !== di) } : x))}
                              className="text-gray-400 hover:text-red-500 shrink-0"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                          {/* Ação + nome da operação */}
                          <div className="flex items-center gap-2">
                            <select value={d.operation} onChange={(e) => upd({ operation: e.target.value as any })}
                              className="h-7 rounded border border-gray-200 bg-white px-1.5 text-[11px] shrink-0">
                              <option value="select">Consultar</option>
                              <option value="insert">Criar</option>
                              <option value="update">Atualizar</option>
                              <option value="upsert">Upsert</option>
                            </select>
                            <input value={d.name} onChange={(e) => upd({ name: e.target.value })}
                              placeholder="nome da operação" className="flex-1 border border-gray-200 rounded px-2 py-1 text-[11px]" />
                          </div>

                          {/* Chave: filtro (SELECT) ou chave de gravação (UPDATE/UPSERT) */}
                          {(d.operation === 'select' || d.operation === 'update' || d.operation === 'upsert') && (
                            <div className="grid grid-cols-2 gap-2">
                              <div>
                                <label className="text-[10px] text-gray-500 mb-0.5 block">{d.operation === 'select' ? 'Filtrar pela coluna' : 'Chave (coluna)'}</label>
                                {dbSchema[d.table_name]?.length ? (
                                  <select value={d.filter_column} onChange={(e) => upd({ filter_column: e.target.value })}
                                    className="w-full border border-gray-200 rounded px-2 py-1 text-[11px] font-mono bg-white">
                                    <option value="">— Coluna —</option>
                                    {dbSchema[d.table_name].map(col => <option key={col} value={col}>{col}</option>)}
                                  </select>
                                ) : (
                                  <input value={d.filter_column} onChange={(e) => upd({ filter_column: e.target.value })}
                                    placeholder="customer_phone" className="w-full border border-gray-200 rounded px-2 py-1 text-[11px] font-mono" />
                                )}
                              </div>
                              <div>
                                <label className="text-[10px] text-gray-500 mb-0.5 block">Igual a</label>
                                <input value={d.filter_template} onChange={(e) => upd({ filter_template: e.target.value })}
                                  placeholder="{{telefone}} ou {{boleto_id}}" className="w-full border border-gray-200 rounded px-2 py-1 text-[11px] font-mono" />
                              </div>
                            </div>
                          )}

                          {/* SELECT: colunas a trazer + placeholder */}
                          {d.operation === 'select' && (
                            <>
                              <div className="grid grid-cols-3 gap-2">
                                <div>
                                  <label className="text-[10px] text-gray-500 mb-0.5 block">Colunas a trazer</label>
                                  <input value={d.columns} onChange={(e) => upd({ columns: e.target.value })}
                                    placeholder="* (todas)" className="w-full border border-gray-200 rounded px-2 py-1 text-[11px] font-mono" />
                                </div>
                                <div>
                                  <label className="text-[10px] text-gray-500 mb-0.5 block">Máx. linhas</label>
                                  <input type="number" value={d.max_rows} onChange={(e) => upd({ max_rows: parseInt(e.target.value) || 5 })}
                                    className="w-full border border-gray-200 rounded px-2 py-1 text-[11px]" />
                                </div>
                                <div>
                                  <label className="text-[10px] text-gray-500 mb-0.5 block">Salvar resultado em *</label>
                                  <input value={d.output_placeholder} onChange={(e) => upd({ output_placeholder: e.target.value.replace(/[^a-z0-9_]/gi, '_') })}
                                    placeholder="contexto_sienge" className="w-full border border-gray-200 rounded px-2 py-1 text-[11px] font-mono" />
                                </div>
                              </div>
                              <p className="text-[10px] text-gray-400">
                                {d.output_placeholder
                                  ? <>Use <code className="bg-gray-100 px-1 rounded">{`{{${d.output_placeholder}}}`}</code> nas instruções do subagente.</>
                                  : <>Valores de filtro: <code className="bg-gray-100 px-1 rounded">{'{{telefone}}'}</code> <code className="bg-gray-100 px-1 rounded">{'{{cpf}}'}</code> — automáticos.</>}
                              </p>
                            </>
                          )}

                          {/* INSERT/UPDATE/UPSERT: valores a gravar (coluna = valor) */}
                          {d.operation !== 'select' && (
                            <div>
                              <label className="text-[10px] text-gray-500 mb-0.5 block">Valores a gravar (coluna = valor)</label>
                              {(d.value_map || []).map((vm, vi) => {
                                const updVm = (patch: Partial<{ col: string; val: string }>) =>
                                  upd({ value_map: (d.value_map || []).map((y, k) => k === vi ? { ...y, ...patch } : y) })
                                return (
                                  <div key={vi} className="flex items-center gap-1 mb-1">
                                    {dbSchema[d.table_name]?.length ? (
                                      <select value={vm.col} onChange={(e) => updVm({ col: e.target.value })}
                                        className="w-1/3 border border-gray-200 rounded px-1.5 py-1 text-[11px] font-mono bg-white">
                                        <option value="">— Coluna —</option>
                                        {dbSchema[d.table_name].map(col => <option key={col} value={col}>{col}</option>)}
                                      </select>
                                    ) : (
                                      <input value={vm.col} onChange={(e) => updVm({ col: e.target.value })}
                                        placeholder="coluna" className="w-1/3 border border-gray-200 rounded px-1.5 py-1 text-[11px] font-mono" />
                                    )}
                                    <span className="text-gray-400 text-xs">=</span>
                                    <input value={vm.val} onChange={(e) => updVm({ val: e.target.value })}
                                      placeholder="comprovante_recebido ou {{verdict}}" className="flex-1 border border-gray-200 rounded px-1.5 py-1 text-[11px] font-mono" />
                                    <button onClick={() => upd({ value_map: (d.value_map || []).filter((_, k) => k !== vi) })}
                                      className="text-gray-400 hover:text-red-500 shrink-0"><X className="w-3 h-3" /></button>
                                  </div>
                                )
                              })}
                              <button onClick={() => upd({ value_map: [...(d.value_map || []), { col: '', val: '' }] })}
                                className="text-[11px] text-emerald-600 hover:text-emerald-700">+ valor</button>
                              <p className="text-[10px] text-gray-400 mt-1">
                                Placeholders: <code className="bg-gray-100 px-1 rounded">{'{{verdict}}'}</code> <code className="bg-gray-100 px-1 rounded">{'{{boleto_id}}'}</code> <code className="bg-gray-100 px-1 rounded">{'{{telefone_norm}}'}</code> <code className="bg-gray-100 px-1 rounded">{'{{cpf}}'}</code> <code className="bg-gray-100 px-1 rounded">{'{{hoje}}'}</code> + campos extraídos.
                              </p>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>

                  {/* Ferramentas do subagente (toda ferramenta é consumida por um subagente) */}
                  <div className="border-t border-gray-200 pt-3">
                    <label className="text-[11px] font-medium text-gray-500 mb-1 block flex items-center gap-1">
                      <Wrench className="w-3 h-3" /> Ferramentas do subagente
                    </label>
                    {!s.id ? (
                      <p className="text-[11px] text-amber-600 italic">Salve o agente primeiro para anexar ferramentas a este subagente.</p>
                    ) : (
                      <>
                        {(s.tools || []).length > 0 && (
                          <div className="space-y-1.5 mb-2">
                            {(s.tools || []).map(t => (
                              <div key={t.id} className="flex items-center justify-between rounded-lg border border-gray-100 bg-white px-2.5 py-1.5">
                                <div className="min-w-0">
                                  <div className="text-xs font-medium text-gray-800 truncate">{t.name}</div>
                                  <div className="text-[10px] text-gray-400">
                                    {t.tool_type === 'payment_scheduler' ? '📅 Agendador de Pagamentos' : t.tool_type === 'api_call' ? '🔌 Chamar API' : '🔗 Webhook'}
                                  </div>
                                </div>
                                <button
                                  onClick={() => { setEditingTool(t); setEditingToolSubIdx(i); setToolEditorOpen(true) }}
                                  className="shrink-0 px-2 py-1 text-[11px] text-gray-500 hover:text-gray-800 hover:bg-gray-100 rounded-md"
                                >Editar</button>
                              </div>
                            ))}
                          </div>
                        )}
                        <button
                          onClick={() => { setEditingTool(null); setEditingToolSubIdx(i); setToolEditorOpen(true) }}
                          className="flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-md border border-dashed border-gray-300 text-gray-500 hover:border-emerald-400 hover:text-emerald-600 transition-colors"
                        >
                          <Plus className="w-3 h-3" /> Adicionar ferramenta
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          <button
            onClick={() => setSubagents([...subagents, {
              name: '', trigger_type: 'image', invocation: 'on_media',
              delegation_description: '', escalation_message: '',
              triggerReplyFlow: '', triggerButtons: '', terminalTool: '',
              extraction_prompt: '', extraction_model: 'gpt-4o-mini',
              instructions: '', output_format: '', model: 'gpt-4o-mini', is_active: true, sort_order: subagents.length,
              datasources: [], tools: [],
            }])}
            className="flex items-center gap-1.5 px-3 py-2 text-xs text-emerald-700 border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 rounded-lg transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Adicionar subagente
          </button>
        </Section>

      </div>

      {/* Footer salvar */}
      <div className="mt-8 flex justify-end">
        <button
          onClick={handleSave}
          disabled={loading}
          className={cn(
            'flex items-center gap-2 px-6 py-2.5 rounded-lg font-medium text-sm transition-colors',
            saved
              ? 'bg-emerald-100 text-emerald-700 border border-emerald-200'
              : 'bg-emerald-600 text-white hover:bg-emerald-700'
          )}
        >
          <Save className="w-4 h-4" />
          {loading ? 'Salvando...' : saved ? 'Salvo com sucesso ✓' : 'Salvar Agente'}
        </button>
      </div>
      {/* ToolEditor modal */}
      {toolEditorOpen && agent && (
        <ToolEditor
          agentId={agent.id}
          subagentId={editingToolSubIdx !== null ? (subagents[editingToolSubIdx]?.id || null) : null}
          tool={editingTool}
          apiConnections={apiConnections}
          onSaved={(saved) => {
            if (editingToolSubIdx !== null) {
              const si = editingToolSubIdx
              setSubagents(prev => prev.map((x, j) => {
                if (j !== si) return x
                const list = x.tools || []
                const idx = list.findIndex(t => t.id === saved.id)
                const tools = idx >= 0 ? list.map((t, k) => k === idx ? saved : t) : [...list, saved]
                return { ...x, tools }
              }))
            } else {
              setTools(prev => {
                const idx = prev.findIndex(t => t.id === saved.id)
                if (idx >= 0) { const next = [...prev]; next[idx] = saved; return next }
                return [...prev, saved]
              })
            }
          }}
          onDeleted={(toolId) => {
            if (editingToolSubIdx !== null) {
              const si = editingToolSubIdx
              setSubagents(prev => prev.map((x, j) => j === si ? { ...x, tools: (x.tools || []).filter(t => t.id !== toolId) } : x))
            } else {
              setTools(prev => prev.filter(t => t.id !== toolId))
            }
          }}
          onClose={() => { setToolEditorOpen(false); setEditingTool(null); setEditingToolSubIdx(null) }}
        />
      )}
    </div>
  )
}

// ── Sub-componentes ────────────────────────────────────────────────────────────

function Section({
  icon, title, children,
}: {
  icon: React.ReactNode; title: string; children: React.ReactNode
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-3 border-b border-gray-100 bg-gray-50">
        <span className="text-gray-500">{icon}</span>
        <h2 className="text-sm font-semibold text-gray-700">{title}</h2>
      </div>
      <div className="p-5 space-y-3">
        {children}
      </div>
    </div>
  )
}

function Toggle({
  label, checked, onChange, hint,
}: {
  label: React.ReactNode; checked: boolean; onChange: (v: boolean) => void; hint?: string
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer group">
      <div
        onClick={() => onChange(!checked)}
        className={cn(
          'relative w-9 h-5 rounded-full transition-colors shrink-0 mt-0.5 cursor-pointer',
          checked ? 'bg-emerald-500' : 'bg-gray-300'
        )}
      >
        <span className={cn(
          'absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0'
        )} />
      </div>
      <div>
        <div className="text-sm text-gray-700 font-medium group-hover:text-gray-900">{label}</div>
        {hint && <div className="text-[11px] text-gray-400 mt-0.5">{hint}</div>}
      </div>
    </label>
  )
}

function Slider({
  label, value, min, max, step, onChange, leftLabel, rightLabel, format,
}: {
  label: string; value: number; min: number; max: number; step: number
  onChange: (v: number) => void; leftLabel: string; rightLabel: string; format: (v: number) => string
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-xs text-gray-500">{label}</label>
        <span className="text-xs font-medium text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">
          {format(value)}
        </span>
      </div>
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-emerald-500"
      />
      <div className="flex justify-between text-[10px] text-gray-400 mt-0.5">
        <span>{leftLabel}</span>
        <span>{rightLabel}</span>
      </div>
    </div>
  )
}
