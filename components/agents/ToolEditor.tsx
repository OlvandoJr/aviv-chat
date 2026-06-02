'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { X, Save, Trash2, Wrench, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AgentTool, ToolType, ApiConnection } from '@/lib/types'

interface Props {
  agentId:        string
  tool:           AgentTool | null        // null = novo
  apiConnections: ApiConnection[]
  onSaved:        (tool: AgentTool) => void
  onDeleted?:     (toolId: string) => void
  onClose:        () => void
}

const TOOL_TYPES: { value: ToolType; label: string; icon: string; description: string }[] = [
  {
    value:       'payment_scheduler',
    label:       'Agendador de Pagamentos',
    icon:        '📅',
    description: 'Permite que o cliente agende o pagamento de um boleto em uma data futura (dias úteis). Cria evento no Google Calendar se configurado.',
  },
  {
    value:       'webhook',
    label:       'Webhook',
    icon:        '🔗',
    description: 'Envia dados para uma URL externa quando acionado pelo AI.',
  },
]

export default function ToolEditor({ agentId, tool, apiConnections, onSaved, onDeleted, onClose }: Props) {
  const supabase = createClient()
  const isNew    = !tool

  const [name,            setName]           = useState(tool?.name          || '')
  const [description,     setDescription]    = useState(tool?.description   || '')
  const [toolType,        setToolType]       = useState<ToolType>(tool?.tool_type || 'payment_scheduler')
  const [apiConnId,       setApiConnId]      = useState<string>(tool?.api_connection_id || '')
  const [isActive,        setIsActive]       = useState(tool?.is_active     ?? true)
  const [webhookUrl,      setWebhookUrl]     = useState<string>((tool?.config as any)?.webhook_url || '')

  const [loading,         setLoading]        = useState(false)
  const [error,           setError]          = useState('')

  const gcalConnections = apiConnections.filter(c => c.provider === 'google_calendar' && c.is_active)

  async function handleSave() {
    if (!name.trim()) { setError('Nome obrigatório'); return }
    if (!description.trim()) { setError('Descrição obrigatória'); return }

    setLoading(true)
    setError('')

    const config: Record<string, any> = {}
    if (toolType === 'webhook' && webhookUrl.trim()) {
      config.webhook_url = webhookUrl.trim()
    }

    const payload = {
      agent_id:          agentId,
      name:              name.trim(),
      description:       description.trim(),
      tool_type:         toolType,
      config,
      api_connection_id: apiConnId || null,
      is_active:         isActive,
    }

    if (isNew) {
      const { data, error: err } = await supabase
        .from('chat_agent_tools')
        .insert({ ...payload, sort_order: 0 })
        .select('*, api_connection:chat_api_connections(*)')
        .single()

      if (err || !data) {
        setError('Erro ao criar ferramenta: ' + (err?.message || 'desconhecido'))
        setLoading(false)
        return
      }
      onSaved(data as AgentTool)
    } else {
      const { data, error: err } = await supabase
        .from('chat_agent_tools')
        .update(payload)
        .eq('id', tool!.id)
        .select('*, api_connection:chat_api_connections(*)')
        .single()

      if (err || !data) {
        setError('Erro ao salvar: ' + (err?.message || 'desconhecido'))
        setLoading(false)
        return
      }
      onSaved(data as AgentTool)
    }

    setLoading(false)
    onClose()
  }

  async function handleDelete() {
    if (!tool || !confirm('Remover esta ferramenta?')) return
    await supabase.from('chat_agent_tools').delete().eq('id', tool.id)
    onDeleted?.(tool.id)
    onClose()
  }

  const selectedType = TOOL_TYPES.find(t => t.value === toolType)

  return (
    /* Backdrop */
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <Wrench className="w-4 h-4 text-emerald-600" />
            <h2 className="text-sm font-semibold text-gray-800">
              {isNew ? 'Nova Ferramenta' : 'Editar Ferramenta'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-400 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
              {error}
            </div>
          )}

          {/* Tipo */}
          <div>
            <label className="text-xs text-gray-500 mb-2 block font-medium">Tipo de Ferramenta</label>
            <div className="grid grid-cols-1 gap-2">
              {TOOL_TYPES.map(t => (
                <label
                  key={t.value}
                  className={cn(
                    'flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors',
                    toolType === t.value
                      ? 'border-emerald-400 bg-emerald-50'
                      : 'border-gray-200 hover:border-gray-300'
                  )}
                >
                  <input
                    type="radio"
                    name="tool_type"
                    value={t.value}
                    checked={toolType === t.value}
                    onChange={() => setToolType(t.value)}
                    className="mt-0.5 accent-emerald-500"
                  />
                  <div>
                    <div className="text-sm font-medium text-gray-800">{t.icon} {t.label}</div>
                    <div className="text-xs text-gray-500 mt-0.5">{t.description}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Nome */}
          <div>
            <label className="text-xs text-gray-500 mb-1 block font-medium">Nome *</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={selectedType?.label || 'Nome da ferramenta'}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>

          {/* Descrição */}
          <div>
            <label className="text-xs text-gray-500 mb-1 block font-medium">
              Descrição para o AI *
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Explique ao AI quando e como usar esta ferramenta..."
              rows={3}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-none"
            />
            <p className="text-[11px] text-gray-400 mt-0.5">
              Esta descrição é enviada ao modelo para que ele saiba quando acionar a ferramenta.
            </p>
          </div>

          {/* Config por tipo */}
          {toolType === 'payment_scheduler' && (
            <div>
              <label className="text-xs text-gray-500 mb-1 block font-medium">
                Integração Google Calendar (opcional)
              </label>
              <select
                value={apiConnId}
                onChange={(e) => setApiConnId(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white"
              >
                <option value="">— Sem Google Calendar —</option>
                {gcalConnections.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              {gcalConnections.length === 0 && (
                <p className="text-[11px] text-amber-600 mt-1">
                  Nenhuma conexão Google Calendar ativa. Configure em{' '}
                  <a href="/integrations" className="underline">Integrações</a>.
                </p>
              )}
            </div>
          )}

          {toolType === 'webhook' && (
            <>
              <div>
                <label className="text-xs text-gray-500 mb-1 block font-medium">URL do Webhook *</label>
                <input
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  placeholder="https://seu-webhook.com/endpoint"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 font-mono"
                />
              </div>
            </>
          )}

          {/* Ativo */}
          <label className="flex items-center gap-2 cursor-pointer group">
            <div
              onClick={() => setIsActive(!isActive)}
              className={cn(
                'w-9 h-5 rounded-full transition-colors cursor-pointer relative',
                isActive ? 'bg-emerald-500' : 'bg-gray-300'
              )}
            >
              <div className={cn(
                'absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform',
                isActive ? 'translate-x-4' : 'translate-x-0'
              )} />
            </div>
            <span className="text-sm text-gray-700">Ferramenta ativa</span>
          </label>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-gray-100">
          <div>
            {!isNew && (
              <button
                onClick={handleDelete}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg text-red-600 hover:bg-red-50 border border-red-200 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Remover
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
            >
              Cancelar
            </button>
            <button
              onClick={handleSave}
              disabled={loading}
              className="flex items-center gap-1.5 px-4 py-1.5 text-xs rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 transition-colors font-medium disabled:opacity-60"
            >
              <Save className="w-3.5 h-3.5" />
              {loading ? 'Salvando...' : 'Salvar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
