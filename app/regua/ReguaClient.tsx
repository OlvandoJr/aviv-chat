'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { CalendarClock, Plus, Trash2, Pencil, Eye, X } from 'lucide-react'
import { AVAILABLE_COLUMNS, COLUMN_LABEL } from '@/lib/whatsapp/vars'
import MappedPreview from '@/components/whatsapp/MappedPreview'
import { cn } from '@/lib/utils'

interface Tpl {
  id: string; name: string; inbox_id: string
  header_type: string | null; header_text: string | null; body_text: string; footer_text?: string | null
  header_var_count: number; body_var_count: number
}
interface Props { initial: any[]; inboxes: { id: string; name: string }[]; templates: Tpl[] }

function varNums(text: string): number[] {
  const s = new Set<number>()
  for (const m of (text || '').matchAll(/\{\{(\d+)\}\}/g)) s.add(parseInt(m[1]))
  return [...s].sort((a, b) => a - b)
}
function defaultFormat(col: string) {
  if (col === 'amount') return 'currency'
  if (col === 'due_date') return 'date'
  return undefined
}
export function offsetLabel(n: number): string {
  if (n < 0) return `${-n} dia(s) antes do vencimento`
  if (n === 0) return 'No dia do vencimento'
  return `${n} dia(s) após o vencimento`
}
export function offsetBadge(n: number): string {
  if (n < 0) return `−${-n}d`
  if (n === 0) return 'D0'
  return `+${n}d`
}

type VarMap = Record<string, { type: 'static' | 'column'; value: string; format?: string }>
type StepDraft = { offsetDays: number; sendTime: string; templateId: string; mapping: VarMap; onLoad?: boolean }
type Editing = {
  id?: string; name: string; inboxId: string
  filter: { source: string; empreendimento: string }
  steps: StepDraft[]
}

