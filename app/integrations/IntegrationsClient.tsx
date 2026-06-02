'use client'

import { useState } from 'react'
import { Plus, Calendar, CheckCircle2, XCircle, Puzzle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ApiConnection } from '@/lib/types'
import ApiConnectionEditor from '@/components/integrations/ApiConnectionEditor'

interface Props {
  initialConnections: ApiConnection[]
}

const PROVIDER_META: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  google_calendar: {
    label: 'Google Calendar',
    icon:  <Calendar className="w-5 h-5" />,
    color: 'text-blue-600 bg-blue-50 border-blue-200',
  },
}

export default function IntegrationsClient({ initialConnections }: Props) {
  const [connections, setConnections] = useState<ApiConnection[]>(initialConnections)
  const [editorOpen,  setEditorOpen]  = useState(false)
  const [editing,     setEditing]     = useState<ApiConnection | null>(null)

  function openNew() {
    setEditing(null)
    setEditorOpen(true)
  }

  function openEdit(conn: ApiConnection) {
    setEditing(conn)
    setEditorOpen(true)
  }

  function handleSaved(conn: ApiConnection) {
    setConnections(prev => {
      const idx = prev.findIndex(c => c.id === conn.id)
      if (idx >= 0) {
        const next = [...prev]
        next[idx] = conn
        return next
      }
      return [...prev, conn]
    })
  }

  function handleDeleted(id: string) {
    setConnections(prev => prev.filter(c => c.id !== id))
  }

  return (
    <div className="max-w-3xl mx-auto p-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <Puzzle className="w-5 h-5 text-emerald-600" />
            Integrações
          </h1>
          <p className="text-sm text-gray-400 mt-0.5">
            Conecte APIs externas para usar nas ferramentas dos agentes.
          </p>
        </div>
        <button
          onClick={openNew}
          className="flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 transition-colors font-medium"
        >
          <Plus className="w-4 h-4" />
          Nova Integração
        </button>
      </div>

      {/* Lista de conexões */}
      {connections.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
          <Puzzle className="w-10 h-10 text-gray-300 mx-auto mb-3" />
          <p className="text-sm text-gray-500 font-medium">Nenhuma integração configurada</p>
          <p className="text-xs text-gray-400 mt-1 mb-4">
            Adicione o Google Calendar para criar eventos de pagamentos agendados.
          </p>
          <button
            onClick={openNew}
            className="flex items-center gap-1.5 mx-auto px-4 py-2 text-sm rounded-lg border border-dashed border-gray-300 text-gray-500 hover:border-emerald-400 hover:text-emerald-600 transition-colors"
          >
            <Plus className="w-4 h-4" />
            Adicionar integração
          </button>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {connections.map(conn => {
            const meta = PROVIDER_META[conn.provider]
            return (
              <div
                key={conn.id}
                className="bg-white border border-gray-200 rounded-xl p-5 hover:border-gray-300 transition-colors cursor-pointer"
                onClick={() => openEdit(conn)}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className={cn(
                    'w-10 h-10 rounded-xl flex items-center justify-center border shrink-0',
                    meta?.color || 'text-gray-500 bg-gray-50 border-gray-200'
                  )}>
                    {meta?.icon || <Puzzle className="w-5 h-5" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-gray-800 truncate">{conn.name}</div>
                    <div className="text-xs text-gray-400 mt-0.5">
                      {meta?.label || conn.provider}
                    </div>
                    {conn.config?.calendar_id && (
                      <div className="text-[11px] text-gray-400 mt-1 font-mono truncate">
                        {conn.config.calendar_id}
                      </div>
                    )}
                  </div>
                  <div className="shrink-0">
                    {conn.is_active
                      ? <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                      : <XCircle className="w-4 h-4 text-gray-300" />
                    }
                  </div>
                </div>

                {conn.credentials?.client_email && (
                  <div className="mt-3 pt-3 border-t border-gray-100">
                    <div className="text-[11px] text-gray-400 font-mono truncate">
                      {conn.credentials.client_email}
                    </div>
                  </div>
                )}
              </div>
            )
          })}

          {/* Card "Adicionar" */}
          <button
            onClick={openNew}
            className="bg-white border border-dashed border-gray-300 rounded-xl p-5 hover:border-emerald-400 hover:text-emerald-600 transition-colors text-gray-400 flex flex-col items-center justify-center gap-2 min-h-[120px]"
          >
            <Plus className="w-6 h-6" />
            <span className="text-sm font-medium">Nova Integração</span>
          </button>
        </div>
      )}

      {/* Editor modal */}
      {editorOpen && (
        <ApiConnectionEditor
          connection={editing}
          onSaved={handleSaved}
          onDeleted={handleDeleted}
          onClose={() => setEditorOpen(false)}
        />
      )}
    </div>
  )
}
