'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Plus, Pencil, Trash2, Play, Copy, CheckCircle, XCircle, Clock,
  AlertTriangle, Plug,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import MethodBadge from './MethodBadge'
import type { ApiConfig } from '@/lib/types'

interface Props { apis: ApiConfig[] }

export default function ApiList({ apis: initial }: Props) {
  const router              = useRouter()
  const [apis, setApis]     = useState(initial)
  const [testing, setTesting] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, { ok: boolean; status?: number; duration_ms?: number }>>({})
  const [deleting, setDeleting] = useState<string | null>(null)

  async function quickTest(api: ApiConfig) {
    setTesting(api.id)
    try {
      const supabase = createClient()
      const { data } = await supabase.functions.invoke('test-api-call', {
        body: { apiConfigId: api.id, testVariables: {} },
      })
      setResults(r => ({ ...r, [api.id]: { ok: data?.ok, status: data?.status, duration_ms: data?.duration_ms } }))
      // Update last_tested_at in DB
      await supabase
        .from('chat_api_configs')
        .update({ last_tested_at: new Date().toISOString(), last_test_status: data?.ok ? 'success' : 'error' })
        .eq('id', api.id)
    } catch {
      setResults(r => ({ ...r, [api.id]: { ok: false } }))
    } finally {
      setTesting(null)
    }
  }

  async function clone(api: ApiConfig) {
    const supabase = createClient()
    const { data } = await supabase
      .from('chat_api_configs')
      .insert({
        name:             `${api.name} (cópia)`,
        description:      api.description,
        method:           api.method,
        url:              api.url,
        auth_type:        api.auth_type,
        auth_config:      api.auth_config,
        headers:          api.headers,
        query_params:     api.query_params,
        body_type:        api.body_type,
        body_template:    api.body_template,
        response_mapping: api.response_mapping,
      })
      .select()
      .single()
    if (data) {
      setApis(prev => [data as ApiConfig, ...prev])
    }
  }

  async function remove(id: string) {
    setDeleting(id)
    const supabase = createClient()
    await supabase.from('chat_api_configs').delete().eq('id', id)
    setApis(prev => prev.filter(a => a.id !== id))
    setDeleting(null)
  }

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-4xl mx-auto">

        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-100 flex items-center justify-center">
              <Plug className="w-5 h-5 text-indigo-600" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-gray-900">APIs Configuradas</h1>
              <p className="text-sm text-gray-500">
                {apis.length} {apis.length === 1 ? 'API cadastrada' : 'APIs cadastradas'}
              </p>
            </div>
          </div>
          <button
            onClick={() => router.push('/apis/new')}
            className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white text-sm font-semibold
                       rounded-xl hover:bg-emerald-700 transition-colors shadow-sm"
          >
            <Plus className="w-4 h-4" />
            Nova API
          </button>
        </div>

        {/* Empty */}
        {apis.length === 0 && (
          <div className="bg-white rounded-2xl border border-gray-200 border-dashed p-16 text-center">
            <Plug className="w-12 h-12 text-gray-300 mx-auto mb-4" />
            <p className="text-gray-500 font-medium mb-1">Nenhuma API cadastrada</p>
            <p className="text-sm text-gray-400 mb-6">
              Configure endpoints externos para usar nos fluxos de automação
            </p>
            <button
              onClick={() => router.push('/apis/new')}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-emerald-600 text-white text-sm
                         font-semibold rounded-xl hover:bg-emerald-700 transition-colors"
            >
              <Plus className="w-4 h-4" />
              Criar primeira API
            </button>
          </div>
        )}

        {/* List */}
        <div className="space-y-3">
          {apis.map(api => {
            const res       = results[api.id]
            const isTesting = testing === api.id
            const isDeleting = deleting === api.id
            const mappingCount = (api.response_mapping as any[])?.length ?? 0
            const testedAt  = api.last_tested_at
              ? new Date(api.last_tested_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
              : null

            return (
              <div
                key={api.id}
                className="bg-white rounded-2xl border border-gray-200 hover:border-gray-300
                           shadow-sm hover:shadow-md transition-all group"
              >
                <div className="p-5 flex items-start gap-4">
                  {/* Left: info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2.5 mb-1.5 flex-wrap">
                      <MethodBadge method={api.method} />
                      <span className="font-semibold text-gray-900 truncate">{api.name}</span>
                      {!api.is_active && (
                        <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">inativo</span>
                      )}
                    </div>

                    <p className="text-xs font-mono text-gray-400 truncate mb-2">{api.url}</p>

                    <div className="flex items-center gap-4 text-xs text-gray-400">
                      {mappingCount > 0 && (
                        <span>{mappingCount} variáve{mappingCount === 1 ? 'l' : 'is'} mapeada{mappingCount !== 1 ? 's' : ''}</span>
                      )}

                      {/* Test status */}
                      {res ? (
                        <span className={`flex items-center gap-1 ${res.ok ? 'text-green-600' : 'text-red-500'}`}>
                          {res.ok
                            ? <CheckCircle className="w-3 h-3" />
                            : <XCircle    className="w-3 h-3" />
                          }
                          {res.ok ? `${res.status} OK` : `${res.status ?? 'Erro'}`}
                          {res.duration_ms != null && (
                            <span className="flex items-center gap-0.5 text-gray-400">
                              <Clock className="w-3 h-3" />{res.duration_ms}ms
                            </span>
                          )}
                        </span>
                      ) : testedAt ? (
                        <span className={`flex items-center gap-1 ${
                          api.last_test_status === 'success' ? 'text-green-600' :
                          api.last_test_status === 'error'   ? 'text-red-500'   : 'text-gray-400'
                        }`}>
                          {api.last_test_status === 'success' && <CheckCircle className="w-3 h-3" />}
                          {api.last_test_status === 'error'   && <AlertTriangle className="w-3 h-3" />}
                          Testado {testedAt}
                        </span>
                      ) : (
                        <span className="text-amber-500 flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3" />
                          Nunca testado
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                    <ActionBtn
                      onClick={() => quickTest(api)}
                      disabled={isTesting}
                      title="Testar"
                      className="text-blue-500 hover:bg-blue-50"
                    >
                      {isTesting
                        ? <span className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                        : <Play className="w-4 h-4" />
                      }
                    </ActionBtn>

                    <ActionBtn onClick={() => router.push(`/apis/${api.id}`)} title="Editar" className="text-gray-500 hover:bg-gray-100">
                      <Pencil className="w-4 h-4" />
                    </ActionBtn>

                    <ActionBtn onClick={() => clone(api)} title="Clonar" className="text-gray-500 hover:bg-gray-100">
                      <Copy className="w-4 h-4" />
                    </ActionBtn>

                    <ActionBtn
                      onClick={() => {
                        if (confirm(`Deletar "${api.name}"?`)) remove(api.id)
                      }}
                      disabled={isDeleting}
                      title="Deletar"
                      className="text-red-400 hover:bg-red-50"
                    >
                      {isDeleting
                        ? <span className="w-4 h-4 border-2 border-red-300 border-t-transparent rounded-full animate-spin" />
                        : <Trash2 className="w-4 h-4" />
                      }
                    </ActionBtn>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function ActionBtn({ children, onClick, disabled, title, className }: {
  children:  React.ReactNode
  onClick:   () => void
  disabled?: boolean
  title:     string
  className: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`p-2 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${className}`}
    >
      {children}
    </button>
  )
}
