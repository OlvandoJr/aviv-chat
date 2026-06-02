'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { X, Save, Trash2, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ApiConnection, ConnectionProvider } from '@/lib/types'

interface Props {
  connection: ApiConnection | null   // null = nova
  onSaved:   (conn: ApiConnection) => void
  onDeleted?: (id: string) => void
  onClose:   () => void
}

const PROVIDERS: { value: ConnectionProvider; label: string; icon: string; description: string }[] = [
  {
    value:       'google_calendar',
    label:       'Google Calendar',
    icon:        '📅',
    description: 'Cria eventos de pagamento agendado no Google Calendar via Service Account.',
  },
]

export default function ApiConnectionEditor({ connection, onSaved, onDeleted, onClose }: Props) {
  const supabase  = createClient()
  const isNew     = !connection

  const [name,       setName]      = useState(connection?.name     || '')
  const [provider,   setProvider]  = useState<ConnectionProvider>(connection?.provider || 'google_calendar')
  const [calendarId, setCalendarId]= useState<string>(connection?.config?.calendar_id || '')
  const [saJson,     setSaJson]    = useState<string>(
    // Ao editar, não exibimos a chave privada por segurança — apenas o email
    connection?.credentials?.client_email
      ? `[Service Account: ${connection.credentials.client_email}]`
      : ''
  )
  const [saJsonRaw,  setSaJsonRaw] = useState<string>('')  // novo JSON digitado

  const [loading,    setLoading]   = useState(false)
  const [testing,    setTesting]   = useState(false)
  const [testResult, setTestResult]= useState<{ ok: boolean; msg: string } | null>(null)
  const [error,      setError]     = useState('')

  async function handleTest() {
    setTesting(true)
    setTestResult(null)

    try {
      // Verifica se temos credenciais para testar
      const rawJson = saJsonRaw.trim() || (isNew ? '' : null)
      if (rawJson !== null && !rawJson) {
        setTestResult({ ok: false, msg: 'Cole o JSON da Service Account para testar.' })
        setTesting(false)
        return
      }

      let credentials = connection?.credentials || {}
      if (rawJson) {
        credentials = JSON.parse(rawJson)
      }

      if (!calendarId.trim()) {
        setTestResult({ ok: false, msg: 'Informe o Calendar ID para testar.' })
        setTesting(false)
        return
      }

      // Chamar edge function para testar (ainda não existe — vamos fazer inline via fetch)
      // Teste rápido: verificar se o JSON tem os campos necessários
      if (!credentials.client_email || !credentials.private_key) {
        setTestResult({ ok: false, msg: 'JSON inválido — campos client_email ou private_key ausentes.' })
        setTesting(false)
        return
      }

      setTestResult({ ok: true, msg: `Service Account: ${credentials.client_email} — formato válido ✓` })
    } catch (e) {
      setTestResult({ ok: false, msg: 'JSON inválido: ' + String(e) })
    }

    setTesting(false)
  }

  async function handleSave() {
    if (!name.trim()) { setError('Nome obrigatório'); return }
    if (!calendarId.trim() && provider === 'google_calendar') {
      setError('Calendar ID obrigatório')
      return
    }

    let credentials = connection?.credentials || {}

    if (saJsonRaw.trim()) {
      try {
        credentials = JSON.parse(saJsonRaw.trim())
      } catch {
        setError('JSON da Service Account inválido')
        return
      }
    }

    if (isNew && !saJsonRaw.trim()) {
      setError('Cole o JSON da Service Account')
      return
    }

    setLoading(true)
    setError('')

    const payload: Partial<ApiConnection> = {
      name:        name.trim(),
      provider,
      credentials,
      config:      { calendar_id: calendarId.trim() },
      is_active:   true,
      updated_at:  new Date().toISOString(),
    }

    if (isNew) {
      const { data, error: err } = await supabase
        .from('chat_api_connections')
        .insert(payload)
        .select()
        .single()

      if (err || !data) {
        setError('Erro ao criar: ' + (err?.message || 'desconhecido'))
        setLoading(false)
        return
      }
      onSaved(data as ApiConnection)
    } else {
      const { data, error: err } = await supabase
        .from('chat_api_connections')
        .update(payload)
        .eq('id', connection!.id)
        .select()
        .single()

      if (err || !data) {
        setError('Erro ao salvar: ' + (err?.message || 'desconhecido'))
        setLoading(false)
        return
      }
      onSaved(data as ApiConnection)
    }

    setLoading(false)
    onClose()
  }

  async function handleDelete() {
    if (!connection || !confirm('Remover esta integração? As ferramentas que a usam perderão a conexão.')) return
    await supabase.from('chat_api_connections').delete().eq('id', connection.id)
    onDeleted?.(connection.id)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-800">
            {isNew ? 'Nova Integração' : `Editar — ${connection!.name}`}
          </h2>
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-400">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 max-h-[75vh] overflow-y-auto">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">{error}</div>
          )}

          {/* Provedor */}
          <div>
            <label className="text-xs text-gray-500 mb-2 block font-medium">Provedor</label>
            <div className="space-y-2">
              {PROVIDERS.map(p => (
                <label key={p.value} className={cn(
                  'flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors',
                  provider === p.value ? 'border-emerald-400 bg-emerald-50' : 'border-gray-200'
                )}>
                  <input
                    type="radio" name="provider" value={p.value}
                    checked={provider === p.value}
                    onChange={() => setProvider(p.value)}
                    className="mt-0.5 accent-emerald-500"
                  />
                  <div>
                    <div className="text-sm font-medium text-gray-800">{p.icon} {p.label}</div>
                    <div className="text-xs text-gray-500 mt-0.5">{p.description}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Nome */}
          <div>
            <label className="text-xs text-gray-500 mb-1 block font-medium">Nome da Integração *</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex: Google Calendar Aviv"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>

          {provider === 'google_calendar' && (
            <>
              {/* Service Account JSON */}
              <div>
                <label className="text-xs text-gray-500 mb-1 block font-medium">
                  Service Account JSON *
                  {!isNew && <span className="text-gray-400 ml-1">(deixe em branco para manter o atual)</span>}
                </label>
                {!isNew && connection?.credentials?.client_email && (
                  <div className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 mb-2 font-mono">
                    Atual: {connection.credentials.client_email}
                  </div>
                )}
                <textarea
                  value={saJsonRaw}
                  onChange={(e) => setSaJsonRaw(e.target.value)}
                  placeholder='Cole aqui o JSON completo da Service Account do Google Cloud Console...'
                  rows={6}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-y"
                />
                <div className="text-[11px] text-gray-400 mt-1 space-y-1">
                  <p>1. Google Cloud Console → IAM → Service Accounts → criar conta de serviço</p>
                  <p>2. Baixar chave JSON → cole aqui</p>
                  <p>3. Compartilhar o calendário com o email da service account</p>
                </div>
              </div>

              {/* Calendar ID */}
              <div>
                <label className="text-xs text-gray-500 mb-1 block font-medium">Calendar ID *</label>
                <input
                  value={calendarId}
                  onChange={(e) => setCalendarId(e.target.value)}
                  placeholder="email@group.calendar.google.com"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
                <p className="text-[11px] text-gray-400 mt-0.5">
                  Encontrado em: Google Calendar → Configurações do calendário → ID do calendário
                </p>
              </div>

              {/* Testar */}
              <div>
                <button
                  onClick={handleTest}
                  disabled={testing}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                  Validar formato
                </button>
                {testResult && (
                  <div className={cn(
                    'flex items-center gap-1.5 mt-2 text-xs px-3 py-2 rounded-lg border',
                    testResult.ok
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                      : 'bg-red-50 border-red-200 text-red-700'
                  )}>
                    {testResult.ok
                      ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                      : <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    }
                    {testResult.msg}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-gray-100">
          <div>
            {!isNew && (
              <button onClick={handleDelete} className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg text-red-600 hover:bg-red-50 border border-red-200 transition-colors">
                <Trash2 className="w-3.5 h-3.5" />
                Remover
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">
              Cancelar
            </button>
            <button
              onClick={handleSave}
              disabled={loading}
              className="flex items-center gap-1.5 px-4 py-1.5 text-xs rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 font-medium disabled:opacity-60"
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
