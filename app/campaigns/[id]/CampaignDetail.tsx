'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { ArrowLeft, Pause, Play, CheckCircle2, XCircle, Clock, Pencil, Trash2, CheckCheck, Eye, Reply, RotateCw, ChevronDown, UserPlus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { descreverFalha } from '@/lib/whatsapp/erros'
import AdicionarContatosDialog from '@/components/campaigns/AdicionarContatosDialog'

const STATUS_LABEL: Record<string, string> = {
  draft: 'Rascunho', scheduled: 'Agendada', running: 'Enviando',
  paused: 'Pausada', done: 'Concluída', failed: 'Falhou',
}
const STATUS_COLOR: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-600', scheduled: 'bg-blue-100 text-blue-700',
  running: 'bg-amber-100 text-amber-700', paused: 'bg-orange-100 text-orange-700',
  done: 'bg-emerald-100 text-emerald-700', failed: 'bg-red-100 text-red-700',
}

export default function CampaignDetail({ campaign, initialRecipients, disparos = [], supervisor = true }: {
  campaign: any; initialRecipients: any[]
  /** Disparos adicionais (chat_campaign_disparos) — modelo da régua. */
  disparos?: any[]
  // Quem foi apenas LIBERADO na campanha acompanha e reenvia falhas; editar,
  // iniciar/pausar e excluir seguem com admin/gerente (a API recusa o resto).
  supervisor?: boolean
}) {
  const router = useRouter()
  const supabase = createClient()
  const [camp, setCamp] = useState(campaign)
  const [recipients, setRecipients] = useState(initialRecipients)
  const [busy, setBusy] = useState(false)
  const [detalhe, setDetalhe] = useState<string | null>(null)
  const [addAberto, setAddAberto] = useState(false)   // id do destinatário com o erro cru aberto

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

  // Reenvio: sem ids, reenvia todos os que falharam. O servidor só reseta quem
  // está 'failed' — a lista do browser nunca alcança quem já recebeu.
  async function reenviar(recipientIds?: string[]) {
    const alvo = recipientIds?.length
    if (!confirm(alvo
      ? 'Reenviar a mensagem desta campanha para este contato?'
      : `Reenviar para os ${falhados.length} contatos que falharam?`)) return
    setBusy(true)
    const { data: { session } } = await supabase.auth.getSession()
    const r = await fetch(`/api/campaigns/${camp.id}/retry`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(recipientIds?.length ? { recipientIds } : {}),
    })
    const j = await r.json().catch(() => ({}))
    setBusy(false)
    if (!r.ok) { alert(j.error || 'Falha ao reenviar.'); return }
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
  const falhados = recipients.filter((r: any) => r.status === 'failed')

  const pct = camp.total ? Math.round(((camp.sent + camp.failed) / camp.total) * 100) : 0

  // Indicadores de entrega/leitura/resposta — calculados dos recipients (mantidos vivos por realtime).
  const recebidas    = recipients.filter(r => r.delivered_at || r.read_at).length
  const visualizadas = recipients.filter(r => r.read_at).length
  const respondidas  = recipients.filter(r => r.replied_at).length

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
          {/* Estado da IA: o atendente precisa conferir isto SEM abrir o editor —
              é o que decide se um robô responde aos leads desta campanha. */}
          <p className="text-xs mt-1">
            {camp.bot_ativo === false ? (
              <span className="text-gray-500">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-gray-400 mr-1.5 align-middle" />
                IA desligada — respostas vão para atendimento humano
              </span>
            ) : (
              <span className="text-emerald-700">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 mr-1.5 align-middle" />
                IA responde · {camp.agente?.name || 'agente padrão'}
              </span>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          {supervisor && ['running', 'scheduled'].includes(camp.status) && (
            <button onClick={() => action('pause')} disabled={busy}
              className="flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg bg-orange-100 text-orange-700 hover:bg-orange-200">
              <Pause className="w-4 h-4" /> Pausar
            </button>
          )}
          {supervisor && ['paused', 'draft'].includes(camp.status) && camp.total > 0 && (
            <button onClick={() => action('start')} disabled={busy}
              className="flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700">
              <Play className="w-4 h-4" /> {camp.status === 'paused' ? 'Retomar' : 'Iniciar'}
            </button>
          )}
          {supervisor && camp.status !== 'running' && (
            <button onClick={() => setAddAberto(true)} disabled={busy}
              className="flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200">
              <UserPlus className="w-4 h-4" /> Adicionar contatos
            </button>
          )}
          {supervisor && editavel && (
            <button onClick={() => router.push(`/campaigns/${camp.id}/edit`)} disabled={busy}
              className="flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200">
              <Pencil className="w-4 h-4" /> Editar
            </button>
          )}
          {supervisor && <button onClick={excluir} disabled={busy} title="Excluir campanha"
            className="flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50">
            <Trash2 className="w-4 h-4" /> Excluir
          </button>}
        </div>
      </div>

      {addAberto && <AdicionarContatosDialog campaignId={camp.id} onClose={() => setAddAberto(false)} />}

      {/* Progresso */}
      <div className="bg-white border border-gray-100 rounded-xl p-5 mb-6">
        <div className="flex items-center justify-between text-sm mb-2">
          <span className="text-gray-600">{camp.sent + camp.failed} de {camp.total} processados</span>
          <span className="text-gray-400">{pct}%</span>
        </div>
        <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
          <div className="h-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2 mt-4 text-sm">
          <span className="flex items-center gap-1.5 text-emerald-600"><CheckCircle2 className="w-4 h-4" /> {camp.sent} enviados</span>
          <span className="flex items-center gap-1.5 text-red-500"><XCircle className="w-4 h-4" /> {camp.failed} falhas</span>
          <span className="flex items-center gap-1.5 text-gray-400"><Clock className="w-4 h-4" /> {camp.total - camp.sent - camp.failed} pendentes</span>
          <span className="flex items-center gap-1.5 text-emerald-600"><CheckCheck className="w-4 h-4" /> {recebidas} recebidas</span>
          <span className="flex items-center gap-1.5 text-blue-600"><Eye className="w-4 h-4" /> {visualizadas} visualizadas</span>
          <span className="flex items-center gap-1.5 text-violet-600"><Reply className="w-4 h-4" /> {respondidas} respondidas</span>
        </div>
      </div>

      {/* Disparos adicionais — visíveis também depois de enviados */}
      {disparos.length > 0 && (
        <div className="bg-white border border-gray-100 rounded-xl overflow-hidden mb-6">
          <div className="px-5 py-3 border-b border-gray-50 text-sm font-semibold text-gray-700">
            Disparos adicionais
          </div>
          <div className="divide-y divide-gray-50">
            {disparos.map((d: any, i: number) => (
              <div key={d.id} className="flex items-center justify-between px-5 py-2.5 text-sm">
                <div className="min-w-0">
                  <span className="text-gray-800">Disparo {i + 1}</span>
                  <span className="text-gray-400 ml-2 text-xs">{d.template?.name || '—'}</span>
                  <p className="text-[11px] text-gray-400">
                    {new Date(d.scheduled_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
                  </p>
                </div>
                <div className="flex items-center gap-3 shrink-0 text-xs">
                  {d.sent > 0 && <span className="text-emerald-600">{d.sent} enviados</span>}
                  {d.failed > 0 && <span className="text-red-500">{d.failed} falhas</span>}
                  <span className={cn('px-2 py-0.5 rounded-full text-[10px] font-bold uppercase',
                    d.status === 'done' ? 'bg-emerald-100 text-emerald-700'
                    : d.status === 'running' ? 'bg-amber-100 text-amber-700'
                    : 'bg-blue-100 text-blue-700')}>
                    {d.status === 'done' ? 'Concluído' : d.status === 'running' ? 'Enviando' : 'Agendado'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Destinatários */}
      <div className="bg-white border border-gray-100 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-50 flex items-center justify-between gap-3">
          <span className="text-sm font-semibold text-gray-700">Destinatários</span>
          {falhados.length > 0 && camp.status !== 'running' && (
            <button onClick={() => reenviar()} disabled={busy}
              className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-red-50 text-red-600 hover:bg-red-100 disabled:opacity-50">
              <RotateCw className="w-3.5 h-3.5" />
              Reenviar os {falhados.length} que falharam
            </button>
          )}
        </div>
        <div className="max-h-[50vh] overflow-y-auto divide-y divide-gray-50">
          {recipients.map(r => {
            const falhou = r.status === 'failed'
            const f = falhou ? descreverFalha(r.error) : null
            return (
              <div key={r.id} className="px-5 py-2.5 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <span className="text-gray-800">{r.name || r.wa_id}</span>
                    <span className="text-gray-400 ml-2 text-xs">{r.wa_id}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {r.replied_at && <span className="text-xs font-medium text-violet-600">Respondida</span>}
                    <RecipientStatus status={r.status} />
                    {falhou && camp.status !== 'running' && (
                      <button onClick={() => reenviar([r.id])} disabled={busy} title="Reenviar para este contato"
                        className="text-gray-400 hover:text-red-600 disabled:opacity-40">
                        <RotateCw className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Motivo da falha em linguagem de atendente; o texto cru da Meta
                    fica atrás de "detalhes" para quem precisar investigar. */}
                {f && (
                  <div className="mt-1 border-l-2 border-red-100 pl-2">
                    <p className="text-xs text-red-600 font-medium">
                      {f.titulo}
                      {!f.retentavel && <span className="ml-1.5 font-normal text-gray-400">· reenviar não resolve</span>}
                    </p>
                    <p className="text-[11px] text-gray-500 leading-snug">{f.explicacao}</p>
                    {f.bruto && (
                      <>
                        <button onClick={() => setDetalhe(detalhe === r.id ? null : r.id)}
                          className="mt-0.5 inline-flex items-center gap-0.5 text-[11px] text-gray-400 hover:text-gray-600">
                          <ChevronDown className={cn('w-3 h-3 transition-transform', detalhe === r.id && 'rotate-180')} />
                          {detalhe === r.id ? 'ocultar detalhes' : 'detalhes técnicos'}
                        </button>
                        {detalhe === r.id && (
                          <pre className="mt-1 text-[10px] text-gray-500 bg-gray-50 rounded-lg p-2 whitespace-pre-wrap break-all">{f.bruto}</pre>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            )
          })}
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
