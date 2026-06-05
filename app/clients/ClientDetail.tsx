'use client'

import Link from 'next/link'
import { ArrowLeft, MessageSquare, FileText, CalendarClock, Send, Phone, ExternalLink, Building2, Calendar, DollarSign } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { cn, formatCurrency, formatDate, getInitials, formatHour } from '@/lib/utils'

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

export default function ClientDetail({ cliente, boletosSienge, boletosSgl, reguaLog, conversations, messages }: {
  cliente: any; boletosSienge: any[]; boletosSgl: any[]; reguaLog: any[]; conversations: any[]; messages: any[]
}) {
  const o = ORIGEM[cliente.origem] || ORIGEM.contato

  // Timeline de cobrança (régua Sienge + SGL)
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
            {/* Ações (preparado p/ fase 2) */}
            <div className="flex items-center gap-2 mt-3">
              {cliente.conversation_id ? (
                <Link href={`/conversations/${cliente.conversation_id}`}
                  className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700">
                  <MessageSquare className="w-3.5 h-3.5" /> Abrir conversa
                </Link>
              ) : (
                <span className="text-xs text-gray-400">sem conversa</span>
              )}
              <button disabled title="Em breve" className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-gray-100 text-gray-400 cursor-not-allowed">
                <Send className="w-3.5 h-3.5" /> Enviar template
              </button>
              <button disabled title="Em breve" className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-gray-100 text-gray-400 cursor-not-allowed">
                <CalendarClock className="w-3.5 h-3.5" /> Adicionar à régua
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-5">
        {/* Boletos */}
        <section className="bg-white border border-gray-100 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-gray-800 flex items-center gap-1.5 mb-3"><FileText className="w-4 h-4 text-gray-400" /> Boletos</h2>
          {boletosSienge.length === 0 && boletosSgl.length === 0 && <p className="text-xs text-gray-400">Nenhum boleto em aberto.</p>}
          <div className="space-y-2">
            {boletosSienge.map((b, i) => (
              <div key={'s'+i} className="rounded-xl border border-gray-100 p-3 bg-gray-50 space-y-1.5">
                {b.empreendimento && <p className="text-[10px] font-medium text-gray-500 uppercase truncate">{b.empreendimento}{b.quadra ? ` · ${b.quadra}` : ''}{b.lote ? ` · ${b.lote}` : ''}</p>}
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-gray-800">Parcela {b.parcela || '—'}</span>
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-600">SIENGE</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="flex items-center gap-1 text-gray-500"><Calendar className="w-3 h-3" />{dt(b.due_date)}</span>
                  {b.amount != null && <span className="flex items-center gap-1 font-semibold text-gray-800"><DollarSign className="w-3 h-3 text-gray-400" />{formatCurrency(Number(b.amount))}</span>}
                </div>
                {b.link_boleto && <p className="text-[10px] text-gray-400 font-mono truncate">{b.link_boleto}</p>}
              </div>
            ))}
            {boletosSgl.map((b) => {
              const overdue = b.contasrecebervencimento && new Date(b.contasrecebervencimento) < new Date()
              return (
                <div key={'g'+b.id} className="rounded-xl border border-orange-100 p-3 bg-orange-50/50 space-y-1.5">
                  {b.unidadeempreendimento && <p className="text-[10px] font-medium text-orange-700 uppercase truncate flex items-center gap-1"><Building2 className="w-3 h-3" />{b.unidadeempreendimento}</p>}
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-gray-800">{b.contasreceberparcela || 'Parcela'}</span>
                    <span className={cn('text-[9px] font-bold px-1.5 py-0.5 rounded-full', b.status === 'pago' ? 'bg-emerald-100 text-emerald-600' : overdue ? 'bg-red-100 text-red-600' : 'bg-orange-100 text-orange-600')}>
                      {b.status === 'pago' ? 'PAGO' : overdue ? 'VENCIDO' : 'SGL'}
                    </span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="flex items-center gap-1 text-gray-500"><Calendar className="w-3 h-3" />{dt(b.contasrecebervencimento)}</span>
                    {sglAmount(b.contasrecebervalor) > 0 && <span className="font-semibold text-gray-800">{formatCurrency(sglAmount(b.contasrecebervalor))}</span>}
                  </div>
                  {b.linkboleto && <a href={b.linkboleto} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[11px] text-orange-600 hover:underline"><ExternalLink className="w-3 h-3" />Ver boleto</a>}
                </div>
              )
            })}
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
