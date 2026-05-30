'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import {
  ArrowLeft, Save, Bot, Cpu, MessageSquare, Database,
  AlertTriangle, GitBranch, Star, Trash2, Plus, X
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Agent, AgentRule, AgentRuleType } from '@/lib/types'

interface Props {
  agent: Agent | null
  rules: AgentRule[]
}

const MODELS: { value: AgentModel; label: string; desc: string }[] = [
  { value: 'gpt-4o-mini',   label: 'GPT-4o Mini',  desc: 'Rápido e econômico — ideal para maioria dos casos' },
  { value: 'gpt-4o',        label: 'GPT-4o',        desc: 'Mais capaz — melhor para casos complexos' },
  { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo', desc: 'Mais antigo — alta velocidade' },
]

export default function AgentEditor({ agent, rules: initialRules }: Props) {
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

  const [escalationKeywords,  setEscalationKeywords] = useState<string[]>(agent?.escalation_keywords || [])
  const [escalationMessage,   setEscalationMessage]  = useState(agent?.escalation_message || '')
  const [newKeyword,          setNewKeyword]         = useState('')

  const [rules,               setRules]              = useState<Omit<AgentRule, 'id' | 'created_at'>[]>(
    initialRules.map(r => ({ agent_id: r.agent_id, rule_type: r.rule_type, rule_value: r.rule_value, priority: r.priority }))
  )
  const [newRuleType,         setNewRuleType]        = useState<AgentRuleType>('tag')
  const [newRuleValue,        setNewRuleValue]       = useState('')

  const [loading,             setLoading]            = useState(false)
  const [error,               setError]              = useState('')
  const [saved,               setSaved]              = useState(false)

  // ── Helpers ────────────────────────────────────────────────────────────────
  function addKeyword() {
    const kw = newKeyword.trim().toLowerCase()
    if (kw && !escalationKeywords.includes(kw)) {
      setEscalationKeywords([...escalationKeywords, kw])
    }
    setNewKeyword('')
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
      escalation_keywords:  escalationKeywords,
      escalation_message:   escalationMessage.trim() || null,
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

    if (rules.length > 0) {
      await supabase.from('chat_agent_rules').insert(
        rules.map((r, i) => ({ agent_id: agentId, rule_type: r.rule_type, rule_value: r.rule_value, priority: i }))
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
            <label className="text-xs text-gray-500 mb-2 block">Modelo</label>
            <div className="grid grid-cols-3 gap-2">
              {MODELS.map((m) => (
                <button
                  key={m.value}
                  onClick={() => setModel(m.value)}
                  className={cn(
                    'text-left p-3 rounded-lg border text-sm transition-colors',
                    model === m.value
                      ? 'border-emerald-500 bg-emerald-50 text-emerald-800'
                      : 'border-gray-200 hover:border-gray-300 text-gray-700'
                  )}
                >
                  <div className="font-medium">{m.label}</div>
                  <div className="text-[11px] text-gray-400 mt-0.5 leading-tight">{m.desc}</div>
                </button>
              ))}
            </div>
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

        {/* ── ESCALAÇÃO ── */}
        <Section icon={<AlertTriangle className="w-4 h-4" />} title="Escalação para Atendente Humano">
          <div className="space-y-3">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">
                Palavras-chave de escalação automática
              </label>
              <p className="text-[11px] text-gray-400 mb-2">
                Se o cliente usar essas palavras, o sistema escala independente da IA
              </p>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {escalationKeywords.map((kw) => (
                  <span
                    key={kw}
                    className="flex items-center gap-1 px-2 py-0.5 bg-red-50 text-red-700 text-xs rounded-full border border-red-200"
                  >
                    {kw}
                    <button
                      onClick={() => setEscalationKeywords(escalationKeywords.filter(k => k !== kw))}
                      className="hover:text-red-900"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  value={newKeyword}
                  onChange={(e) => setNewKeyword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addKeyword())}
                  placeholder="Digite e pressione Enter"
                  className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
                <button
                  onClick={addKeyword}
                  className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm transition-colors"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Mensagem ao escalar</label>
              <textarea
                value={escalationMessage}
                onChange={(e) => setEscalationMessage(e.target.value)}
                placeholder='Ex: "Entendido! Vou encaminhar você para um atendente agora mesmo. Aguarde um momento. 🙏"'
                rows={2}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-none"
              />
            </div>
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
              Este agente não é o padrão. Defina regras abaixo ou atribua manualmente nas conversas.
            </div>
          )}

          {/* Regras por tag */}
          <div className="mt-4">
            <label className="text-xs text-gray-500 mb-2 block font-medium">
              Regras de roteamento automático
            </label>

            {rules.length > 0 && (
              <div className="space-y-1.5 mb-3">
                {rules.map((rule, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm">
                    <span className="px-2 py-0.5 bg-blue-50 text-blue-700 rounded text-xs font-medium border border-blue-200">
                      {rule.rule_type}
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
                <option value="inbox">Inbox</option>
              </select>
              <input
                value={newRuleValue}
                onChange={(e) => setNewRuleValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addRule())}
                placeholder={newRuleType === 'tag' ? 'nome-da-tag' : newRuleType === 'keyword' ? 'palavra chave' : 'inbox-id'}
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
