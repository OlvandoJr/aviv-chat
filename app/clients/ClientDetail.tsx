'use client'

import Link from 'next/link'
import { ArrowLeft, MessageSquare, FileText, CalendarClock, Send, Phone, Building2, Calendar, DollarSign, Layers, FileCheck2, ExternalLink } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { cn, formatCurrency, getInitials, formatHour, mediaSrc } from '@/lib/utils'
import ConfirmPaymentButton from '@/components/clients/ConfirmPaymentButton'
import BoletoActions        from '@/components/clients/BoletoActions'

const ORIGEM: Record<string, { label: string; cls: string }> = {
  sienge:  { label: 'Sienge', cls: 'bg-blue-100 text-blue-700' },
  sgl:     { label: 'SGL',    cls: 'bg-orange-100 text-orange-700' },
  ambos:   { label: 'Ambos',  cls: 'bg-violet-100 text-violet-700' },
  contato: { label: 'Contato',cls: 'bg-gray-100 text-gray-600' },
}

function sglAmount(v: string | null) {
  if (!v) return 0
  return parseFloat(v.replace(/\./g, '').replace(',', '.')) || 0
}
function dt(d?: string | null) { return d ? new Date(d).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : '—' }
function dtTime(d?: string | null) { return d ? new Date(d).toLocaleString('pt-BR') : '—' }

const PAGO_ST  = ['pago', 'comprovante_confirmado', 'baixado', 'pago_confirmado', 'quitado']
const COMPR_ST = ['comprovante_recebido', 'comprovante', 'em_validacao']
function estado(status: string | null, dueDate: string | null, paidAt?: string | null) {
  const s = (status || '').toLowerCase()
  if (paidAt || PAGO_ST.includes(s)) return { label: 'PAGO', cls: 'bg-emerald-100 text-emerald-700' }
  if (COMPR_ST.includes(s))          return { label: 'COMPROVANTE', cls: 'bg-amber-100 text-amber-700' }
  const hoje = new Date().toISOString().slice(0, 10)
  if (dueDate && String(dueDate).slice(0, 10) < hoje) return { label: 'VENCIDO', cls: 'bg-red-100 text-red-600' }
  return { label: 'EM ABERTO', cls: 'bg-gray-100 text-gray-500' }
}
const statusRank = (s: string | null) => PAGO_ST.includes((s || '').toLowerCase()) ? 3 : COMPR_ST.includes((s || '').toLowerCase()) ? 2 : 1

// Veredito do comprovante → badge curto
function verdictBadge(v: string | null) {
  const t = (v || '').toLowerCase()
  if (/100\s*%/.test(t))       return { label: '100% válido', cls: 'bg-emerald-100 text-emerald-700' }
  if (/80\s*%/.test(t))        return { label: '80% válido',  cls: 'bg-blue-100 text-blue-700' }
  if (/50\s*%/.test(t))        return { label: '50% válido',  cls: 'bg-amber-100 text-amber-700' }
  if (/negad/.test(t))         return { label: 'Negado',      cls: 'bg-red-100 text-red-600' }
  return { label: 'Analisado', cls: 'bg-gray-100 text-gray-500' }
}

