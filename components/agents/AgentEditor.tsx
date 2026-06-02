'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import {
  ArrowLeft, Save, Bot, Cpu, MessageSquare, Database,
  AlertTriangle, GitBranch, Star, Trash2, Plus, X, Tags, Wrench,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type {
  Agent, AgentModel, AgentRule, AgentRuleType, Inbox,
  ContactAttributeDef, AttributeFieldType, AttributeAction,
  AgentTool, ApiConnection,
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


export default function AgentEditor({ agent, rules: initialRules, inboxes, availableModels, attrDefs: initialAttrDefs, tools: initialTools, apiConnections }: Props) {
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

        {/* ── FERRAMENTAS ── */}
        {!isNew && (
          <Section icon={<Wrench className="w-4 h-4" />} title="Ferramentas">
            <p className="text-xs text-gray-400">
              Ferramentas ampliam o AI com ações reais — o modelo decide quando acioná-las com base na conversa.
            </p>

            {tools.length > 0 && (
              <div className="space-y-2 mt-1">
                {tools.map(t => (
                  <div
                    key={t.id}
                    className="flex items-center justify-between p-3 rounded-xl border border-gray-100 hover:border-gray-200 bg-gray-50 transition-colors"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={cn(
                        'w-1.5 h-1.5 rounded-full shrink-0',
                        t.is_active ? 'bg-emerald-400' : 'bg-gray-300'
                      )} />
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-gray-800 truncate">{t.name}</div>
                        <div className="text-[11px] text-gray-400 truncate">
                          {t.tool_type === 'payment_scheduler' ? '📅 Agendador de Pagamentos' : '🔗 Webhook'}
                          {t.api_connection && (
                            <span className="ml-1 text-emerald-600">· {t.api_connection.name}</span>
                          )}
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => { setEditingTool(t); setToolEditorOpen(true) }}
                      className="shrink-0 px-2 py-1 text-xs text-gray-500 hover:text-gray-800 hover:bg-gray-200 rounded-lg transition-colors ml-2"
                    >
                      Editar
                    </button>
                  </div>
                ))}
              </div>
            )}

            <button
              onClick={() => { setEditingTool(null); setToolEditorOpen(true) }}
              className="flex items-center gap-1.5 mt-1 px-3 py-1.5 text-xs rounded-lg border border-dashed border-gray-300 text-gray-500 hover:border-emerald-400 hover:text-emerald-600 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              Adicionar ferramenta
            </button>
          </Section>
        )}

        {isNew && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-xs text-amber-700">
            💡 Salve o agente primeiro para poder adicionar ferramentas.
          </div>
        )}

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
          tool={editingTool}
          apiConnections={apiConnections}
          onSaved={(saved) => {
            setTools(prev => {
              const idx = prev.findIndex(t => t.id === saved.id)
              if (idx >= 0) {
                const next = [...prev]
                next[idx] = saved
                return next
              }
              return [...prev, saved]
            })
          }}
          onDeleted={(toolId) => setTools(prev => prev.filter(t => t.id !== toolId))}
          onClose={() => { setToolEditorOpen(false); setEditingTool(null) }}
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
