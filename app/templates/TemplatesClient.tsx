'use client'

import { useState }                   from 'react'
import { Plus, RefreshCw, Trash2, X, ChevronDown, ChevronUp, AlertCircle } from 'lucide-react'
import { Button }                     from '@/components/ui/button'
import { Input }                      from '@/components/ui/input'
import { cn }                         from '@/lib/utils'
import type { WaTemplate, Inbox, WaTemplateCategory } from '@/lib/types'

const CATEGORIES: WaTemplateCategory[] = ['MARKETING', 'UTILITY', 'AUTHENTICATION']
const LANGUAGES  = [{ code: 'pt_BR', label: 'Português (BR)' }, { code: 'en_US', label: 'English (US)' }]
const STATUS_STYLE: Record<string, string> = {
  APPROVED:  'bg-emerald-100 text-emerald-700',
  PENDING:   'bg-yellow-100  text-yellow-700',
  REJECTED:  'bg-red-100     text-red-700',
  PAUSED:    'bg-gray-100    text-gray-500',
  DISABLED:  'bg-gray-100    text-gray-400',
}
const STATUS_LABEL: Record<string, string> = {
  APPROVED: 'Aprovado', PENDING: 'Pendente', REJECTED: 'Rejeitado',
  PAUSED: 'Pausado', DISABLED: 'Desativado',
}