export default function ClientDetail({ cliente, boletosEmitidos, boletosSienge, boletosSgl, reguaLog, comprovantes, conversations, messages, windowOpen }: {
  cliente: any; boletosEmitidos: any[]; boletosSienge: any[]; boletosSgl: any[]; reguaLog: any[]; comprovantes: any[]; conversations: any[]; messages: any[]; windowOpen: boolean
}) {
  const o = ORIGEM[cliente.origem] || ORIGEM.contato

  // ── Resumo de PARCELAS (Sienge + SGL) — não lista uma a uma ────────────────
  type Parc = { label: string; amount: number; pago: boolean }
  const parcelas: Parc[] = [
    ...boletosSienge.map((b) => ({
      label: b.parcela_descricao || 'Parcela',
      amount: Number(b.amount) || 0,
      pago: statusRank(b.status) >= 3 || !!b.paid_at,
    })),
    // SGL deduplicado por parcela (status mais avançado)
    ...Object.values((() => {
      const m: Record<string, any> = {}
      for (const b of boletosSgl) {
        const k = b.contasreceberparcela || String(b.id)
        if (!m[k] || statusRank(b.status) > statusRank(m[k].status)) m[k] = b
      }
      return m
    })()).map((b: any) => ({
      label: b.contasreceberparcela || 'Parcela',
      amount: sglAmount(b.contasrecebervalor),
      pago: statusRank(b.status) >= 3,
    })),
  ]
  const parcAbertas = parcelas.filter((p) => !p.pago)
  const totalAberto = parcAbertas.reduce((s, p) => s + p.amount, 0)
  const parcPagas   = parcelas.length - parcAbertas.length
  const tipos       = [...new Set(parcelas.map((p) => p.label).filter(Boolean))]

  // ── Timeline de cobrança ───────────────────────────────────────────────────
  const timeline = [
    ...reguaLog.map((r) => ({ when: r.run_date, canal: 'Régua Sienge', detalhe: `D${r.offset_days >= 0 ? '+' : ''}${r.offset_days} · venc ${dt(r.due_date)}`, status: r.status })),
    ...boletosSgl.filter((m) => m.app_dispatched_at).map((m) => ({ when: m.app_dispatched_at, canal: 'SGL', detalhe: m.classificacao || '—', status: m.status })),
  ].sort((a, b) => new Date(b.when).getTime() - new Date(a.when).getTime())

  return (
    <>
      <Link href="/clients" className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4">
        <ArrowLeft className="w-4 h-4" /> Central de Clientes
      </Link>

      {/* Cabeçalho */}
      <div className="bg-white border border-gray-100 rounded-xl p-5 mb-5">
        <div className="flex items-start gap-4">
          <Avatar className="w-14 h-14">
            <AvatarImage src={cliente.profile_picture_url || ''} />
            <AvatarFallback className="text-lg">{getInitials(cliente.nome || '?')}</AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-lg font-bold text-gray-900">{cliente.nome || cliente.telefone}</h1>
              <span className={cn('text-[10px] font-bold px-2 py-0.5 rounded-full uppercase', o.cls)}>{o.label}</span>
              {cliente.conversa_aberta && <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">Conversa aberta</span>}
              {cliente.boleto_vencido && <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-red-100 text-red-700">Boleto vencido</span>}
            </div>
            <div className="flex items-center gap-3 text-xs text-gray-500 mt-1">
              <span className="flex items-center gap-1"><Phone className="w-3 h-3" />{cliente.telefone}</span>
              {cliente.cpf && <span>CPF {cliente.cpf}</span>}
            </div>
            <div className="flex items-center gap-2 mt-3">
              {cliente.conversation_id ? (
                <Link href={`/conversations/${cliente.conversation_id}`}
                  className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700">
                  <MessageSquare className="w-3.5 h-3.5" /> Abrir conversa
                </Link>
              ) : (
                <span className="text-xs text-gray-400">sem conversa</span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-5">
        {/* Boletos (de verdade — boletos_emitidos) */}
        <section className="bg-white border border-gray-100 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-gray-800 flex items-center gap-1.5 mb-3"><FileText className="w-4 h-4 text-gray-400" /> Boletos</h2>
          {boletosEmitidos.length === 0 ? (
            <p className="text-xs text-gray-400">Nenhum boleto emitido no banco para este cliente.</p>
          ) : (
            <div className="space-y-2">
              {boletosEmitidos.map((b) => {
                const e = estado(b.status, b.due_date, b.paid_at)
                return (
                  <div key={b.emitido_id} className="rounded-xl border border-gray-100 p-3 bg-gray-50 space-y-1.5">
                    {b.empreendimento && <p className="text-[10px] font-medium text-gray-500 uppercase truncate">{b.empreendimento}{b.quadra ? ` · Q${b.quadra}` : ''}{b.unidade_lote ? ` · L${b.unidade_lote}` : ''}</p>}
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-gray-800 truncate">{b.parcela_descricao || `Boleto venc. ${dt(b.due_date)}`}</span>
                      <span className={cn('text-[9px] font-bold px-1.5 py-0.5 rounded-full shrink-0', e.cls)}>{e.label}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="flex items-center gap-1 text-gray-500"><Calendar className="w-3 h-3" />{dt(b.due_date)}</span>
                      {b.amount != null && <span className="flex items-center gap-1 font-semibold text-gray-800"><DollarSign className="w-3 h-3 text-gray-400" />{formatCurrency(Number(b.amount))}</span>}
                    </div>
                    {b.paid_at && <p className="text-[10px] text-emerald-600">Baixa em {dt(b.paid_at)}</p>}
                    <BoletoActions emitidoId={b.emitido_id} hasPdf={!!b.pdf_path} conversationId={cliente.conversation_id || null} windowOpen={windowOpen} />
                    {e.label !== 'PAGO' && (
                      <div className="pt-0.5"><ConfirmPaymentButton source="emitido" id={b.emitido_id} /></div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* Resumo de parcelas */}
          <div className="mt-4 pt-4 border-t border-gray-100">
            <h3 className="text-xs font-semibold text-gray-700 flex items-center gap-1.5 mb-2"><Layers className="w-3.5 h-3.5 text-gray-400" /> Resumo de parcelas</h3>
            {parcelas.length === 0 ? (
              <p className="text-xs text-gray-400">Sem parcelas registradas.</p>
            ) : (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 flex-wrap text-xs">
                  <span className="px-2 py-1 rounded-lg bg-gray-50 border border-gray-100 text-gray-700">
                    <strong>{parcAbertas.length}</strong> em aberto
                  </span>
                  <span className="px-2 py-1 rounded-lg bg-gray-50 border border-gray-100 text-gray-700">
                    Total: <strong>{formatCurrency(totalAberto)}</strong>
                  </span>
                  {parcPagas > 0 && (
                    <span className="px-2 py-1 rounded-lg bg-emerald-50 border border-emerald-100 text-emerald-700">
                      <strong>{parcPagas}</strong> paga(s)
                    </span>
                  )}
                </div>
                {tipos.length > 0 && (
                  <p className="text-[11px] text-gray-500">Parcelas: {tipos.slice(0, 8).join(', ')}{tipos.length > 8 ? '…' : ''}</p>
                )}
              </div>
            )}
          </div>
        </section>

        {/* Histórico de cobrança */}
        <section className="bg-white border border-gray-100 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-gray-800 flex items-center gap-1.5 mb-3"><CalendarClock className="w-4 h-4 text-gray-400" /> Histórico de cobrança</h2>
          {timeline.length === 0 ? <p className="text-xs text-gray-400">Nenhuma cobrança enviada.</p> : (
            <div className="space-y-2 max-h-72 overflow-y-auto">
              {timeline.map((t, i) => (
                <div key={i} className="flex items-start gap-2 text-xs">
                  <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 mt-1.5 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-gray-700"><span className="font-medium">{t.canal}</span> · {t.detalhe}</p>
                    <p className="text-[11px] text-gray-400">{dtTime(t.when)}{t.status ? ` · ${t.status}` : ''}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Histórico de comprovantes */}
          <div className="mt-4 pt-4 border-t border-gray-100">
            <h3 className="text-xs font-semibold text-gray-700 flex items-center gap-1.5 mb-2"><FileCheck2 className="w-3.5 h-3.5 text-gray-400" /> Comprovantes enviados</h3>
            {comprovantes.length === 0 ? (
              <p className="text-xs text-gray-400">Nenhum comprovante recebido.</p>
            ) : (
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {comprovantes.map((c) => {
                  const vb = verdictBadge(c.verdict)
                  return (
                    <div key={c.message_id} className="flex items-start gap-2 text-xs">
                      <FileCheck2 className="w-3.5 h-3.5 text-violet-400 mt-0.5 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-gray-500">{dtTime(c.created_at)}</span>
                          <span className={cn('text-[9px] font-bold px-1.5 py-0.5 rounded-full', vb.cls)}>{vb.label}</span>
                          {c.sienge_status === 'pago' && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700">PAGO</span>}
                        </div>
                        {c.verdict && <p className="text-[11px] text-gray-500 line-clamp-2">{c.verdict}</p>}
                        <div className="flex items-center gap-3 mt-0.5">
                          {c.media_url && (
                            <a href={mediaSrc(c.media_url)} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[11px] text-emerald-600 hover:underline">
                              <ExternalLink className="w-3 h-3" /> Ver arquivo
                            </a>
                          )}
                          {c.conversation_id && (
                            <Link href={`/conversations/${c.conversation_id}`} className="text-[11px] text-gray-400 hover:text-gray-600">na conversa →</Link>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </section>
      </div>

      {/* Conversa */}
      <section className="bg-white border border-gray-100 rounded-xl p-5 mt-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-800 flex items-center gap-1.5"><MessageSquare className="w-4 h-4 text-gray-400" /> Conversa {conversations.length > 1 && <span className="text-xs text-gray-400">({conversations.length} conversas)</span>}</h2>
          {cliente.conversation_id && <Link href={`/conversations/${cliente.conversation_id}`} className="text-xs text-emerald-600 hover:underline">Abrir conversa completa →</Link>}
        </div>
        {messages.length === 0 ? <p className="text-xs text-gray-400">Sem mensagens.</p> : (
          <div className="space-y-1.5 max-h-[420px] overflow-y-auto bg-[#f0f2f5] rounded-lg p-3">
            {messages.map((m) => (
              <div key={m.id} className={cn('flex', m.direction === 'out' ? 'justify-end' : 'justify-start')}>
                <div className={cn('max-w-[75%] rounded-lg px-3 py-1.5 text-sm', m.direction === 'out' ? 'bg-emerald-100 text-gray-800' : 'bg-white text-gray-800 border border-gray-100')}>
                  {m.type !== 'text' && m.type !== 'template' && <p className="text-[10px] text-gray-400 italic mb-0.5">[{m.type}]</p>}
                  <p className="whitespace-pre-wrap break-words">{m.content || '—'}</p>
                  <p className="text-[10px] text-gray-400 text-right mt-0.5">{formatHour(m.created_at)}{m.direction === 'out' && m.wa_status ? ` · ${m.wa_status}` : ''}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  )
}
