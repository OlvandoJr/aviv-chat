'use client'

import { useEffect, useState }    from 'react'
import { createClient }           from '@/lib/supabase/client'
import { X, Send, Search, LayoutTemplate } from 'lucide-react'
import { cn }                     from '@/lib/utils'
import type { WaTemplate }        from '@/lib/types'

interface Props {
  conversationId: string
  onClose:        () => void
  onSent?:        () => void
}

function countVarNums(text: string): number[] {
  const nums = new Set<number>()
  for (const m of text.matchAll(/\{\{(\d+)\}\}/g)) nums.add(parseInt(m[1]))
  return [...nums].sort((a, b) => a - b)
}

function renderTemplate(text: string, vars: Record<number, string>) {
  let out = text
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v || `{{${k}}}`)
  }
  return out
}

const CATEGORY_COLOR: Record<string, string> = {
  MARKETING:      'bg-orange-100 text-orange-600',
  UTILITY:        'bg-blue-100   text-blue-600',
  AUTHENTICATION: 'bg-purple-100 text-purple-600',
}

export default function TemplateSelector({ conversationId, onClose, onSent }: Props) {
  const supabase = createClient()

  const [templates,  setTemplates]  = useState<WaTemplate[]>([])
  const [loading,    setLoading]    = useState(true)
  const [sending,    setSending]    = useState(false)
  const [error,      setError]      = useState<string | null>(null)
  const [search,     setSearch]     = useState('')
  const [selected,   setSelected]   = useState<WaTemplate | null>(null)
  const [variables,  setVariables]  = useState<Record<number, string>>({})

  // Buscar templates aprovados para o inbox desta conversa
  useEffect(() => {
    async function load() {
      setLoading(true)
      const { data: conv } = await supabase
        .from('chat_conversations')
        .select('inbox_id')
        .eq('id', conversationId)
        .single()

      const resp = await fetch(`/api/templates${conv?.inbox_id ? `?inboxId=${conv.inbox_id}` : ''}`)
      const result = await resp.json()
      const approved = (result.templates || []).filter((t: WaTemplate) => t.status === 'APPROVED')
      setTemplates(approved)
      setLoading(false)
    }
    load()
  }, [conversationId])

  function selectTemplate(t: WaTemplate) {
    setSelected(t)
    setVariables({})
    setError(null)
  }

  // Todos os números de variáveis (header + body juntos, em sequência)
  const headerVarNums = selected?.header_type === 'TEXT' && selected.header_text
    ? countVarNums(selected.header_text)
    : []
  const bodyVarNums   = selected ? countVarNums(selected.body_text) : []
  const allVarNums    = [...new Set([...headerVarNums, ...bodyVarNums])].sort((a, b) => a - b)

  const allFilled = allVarNums.every(n => variables[n]?.trim())

  async function handleSend() {
    if (!selected) return
    setSending(true)
    setError(null)

    const orderedVars = allVarNums.map(n => variables[n] || '')

    const { data: { session } } = await supabase.auth.getSession()

    const resp = await fetch('/api/send-template', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
      body:    JSON.stringify({ conversationId, templateId: selected.id, variables: orderedVars }),
    })

    if (!resp.ok) {
      const result = await resp.json().catch(() => ({}))
      setError(result.error || 'Falha ao enviar template')
      setSending(false)
      return
    }

    onSent?.()
    onClose()
  }

  const filtered = templates.filter(t =>
    t.name.includes(search.toLowerCase()) || t.body_text.toLowerCase().includes(search.toLowerCase())
  )

  return (
    /* Overlay */
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full sm:max-w-lg bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header do modal */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <LayoutTemplate className="w-4 h-4 text-emerald-600" />
            <h2 className="text-sm font-semibold text-gray-900">Selecionar template</h2>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Conteúdo scrollável */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center h-32">
              <p className="text-sm text-gray-400">Carregando templates...</p>
            </div>
          ) : templates.length === 0 ? (
            <div className="p-8 text-center">
              <p className="text-sm text-gray-500">Nenhum template aprovado disponível.</p>
              <p className="text-xs text-gray-400 mt-1">Crie templates em <strong>Agentes IA → Templates</strong>.</p>
            </div>
          ) : (
            <>
              {/* Busca */}
              <div className="px-4 py-3 border-b border-gray-50">
                <div className="flex items-center gap-2 bg-gray-100 rounded-xl px-3 py-1.5">
                  <Search className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                  <input
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Buscar template..."
                    className="flex-1 bg-transparent text-sm outline-none text-gray-900 placeholder:text-gray-400"
                    autoFocus
                  />
                </div>
              </div>

              {/* Lista */}
              {!selected && (
                <div className="divide-y divide-gray-50">
                  {filtered.length === 0 ? (
                    <p className="text-sm text-gray-400 text-center py-8">Nenhum resultado para "{search}"</p>
                  ) : filtered.map(t => (
                    <button
                      key={t.id}
                      onClick={() => selectTemplate(t)}
                      className="w-full text-left px-5 py-3.5 hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-mono font-medium text-gray-800">{t.name}</span>
                        <span className={cn('text-[9px] font-bold px-1.5 py-0 rounded-full uppercase', CATEGORY_COLOR[t.category])}>
                          {t.category}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500 line-clamp-2">{t.body_text}</p>
                      {t.body_var_count > 0 && (
                        <p className="text-[10px] text-gray-400 mt-1">{t.body_var_count} variável(is)</p>
                      )}
                    </button>
                  ))}
                </div>
              )}

              {/* Template selecionado — preencher variáveis */}
              {selected && (
                <div className="px-5 py-4 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono font-semibold text-gray-800">{selected.name}</span>
                      <span className={cn('text-[9px] font-bold px-1.5 py-0 rounded-full uppercase', CATEGORY_COLOR[selected.category])}>
                        {selected.category}
                      </span>
                    </div>
                    <button onClick={() => setSelected(null)} className="text-xs text-gray-400 hover:text-gray-600 underline">
                      Trocar template
                    </button>
                  </div>

                  {/* Variáveis */}
                  {allVarNums.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-gray-600">Preencha as variáveis:</p>
                      {allVarNums.map(n => (
                        <div key={n}>
                          <label className="text-[11px] text-gray-500 mb-1 block">
                            Variável {`{{${n}}}`}
                            {headerVarNums.includes(n) ? ' — header' : ' — corpo'}
                          </label>
                          <input
                            value={variables[n] || ''}
                            onChange={e => setVariables(v => ({ ...v, [n]: e.target.value }))}
                            placeholder={`Valor para {{${n}}}`}
                            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                          />
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Preview */}
                  <div className="bg-[#f0f2f5] rounded-xl p-3 space-y-1">
                    <p className="text-[10px] text-gray-400 uppercase font-semibold tracking-wide mb-2">Pré-visualização</p>
                    {selected.header_text && (
                      <p className="text-xs font-semibold text-gray-800">
                        {renderTemplate(selected.header_text, variables)}
                      </p>
                    )}
                    <p className="text-sm text-gray-800 whitespace-pre-wrap">
                      {renderTemplate(selected.body_text, variables)}
                    </p>
                    {selected.footer_text && (
                      <p className="text-xs text-gray-400">{selected.footer_text}</p>
                    )}
                    {(selected.buttons as any[]).length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-1">
                        {(selected.buttons as any[]).map((b: any, i: number) => (
                          <span key={i} className="text-[11px] border border-blue-300 text-blue-600 rounded px-2 py-0.5">{b.text}</span>
                        ))}
                      </div>
                    )}
                  </div>

                  {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {selected && (
          <div className="px-5 py-4 border-t border-gray-100 flex justify-end gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors">
              Cancelar
            </button>
            <button
              onClick={handleSend}
              disabled={sending || (allVarNums.length > 0 && !allFilled)}
              className={cn(
                'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-colors',
                sending || (allVarNums.length > 0 && !allFilled)
                  ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                  : 'bg-emerald-600 hover:bg-emerald-700 text-white'
              )}
            >
              <Send className="w-3.5 h-3.5" />
              {sending ? 'Enviando...' : 'Enviar template'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