interface ButtonDraft { id: string; type: 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER'; text: string; url: string; phone: string }

interface Props {
  initialTemplates: WaTemplate[]
  inboxes:          Inbox[]
}

function countVarNums(text: string): number[] {
  const nums = new Set<number>()
  for (const m of text.matchAll(/\{\{(\d+)\}\}/g)) nums.add(parseInt(m[1]))
  return [...nums].sort((a, b) => a - b)
}

export default function TemplatesClient({ initialTemplates, inboxes }: Props) {
  const [templates, setTemplates] = useState(initialTemplates)
  const [showForm,  setShowForm]  = useState(false)
  const [syncing,   setSyncing]   = useState(false)
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState<string | null>(null)

  // ── Formulário ────────────────────────────────────────────────────────────
  const [form, setForm] = useState({
    inbox_id:    inboxes[0]?.id || '',
    name:        '',
    category:    'UTILITY' as WaTemplateCategory,
    language:    'pt_BR',
    header_type: '' as string,
    header_text: '',
    body_text:   '',
    footer_text: '',
  })
  const [buttons,         setButtons]         = useState<ButtonDraft[]>([])
  const [bodyExamples,    setBodyExamples]    = useState<Record<number, string>>({})
  const [headerExamples,  setHeaderExamples]  = useState<Record<number, string>>({})

  const bodyVarNums   = countVarNums(form.body_text)
  const headerVarNums = form.header_type === 'TEXT' ? countVarNums(form.header_text) : []

  function addButton() {
    setButtons(b => [...b, { id: crypto.randomUUID(), type: 'QUICK_REPLY', text: '', url: '', phone: '' }])
  }
  function removeButton(id: string) { setButtons(b => b.filter(x => x.id !== id)) }
  function updateButton(id: string, patch: Partial<ButtonDraft>) {
    setButtons(b => b.map(x => x.id === id ? { ...x, ...patch } : x))
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!form.inbox_id) { setError('Selecione um inbox'); return }
    setLoading(true); setError(null)

    const metaButtons = buttons.map(b => {
      if (b.type === 'QUICK_REPLY') return { type: b.type, text: b.text }
      if (b.type === 'URL')         return { type: b.type, text: b.text, url: b.url }
      return { type: b.type, text: b.text, phone_number: b.phone }
    })

    const resp = await fetch('/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...form,
        header_type:    form.header_type || undefined,
        header_text:    form.header_type === 'TEXT' ? form.header_text : undefined,
        buttons:        metaButtons,
        header_examples: Object.values(headerExamples).filter(Boolean),
        body_examples:   bodyVarNums.map(n => bodyExamples[n] || ''),
      }),
    })
    const result = await resp.json()
    if (!resp.ok) { setError(result.error || 'Erro ao criar template'); setLoading(false); return }

    setTemplates(prev => [result.template, ...prev])
    setShowForm(false)
    setForm({ inbox_id: inboxes[0]?.id || '', name: '', category: 'UTILITY', language: 'pt_BR', header_type: '', header_text: '', body_text: '', footer_text: '' })
    setButtons([]); setBodyExamples({}); setHeaderExamples({})
    setLoading(false)
  }

  async function handleDelete(id: string) {
    if (!confirm('Excluir este template? Ele também será removido da Meta.')) return
    await fetch('/api/templates', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
    setTemplates(prev => prev.filter(t => t.id !== id))
  }

  async function handleSync() {
    setSyncing(true)
    setError(null)
    try {
      const resp   = await fetch('/api/templates?sync=1')
      const result = await resp.json()
      // Só atualiza se vier um array válido (nunca zera a lista em caso de erro)
      if (resp.ok && Array.isArray(result.templates)) {
        setTemplates(result.templates)
        const msgs = []
        if (result.imported > 0) msgs.push(`${result.imported} importado(s) da Meta`)
        if (result.updated  > 0) msgs.push(`${result.updated} atualizado(s)`)
        if (result.warning)       msgs.push(result.warning)
        if (result.syncErrors?.length) msgs.push('Erro Meta: ' + result.syncErrors[0])
        if (msgs.length) setError(msgs.join(' · '))   // exibe como info (não erro grave)
      } else if (!resp.ok) {
        setError(result.error || 'Erro ao sincronizar com a Meta')
      }
    } catch (e) {
      setError('Erro de conexão ao sincronizar')
    }
    setSyncing(false)
  }

  return (
    <div className="space-y-4">
      {/* Ações */}
      <div className="flex items-center justify-between">
        <Button size="sm" onClick={() => setShowForm(!showForm)}>
          <Plus className="w-4 h-4 mr-1" />
          Novo template
        </Button>
        <Button size="sm" variant="outline" onClick={handleSync} disabled={syncing}>
          <RefreshCw className={cn('w-4 h-4 mr-1', syncing && 'animate-spin')} />
          {syncing ? 'Sincronizando...' : 'Sincronizar status'}
        </Button>
      </div>

      {/* Mensagem de erro global (fora do form) */}
      {error && !showForm && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      {/* Aviso sem waba_id */}
      {inboxes.every(i => !i.waba_id) && (
        <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>Nenhum inbox tem o <strong>WABA ID</strong> configurado. Edite o inbox em <strong>Caixas de Entrada</strong> e adicione o campo WABA ID ({`4023700297885912`}).</span>
        </div>
      )}

      {/* Formulário de criação */}
      {showForm && (
        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-gray-900">Novo template</h2>
            <button onClick={() => setShowForm(false)} className="text-gray-400 hover:text-gray-600">
              <X className="w-4 h-4" />
            </button>
          </div>
          <form onSubmit={handleCreate} className="space-y-4">
            {/* Linha 1: inbox, nome, categoria, idioma */}
            <div className="grid grid-cols-4 gap-3">
              <div>
                <label className="text-xs font-medium text-gray-600 mb-1 block">Inbox *</label>
                <select value={form.inbox_id} onChange={e => setForm({...form, inbox_id: e.target.value})} className="w-full h-9 rounded-md border border-gray-200 bg-transparent px-2 text-sm">
                  {inboxes.map(i => <option key={i.id} value={i.id}>{i.name}{!i.waba_id ? ' ⚠️' : ''}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600 mb-1 block">Nome * <span className="text-gray-400">(minúsc./underscores)</span></label>
                <Input value={form.name} onChange={e => setForm({...form, name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_')})} placeholder="meu_template" required className="h-9 text-sm font-mono" />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600 mb-1 block">Categoria *</label>
                <select value={form.category} onChange={e => setForm({...form, category: e.target.value as WaTemplateCategory})} className="w-full h-9 rounded-md border border-gray-200 bg-transparent px-2 text-sm">
                  {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600 mb-1 block">Idioma</label>
                <select value={form.language} onChange={e => setForm({...form, language: e.target.value})} className="w-full h-9 rounded-md border border-gray-200 bg-transparent px-2 text-sm">
                  {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
                </select>
              </div>
            </div>

            {/* Header */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-gray-600 block">Header <span className="text-gray-400">(opcional)</span></label>
              <div className="flex gap-2">
                <select value={form.header_type} onChange={e => setForm({...form, header_type: e.target.value})} className="h-9 rounded-md border border-gray-200 bg-transparent px-2 text-sm">
                  <option value="">— Sem header —</option>
                  <option value="TEXT">Texto</option>
                  <option value="IMAGE">Imagem</option>
                  <option value="VIDEO">Vídeo</option>
                  <option value="DOCUMENT">Documento</option>
                </select>
                {form.header_type === 'TEXT' && (
                  <Input value={form.header_text} onChange={e => setForm({...form, header_text: e.target.value})} placeholder="Texto do header (pode ter {{1}})" className="flex-1 h-9 text-sm" />
                )}
                {form.header_type && form.header_type !== 'TEXT' && (
                  <p className="flex-1 text-xs text-gray-400 flex items-center">A URL da mídia será informada ao enviar o template.</p>
                )}
              </div>
              {headerVarNums.length > 0 && (
                <div className="ml-2 space-y-1">
                  <p className="text-[11px] text-gray-500">Exemplos para aprovação (obrigatório pela Meta):</p>
                  {headerVarNums.map(n => (
                    <Input key={n} value={headerExamples[n] || ''} onChange={e => setHeaderExamples(x => ({...x, [n]: e.target.value}))} placeholder={`Exemplo para {{${n}}}`} className="h-8 text-xs" />
                  ))}
                </div>
              )}
            </div>

            {/* Body */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-gray-600 block">
                Corpo da mensagem * <span className="text-gray-400">— use {`{{1}}`}, {`{{2}}`}… para variáveis</span>
              </label>
              <textarea
                value={form.body_text}
                onChange={e => setForm({...form, body_text: e.target.value})}
                placeholder="Olá {{1}}, seu boleto de R${{2}} vence em {{3}}. Acesse: {{4}}"
                rows={4}
                required
                className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-none"
              />
              {bodyVarNums.length > 0 && (
                <div className="space-y-1">
                  <p className="text-[11px] text-gray-500">Exemplos para aprovação (obrigatório pela Meta):</p>
                  <div className="grid grid-cols-2 gap-2">
                    {bodyVarNums.map(n => (
                      <Input key={n} value={bodyExamples[n] || ''} onChange={e => setBodyExamples(x => ({...x, [n]: e.target.value}))} placeholder={`Exemplo para {{${n}}}`} className="h-8 text-xs" />
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">Footer <span className="text-gray-400">(opcional — texto simples, sem variáveis)</span></label>
              <Input value={form.footer_text} onChange={e => setForm({...form, footer_text: e.target.value})} placeholder="Aviv Construtora — Não responda esta mensagem" className="h-9 text-sm" />
            </div>

            {/* Botões */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-gray-600">Botões <span className="text-gray-400">(opcional — máx 3)</span></label>
                {buttons.length < 3 && (
                  <button type="button" onClick={addButton} className="text-xs text-emerald-600 hover:text-emerald-700">+ Adicionar botão</button>
                )}
              </div>
              {buttons.map(b => (
                <div key={b.id} className="flex items-center gap-2 bg-gray-50 rounded-lg p-2">
                  <select value={b.type} onChange={e => updateButton(b.id, { type: e.target.value as any })} className="h-8 rounded border border-gray-200 bg-white px-2 text-xs shrink-0">
                    <option value="QUICK_REPLY">Resposta rápida</option>
                    <option value="URL">Link URL</option>
                    <option value="PHONE_NUMBER">Telefone</option>
                  </select>
                  <Input value={b.text} onChange={e => updateButton(b.id, { text: e.target.value })} placeholder="Texto do botão" className="flex-1 h-8 text-xs" />
                  {b.type === 'URL'          && <Input value={b.url}   onChange={e => updateButton(b.id, { url: e.target.value })}   placeholder="https://..." className="flex-1 h-8 text-xs" />}
                  {b.type === 'PHONE_NUMBER' && <Input value={b.phone} onChange={e => updateButton(b.id, { phone: e.target.value })} placeholder="+5511..." className="flex-1 h-8 text-xs" />}
                  <button type="button" onClick={() => removeButton(b.id)} className="text-gray-400 hover:text-red-500 shrink-0"><X className="w-3.5 h-3.5" /></button>
                </div>
              ))}
            </div>

            {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}

            <div className="flex gap-2 pt-1">
              <Button type="submit" size="sm" disabled={loading}>
                {loading ? 'Enviando para Meta...' : 'Enviar para aprovação →'}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setShowForm(false)}>Cancelar</Button>
            </div>
          </form>
        </div>
      )}

      {/* Lista de templates */}
      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        {templates.length === 0 ? (
          <div className="p-10 text-center text-sm text-gray-400">Nenhum template criado ainda.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                {['Nome', 'Categoria', 'Idioma', 'Inbox', 'Status', ''].map(h => (
                  <th key={h} className="text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wide px-4 py-3">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {templates.map(t => (
                <TemplateRow key={t.id} template={t} onDelete={handleDelete} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function TemplateRow({ template: t, onDelete }: { template: WaTemplate; onDelete: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const inbox = t.inbox as any

  return (
    <>
      <tr className="hover:bg-gray-50 transition-colors">
        <td className="px-4 py-3">
          <button onClick={() => setExpanded(!expanded)} className="flex items-center gap-1 font-mono text-xs text-gray-800 hover:text-emerald-600">
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {t.name}
          </button>
        </td>
        <td className="px-4 py-3 text-xs text-gray-500">{t.category}</td>
        <td className="px-4 py-3 text-xs text-gray-500">{t.language}</td>
        <td className="px-4 py-3 text-xs text-gray-500">{inbox?.name || '—'}</td>
        <td className="px-4 py-3">
          <span className={cn('text-[10px] font-semibold px-2 py-0.5 rounded-full', STATUS_STYLE[t.status] || 'bg-gray-100 text-gray-400')}>
            {STATUS_LABEL[t.status] || t.status}
          </span>
          {t.status === 'REJECTED' && t.rejection_reason && (
            <p className="text-[10px] text-red-500 mt-0.5 max-w-xs truncate">{t.rejection_reason}</p>
          )}
        </td>
        <td className="px-4 py-3">
          <button onClick={() => onDelete(t.id)} className="p-1 text-gray-300 hover:text-red-500 transition-colors">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-gray-50">
          <td colSpan={6} className="px-6 py-3">
            <div className="space-y-1 text-xs text-gray-600">
              {t.header_text && <p><span className="font-medium text-gray-400">Header:</span> {t.header_text}</p>}
              <p><span className="font-medium text-gray-400">Body:</span> {t.body_text}</p>
              {t.footer_text && <p><span className="font-medium text-gray-400">Footer:</span> {t.footer_text}</p>}
              {(t.buttons as any[]).length > 0 && (
                <p><span className="font-medium text-gray-400">Botões:</span> {(t.buttons as any[]).map((b: any) => b.text).join(' · ')}</p>
              )}
              {t.body_var_count > 0 && (
                <p className="text-gray-400">{t.body_var_count} variável(is) no corpo</p>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
