'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { ArrowLeft, Pause, Play, CheckCircle2, XCircle, Clock, Pencil, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'

const STATUS_LABEL: Record<string, string> = {
  draft: 'Rascunho', scheduled: 'Agendada', running: 'Enviando',
  paused: 'Pausada', done: 'Concluída', failed: 'Falhou',
}
const STATUS_COLOR: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-600', scheduled: 'bg-blue-100 text-blue-700',
  running: 'bg-amber-100 text-amber-700', paused: 'bg-orange-100 text-orange-700',
  done: 'bg-emerald-100 text-emerald-700', failed: 'bg-red-100 text-red-700',
}

export default function CampaignDetail({ campaign, initialRecipients }: { campaign: any; initialRecipients: any[] }) {
  const router = useRouter()
  const supabase = createClient()
  const [camp, setCamp] = useState(campaign)
  const [recipients, setRecipients] = useState(initialRecipients)
  const [busy, setBusy] = useState(false)

  // Realtime: campanha + recipients
  useEffect(() => {
    const ch = supabase
      .channel(`campaign-${camp.id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'chat_campaigns', filter: `id=eq.${camp.id}` },
        (p) => setCamp((c: any) => ({ ...c, ...p.new })))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_campaign_recipients', filter: `campaign_id=eq.${camp.id}` },
        (p: any) => setRecipients((rs) => rs.map(r => r.id === p.new.id ? { ...r, ...p.new } : r)))
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [camp.id])

  async function action(kind: 'start' | 'pause') {
    setBusy(true)
    const { data: { session } } = await supabase.auth.getSession()
    await fetch(`/api/campaigns/${camp.id}/${kind}`, {
      method: 'POST', headers: { Authorization: `Bearer ${session?.access_token}` },
    })
    setBusy(false)
    router.refresh()
  }

  async function excluir() {
    if (!confirm(`Excluir a campanha "${camp.name}"?\n\nEla some da lista. O histórico de quem já recebeu fica preservado na ficha de cada cliente.`)) return
    setBusy(true)
    const r = await fetch(`/api/campaigns/${camp.id}`, { method: 'DELETE' })
    if (!r.ok) { const j = await r.json().catch(() => ({})); alert(j.error || 'Falha ao excluir.'); setBusy(false); return }
    router.push('/campaigns')
  }

  const editavel = ['draft', 'scheduled', 'paused'].includes(camp.status)

  const pct = camp.total ? Math.round(((camp.sent + camp.failed) / camp.total) * 100) : 0

  return (
    <>
      <button onClick={() => router.push('/campaigns')} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4">
        <ArrowLeft className="w-4 h-4" /> Campanhas
      </button>

      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-gray-900">{camp.name}</h1>
            <span className={cn('text-[10px] font-bold px-2 py-0.5 rounded-full uppercase', STATUS_COLOR[camp.status])}>
              {STATUS_LABEL[camp.status] || camp.status}
            </span>
          </div>
          <p className="text-sm text-gray-400 mt-0.5">
            {camp.template?.name} · {camp.inbox?.name}
          </p>
        </div>
        <div className="flex gap-2">
          {['running', 'scheduled'].includes(camp.status) && (
            <button onClick={() => action('pause')} disabled={busy}
              className="flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg bg-orange-100 text-orange-700 hover:bg-orange-200">
              <Pause className="w-4 h-4" /> Pausar
            </button>
          )}
          {['paused', 'draft'].includes(camp.status) && camp.total > 0 && (
            <button onClick={() => action('start')} disabled={busy}
              className="flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700">
              <Play className="w-4 h-4" /> {camp.status === 'paused' ? 'Retomar' : 'Iniciar'}
            </button>
          )}
          {editavel && (
            <button onClick={() => router.push(`/campaigns/${camp.id}/edit`)} disabled={busy}
              className="flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200">
              <Pencil className="w-4 h-4" /> Editar
            </button>
          )}
          <button onClick={excluir} disabled={busy} title="Excluir campanha"
            className="flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50">
            <Trash2 className="w-4 h-4" /> Excluir
          </button>
        </div>
      </div>

      {/* Progresso */}
      <div className="bg-white border border-gray-100 rounded-xl p-5 mb-6">
        <div className="flex items-center justify-between text-sm mb-2">
          <span className="text-gray-600">{camp.sent + camp.failed} de {camp.total} processados</span>
          <span className="text-gray-400">{pct}%</span>
        </div>
        <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
          <div className="h-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
        <div className="flex gap-6 mt-4 text-sm">
          <span className="flex items-center gap-1.5 text-emerald-600"><CheckCircle2 className="w-4 h-4" /> {camp.sent} enviados</span>
          <span className="flex items-center gap-1.5 text-red-500"><XCircle className="w-4 h-4" /> {camp.failed} falhas</span>
          <span className="flex items-center gap-1.5 text-gray-400"><Clock className="w-4 h-4" /> {camp.total - camp.sent - camp.failed} pendentes</span>
        </div>
      </div>

      {/* Destinatários */}
      <div className="bg-white border border-gray-100 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-50 text-sm font-semibold text-gray-700">Destinatários</div>
        <div className="max-h-[50vh] overflow-y-auto divide-y divide-gray-50">
          {recipients.map(r => (
            <div key={r.id} className="flex items-center justify-between px-5 py-2.5 text-sm">
              <div className="min-w-0">
                <span className="text-gray-800">{r.name || r.wa_id}</span>
                <span className="text-gray-400 ml-2 text-xs">{r.wa_id}</span>
                {r.error && <p className="text-xs text-red-500 truncate max-w-md">{r.error}</p>}
              </div>
              <RecipientStatus status={r.status} />
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

function RecipientStatus({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    pending:   { label: 'Pendente',  cls: 'text-gray-400' },
    sent:      { label: 'Enviado',   cls: 'text-emerald-600' },
    delivered: { label: 'Entregue',  cls: 'text-emerald-600' },
    read:      { label: 'Lido',      cls: 'text-blue-600' },
    failed:    { label: 'Falhou',    cls: 'text-red-500' },
    skipped:   { label: 'Pulado',    cls: 'text-gray-400' },
  }
  const s = map[status] || map.pending
  return <span className={cn('text-xs font-medium shrink-0', s.cls)}>{s.label}</span>
}