export default function ReguaClient({ initial, inboxes, templates }: Props) {
  const router = useRouter()
  const supabase = createClient()
  const [editing, setEditing] = useState<Editing | null>(null)

  function blankStep(): StepDraft {
    return { offsetDays: 0, sendTime: '09:00', templateId: '', mapping: {} }
  }
  function newRule(): Editing {
    return { name: '', inboxId: inboxes[0]?.id || '', filter: { source: 'both', empreendimento: '' }, steps: [{ ...blankStep(), offsetDays: -3 }] }
  }
  function editRule(r: any): Editing {
    const steps = [...(r.steps || [])].sort((a, b) => a.sort_order - b.sort_order).map((s: any) => ({
      offsetDays: s.offset_days, sendTime: String(s.send_time).slice(0, 5),
      templateId: s.template_id, mapping: s.variable_mapping || {}, onLoad: !!s.on_load,
    }))
    return {
      id: r.id, name: r.name, inboxId: r.inbox_id,
      filter: { source: r.audience_filter?.source || 'both', empreendimento: r.audience_filter?.empreendimento || '' },
      steps: steps.length ? steps : [blankStep()],
    }
  }

  async function toggleActive(r: any) {
    const { data: { session } } = await supabase.auth.getSession()
    await fetch(`/api/regua/${r.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify({ active: !r.active }),
    })
    router.refresh()
  }
  async function remove(r: any) {
    if (!confirm(`Excluir a régua "${r.name}"?`)) return
    const { data: { session } } = await supabase.auth.getSession()
    await fetch(`/api/regua/${r.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${session?.access_token}` } })
    router.refresh()
  }

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <CalendarClock className="w-5 h-5 text-emerald-600" /> Régua de Cobrança
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Cada régua é um fluxo com vários disparos (ex: −3, no vencimento, +5, +10).
            Disparos não saem em sábado/domingo — postergam para segunda.
          </p>
        </div>
        <button onClick={() => setEditing(newRule())}
          className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium px-4 py-2 rounded-xl">
          <Plus className="w-4 h-4" /> Nova régua
        </button>
      </div>

      {initial.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <CalendarClock className="w-10 h-10 mx-auto mb-3 opacity-40" />
          <p className="text-sm">Nenhuma régua configurada.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {initial.map((r) => {
            const steps = [...(r.steps || [])].sort((a, b) =>
              Number(!!b.on_load) - Number(!!a.on_load) || a.offset_days - b.offset_days)
            return (
              <div key={r.id} className="bg-white border border-gray-100 rounded-xl px-5 py-4 flex items-center justify-between">
                <div className="min-w-0">
                  <span className="font-medium text-gray-900">{r.name}</span>
                  <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                    {steps.map((s: any) => (
                      <span key={s.id} className={cn('text-[10px] font-medium px-2 py-0.5 rounded-full',
                        s.on_load ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-600')}>
                        {s.on_load ? 'Carga' : offsetBadge(s.offset_days)} · {String(s.send_time).slice(0, 5)} · {s.template?.name || '—'}
                      </span>
                    ))}
                    {steps.length === 0 && <span className="text-xs text-gray-400">sem disparos</span>}
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <button onClick={() => toggleActive(r)} title={r.active ? 'Ativa' : 'Inativa'}
                    className={cn('relative w-9 h-5 rounded-full transition-colors', r.active ? 'bg-emerald-500' : 'bg-gray-300')}>
                    <span className={cn('absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all', r.active ? 'left-[18px]' : 'left-0.5')} />
                  </button>
                  <button onClick={() => setEditing(editRule(r))} className="text-gray-400 hover:text-gray-700"><Pencil className="w-4 h-4" /></button>
                  <button onClick={() => remove(r)} className="text-gray-400 hover:text-red-500"><Trash2 className="w-4 h-4" /></button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {editing && (
        <RuleEditor editing={editing} inboxes={inboxes} templates={templates}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); router.refresh() }} />
      )}
    </>
  )
}

function RuleEditor({ editing, inboxes, templates, onClose, onSaved }: {
  editing: Editing; inboxes: { id: string; name: string }[]; templates: Tpl[]
  onClose: () => void; onSaved: () => void
}) {
  const supabase = createClient()
  const [e, setE] = useState<Editing>(editing)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const inboxTemplates = templates.filter(t => t.inbox_id === e.inboxId)

  function patchStep(idx: number, patch: Partial<StepDraft>) {
    setE(s => ({ ...s, steps: s.steps.map((st, i) => i === idx ? { ...st, ...patch } : st) }))
  }
  function addStep() {
    setE(s => ({ ...s, steps: [...s.steps, { offsetDays: 0, sendTime: '09:00', templateId: '', mapping: {} }] }))
  }
  function removeStep(idx: number) {
    setE(s => ({ ...s, steps: s.steps.filter((_, i) => i !== idx) }))
  }

  // Flag "disparar no dia do carregamento": liga/desliga o passo on_load (sempre o Disparo 1)
  const hasOnLoad = e.steps.some(st => st.onLoad)
  function toggleOnLoad() {
    setE(s => s.steps.some(st => st.onLoad)
      ? { ...s, steps: s.steps.filter(st => !st.onLoad) }
      : { ...s, steps: [{ onLoad: true, offsetDays: 999, sendTime: '09:00', templateId: '', mapping: {} }, ...s.steps] })
  }

  function varsFor(templateId: string): number[] {
    const t = templates.find(x => x.id === templateId)
    if (!t) return []
    const h = t.header_type === 'TEXT' && t.header_text ? varNums(t.header_text) : []
    return [...new Set([...h, ...varNums(t.body_text)])].sort((a, b) => a - b)
  }
  function stepReady(st: StepDraft) {
    return st.templateId && varsFor(st.templateId).every(n => st.mapping[n]?.value)
  }

  async function headers() {
    const { data: { session } } = await supabase.auth.getSession()
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` }
  }

  async function save() {
    setError(null)
    if (!e.name || !e.inboxId) { setError('Preencha nome e inbox.'); return }
    if (e.steps.length === 0) { setError('Inclua ao menos um disparo.'); return }
    for (let i = 0; i < e.steps.length; i++) {
      if (!stepReady(e.steps[i])) { setError(`Disparo ${i + 1}: escolha o template e mapeie todas as variáveis.`); return }
    }
    setBusy(true)
    try {
      const steps = e.steps.map(st => {
        const cleanMapping: any = {}
        for (const n of varsFor(st.templateId)) {
          const m = st.mapping[n]
          cleanMapping[String(n)] = m.type === 'static'
            ? { type: 'static', value: m.value }
            : { type: 'column', value: m.value, ...(m.format ? { format: m.format } : {}) }
        }
        return { offsetDays: Number(st.offsetDays), sendTime: st.sendTime, templateId: st.templateId, variableMapping: cleanMapping, onLoad: !!st.onLoad }
      })
      const payload = { name: e.name, inboxId: e.inboxId, audienceFilter: e.filter, steps }
      const r = await fetch(e.id ? `/api/regua/${e.id}` : '/api/regua', {
        method: e.id ? 'PATCH' : 'POST', headers: await headers(), body: JSON.stringify(payload),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error)
      onSaved()
    } catch (err: any) { setError(err.message); setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl bg-white rounded-2xl shadow-2xl max-h-[92vh] flex flex-col" onClick={ev => ev.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900">{e.id ? 'Editar régua' : 'Nova régua'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Fluxo: nome, inbox, audiência */}
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">Nome da régua</label>
              <input value={e.name} onChange={ev => setE(s => ({ ...s, name: ev.target.value }))}
                placeholder="Ex: Régua padrão de cobrança"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-xs font-medium text-gray-600 mb-1 block">Caixa de entrada</label>
                <select value={e.inboxId} onChange={ev => setE(s => ({ ...s, inboxId: ev.target.value, steps: s.steps.map(st => ({ ...st, templateId: '', mapping: {} })) }))}
                  className="w-full border border-gray-200 rounded-lg px-2 py-2 text-sm bg-white">
                  {inboxes.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600 mb-1 block">Origem</label>
                <select value={e.filter.source} onChange={ev => setE(s => ({ ...s, filter: { ...s.filter, source: ev.target.value } }))}
                  className="w-full border border-gray-200 rounded-lg px-2 py-2 text-sm bg-white">
                  <option value="both">Sienge + SGL</option>
                  <option value="sienge">Somente Sienge</option>
                  <option value="sgl">Somente SGL</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600 mb-1 block">Empreendimento</label>
                <input value={e.filter.empreendimento} onChange={ev => setE(s => ({ ...s, filter: { ...s.filter, empreendimento: ev.target.value } }))}
                  className="w-full border border-gray-200 rounded-lg px-2 py-2 text-sm" placeholder="contém (opcional)" />
              </div>
            </div>
            <div className="flex items-center justify-between bg-emerald-50/60 border border-emerald-100 rounded-xl px-3 py-2.5">
              <div>
                <span className="text-xs font-medium text-gray-700 block">Disparar no dia do carregamento</span>
                <span className="text-[11px] text-gray-500">Envia no mesmo dia para boletos carregados até 18h em dia útil; após 18h ou em fim de semana, no próximo dia útil.</span>
              </div>
              <button onClick={toggleOnLoad} title={hasOnLoad ? 'Ativado' : 'Desativado'}
                className={cn('relative w-9 h-5 rounded-full transition-colors shrink-0 ml-3', hasOnLoad ? 'bg-emerald-500' : 'bg-gray-300')}>
                <span className={cn('absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all', hasOnLoad ? 'left-[18px]' : 'left-0.5')} />
              </button>
            </div>
          </div>

          {/* Disparos */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-800">Disparos</h3>
              <button onClick={addStep} className="flex items-center gap-1 text-xs font-medium text-emerald-600 hover:text-emerald-700">
                <Plus className="w-3.5 h-3.5" /> Adicionar disparo
              </button>
            </div>
            {e.steps.map((st, idx) => (
              <StepCard key={idx} idx={idx} step={st} templates={inboxTemplates}
                vars={varsFor(st.templateId)} filter={e.filter}
                onChange={(p) => patchStep(idx, p)} onRemove={() => removeStep(idx)}
                canRemove={!st.onLoad && e.steps.length > 1} />
            ))}
          </div>

          {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
        </div>

        <div className="px-5 py-4 border-t border-gray-100 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700">Cancelar</button>
          <button onClick={save} disabled={busy}
            className={cn('px-4 py-2 rounded-xl text-sm font-medium text-white', busy ? 'bg-gray-300' : 'bg-emerald-600 hover:bg-emerald-700')}>
            {busy ? 'Salvando…' : 'Salvar régua'}
          </button>
        </div>
      </div>
    </div>
  )
}

function StepCard({ idx, step, templates, vars, filter, onChange, onRemove, canRemove }: {
  idx: number; step: StepDraft; templates: Tpl[]; vars: number[]
  filter: { source: string; empreendimento: string }
  onChange: (p: Partial<StepDraft>) => void; onRemove: () => void; canRemove: boolean
}) {
  const supabase = createClient()
  const [preview, setPreview] = useState<{ total: number; targetDue: string; weekend?: boolean } | null>(null)
  const [loading, setLoading] = useState(false)
  const tpl = templates.find(t => t.id === step.templateId) || null

  function setVar(n: number, patch: any) {
    const prev = step.mapping[n] || { type: 'column', value: '' }
    onChange({ mapping: { ...step.mapping, [n]: { ...prev, ...patch } } })
  }

  async function doPreview() {
    setLoading(true); setPreview(null)
    const { data: { session } } = await supabase.auth.getSession()
    const r = await fetch('/api/regua/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify({ offsetDays: step.offsetDays, onLoad: !!step.onLoad, filter }),
    })
    const j = await r.json()
    setLoading(false)
    if (r.ok) setPreview(j)
  }

  return (
    <div className="border border-gray-200 rounded-xl p-4 space-y-3 bg-gray-50/50">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-700">
          Disparo {idx + 1} — {step.onLoad ? 'No dia do carregamento' : offsetLabel(Number(step.offsetDays))}
        </span>
        {canRemove && <button onClick={onRemove} className="text-gray-400 hover:text-red-500"><Trash2 className="w-3.5 h-3.5" /></button>}
      </div>

      <div className={cn('grid gap-3', step.onLoad ? 'grid-cols-2' : 'grid-cols-3')}>
        {!step.onLoad && (
          <div>
            <label className="text-[11px] text-gray-500 mb-1 block">Dias do vencimento</label>
            <input type="number" value={step.offsetDays} onChange={ev => { onChange({ offsetDays: Number(ev.target.value) }); setPreview(null) }}
              className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm" />
          </div>
        )}
        <div>
          <label className="text-[11px] text-gray-500 mb-1 block">{step.onLoad ? 'Horário (a partir de)' : 'Horário'}</label>
          <input type="time" value={step.sendTime} onChange={ev => onChange({ sendTime: ev.target.value })}
            className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm" />
        </div>
        <div>
          <label className="text-[11px] text-gray-500 mb-1 block">Template</label>
          <select value={step.templateId} onChange={ev => onChange({ templateId: ev.target.value, mapping: {} })}
            className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm bg-white">
            <option value="">Selecione…</option>
            {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
      </div>

      {vars.length > 0 && (
        <div className="space-y-2">
          {vars.map(n => {
            const m = step.mapping[n] || { type: 'column', value: '' }
            return (
              <div key={n} className="flex items-center gap-2">
                <span className="text-xs font-mono text-gray-500 w-9">{`{{${n}}}`}</span>
                <select value={m.type} onChange={ev => setVar(n, { type: ev.target.value, value: '' })}
                  className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm bg-white">
                  <option value="column">Coluna</option>
                  <option value="static">Texto fixo</option>
                </select>
                {m.type === 'column' ? (
                  <select value={m.value} onChange={ev => setVar(n, { value: ev.target.value, format: defaultFormat(ev.target.value) })}
                    className="flex-1 border border-gray-200 rounded-lg px-2 py-1.5 text-sm bg-white">
                    <option value="">Coluna…</option>
                    {AVAILABLE_COLUMNS.map(c => <option key={c} value={c}>{COLUMN_LABEL[c]}</option>)}
                  </select>
                ) : (
                  <input value={m.value} onChange={ev => setVar(n, { value: ev.target.value })} placeholder="Valor fixo"
                    className="flex-1 border border-gray-200 rounded-lg px-2 py-1.5 text-sm" />
                )}
              </div>
            )
          })}
        </div>
      )}

      {tpl && (
        <MappedPreview headerText={tpl.header_text} bodyText={tpl.body_text} footerText={tpl.footer_text} mapping={step.mapping} />
      )}

      <button onClick={doPreview} disabled={loading} className="flex items-center gap-1.5 text-xs font-medium text-gray-600 hover:text-gray-900">
        <Eye className="w-3.5 h-3.5" /> {loading ? 'Calculando…' : 'Quem receberia hoje?'}
      </button>
      {preview && (
        <p className="text-xs text-gray-600">
          {preview.weekend ? (
            <>Fim de semana — disparos são postergados para segunda-feira.</>
          ) : (
            <><strong>{preview.total}</strong> {step.onLoad
              ? 'boleto(s) com disparo de carga para hoje.'
              : `cliente(s) com vencimento em ${preview.targetDue}.`}</>
          )}
        </p>
      )}
    </div>
  )
}
