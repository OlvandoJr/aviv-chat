'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  ChevronLeft, ChevronRight, CalendarDays,
  User, CreditCard, Clock, MessageSquare,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// ── Types ─────────────────────────────────────────────────────────────────────

interface CalEvent {
  id:                       string
  contact_name:             string | null
  contact_wa_id:            string | null
  scheduled_date:           string   // "YYYY-MM-DD"
  boleto_parcela:           string | null
  boleto_valor:             number | null
  status:                   string
  reminder_day_before_sent: boolean
  reminder_1h_before_sent:  boolean
  conversation_id:          string | null
  notes:                    string | null
  created_at:               string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const MONTHS = [
  'Janeiro','Fevereiro','Março','Abril','Maio','Junho',
  'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro',
]
const WEEKDAYS = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb']

function buildGrid(year: number, month: number) {
  const first    = new Date(year, month, 1)
  const last     = new Date(year, month + 1, 0)
  const startDow = first.getDay()   // 0 = Domingo
  const cells: { date: Date; isCurrentMonth: boolean }[] = []

  // Dias do mês anterior para preencher o início
  for (let i = startDow - 1; i >= 0; i--) {
    cells.push({ date: new Date(year, month, -i), isCurrentMonth: false })
  }
  // Dias do mês atual
  for (let d = 1; d <= last.getDate(); d++) {
    cells.push({ date: new Date(year, month, d), isCurrentMonth: true })
  }
  // Completar 42 células (6 semanas)
  let extra = 1
  while (cells.length < 42) {
    cells.push({ date: new Date(year, month + 1, extra++), isCurrentMonth: false })
  }
  return cells
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

function parseLocalDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function statusMeta(ev: CalEvent): { label: string; dot: string; pill: string } {
  if (ev.status === 'pago')       return { label: 'Pago',            dot: 'bg-emerald-400', pill: 'bg-emerald-50 text-emerald-700 border-emerald-200' }
  if (ev.status === 'cancelado')  return { label: 'Cancelado',       dot: 'bg-gray-300',    pill: 'bg-gray-50 text-gray-400 border-gray-200' }
  if (ev.reminder_1h_before_sent) return { label: 'Lembrete enviado',dot: 'bg-orange-400',  pill: 'bg-orange-50 text-orange-700 border-orange-200' }
  if (ev.reminder_day_before_sent)return { label: 'Lembrete D-1',    dot: 'bg-amber-400',   pill: 'bg-amber-50 text-amber-700 border-amber-200' }
  return                                 { label: 'Agendado',         dot: 'bg-blue-400',    pill: 'bg-blue-50 text-blue-700 border-blue-200' }
}

function fmtCurrency(v: number | null) {
  if (v == null) return null
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v)
}

function fmtDate(s: string) {
  return parseLocalDate(s).toLocaleDateString('pt-BR')
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function CalendarClient() {
  const supabase   = createClient()
  const todayObj   = new Date()
  const todayKey   = dateKey(todayObj)

  const [year,        setYear]       = useState(todayObj.getFullYear())
  const [month,       setMonth]      = useState(todayObj.getMonth())
  const [events,      setEvents]     = useState<CalEvent[]>([])
  const [selectedKey, setSelectedKey]= useState<string | null>(todayKey)
  const [loading,     setLoading]    = useState(true)

  const grid = buildGrid(year, month)

  // Agrupado por data
  const byDate = events.reduce<Record<string, CalEvent[]>>((acc, ev) => {
    acc[ev.scheduled_date] = acc[ev.scheduled_date]
      ? [...acc[ev.scheduled_date], ev]
      : [ev]
    return acc
  }, {})

  // Carregar eventos do intervalo visível
  useEffect(() => {
    async function load() {
      setLoading(true)
      const g   = buildGrid(year, month)
      const from = dateKey(g[0].date)
      const to   = dateKey(g[41].date)

      const { data } = await supabase
        .from('chat_scheduled_payments')
        .select('*')
        .gte('scheduled_date', from)
        .lte('scheduled_date', to)
        .order('scheduled_date', { ascending: true })

      setEvents(data || [])
      setLoading(false)
    }
    load()
  }, [year, month])

  function prevMonth() {
    if (month === 0) { setYear(y => y - 1); setMonth(11) }
    else setMonth(m => m - 1)
    setSelectedKey(null)
  }
  function nextMonth() {
    if (month === 11) { setYear(y => y + 1); setMonth(0) }
    else setMonth(m => m + 1)
    setSelectedKey(null)
  }
  function goToday() {
    setYear(todayObj.getFullYear())
    setMonth(todayObj.getMonth())
    setSelectedKey(todayKey)
  }

  const selectedEvents   = selectedKey ? (byDate[selectedKey] ?? []) : []
  const selectedDateObj  = selectedKey ? parseLocalDate(selectedKey) : null
  const totalMonth       = events.length

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full overflow-hidden">

      {/* ── Calendário ── */}
      <div className="flex-1 flex flex-col overflow-hidden p-6 min-w-0">

        {/* Cabeçalho */}
        <div className="flex items-center justify-between mb-5 shrink-0">
          <div>
            <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
              <CalendarDays className="w-5 h-5 text-emerald-600" />
              Calendário
            </h1>
            <p className="text-xs text-gray-400 mt-0.5">
              {loading
                ? 'Carregando...'
                : `${totalMonth} agendamento${totalMonth !== 1 ? 's' : ''} em ${MONTHS[month]} ${year}`}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={goToday}
              className="px-3 py-1.5 text-xs font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Hoje
            </button>
            <div className="flex items-center bg-white border border-gray-200 rounded-lg overflow-hidden">
              <button
                onClick={prevMonth}
                className="p-2 hover:bg-gray-50 transition-colors text-gray-500 border-r border-gray-100"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="px-4 py-1.5 text-sm font-semibold text-gray-900 min-w-[152px] text-center">
                {MONTHS[month]} {year}
              </span>
              <button
                onClick={nextMonth}
                className="p-2 hover:bg-gray-50 transition-colors text-gray-500 border-l border-gray-100"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        {/* Grade */}
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden flex-1 flex flex-col min-h-0">

          {/* Cabeçalho dos dias da semana */}
          <div className="grid grid-cols-7 border-b border-gray-100 shrink-0">
            {WEEKDAYS.map(wd => (
              <div key={wd} className="py-2.5 text-center text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
                {wd}
              </div>
            ))}
          </div>

          {/* Células */}
          <div className="grid grid-cols-7 flex-1 overflow-y-auto" style={{ gridTemplateRows: 'repeat(6, minmax(80px, 1fr))' }}>
            {grid.map(({ date, isCurrentMonth }, idx) => {
              const key       = dateKey(date)
              const dayEvs    = byDate[key] ?? []
              const isToday   = key === todayKey
              const isSel     = key === selectedKey
              const isWeekend = date.getDay() === 0 || date.getDay() === 6
              const shown     = dayEvs.slice(0, 2)
              const moreCount = dayEvs.length - 2

              return (
                <div
                  key={idx}
                  onClick={() => setSelectedKey(key)}
                  className={cn(
                    'relative p-2 border-b border-r border-gray-100 cursor-pointer transition-colors',
                    !isCurrentMonth && 'bg-gray-50/60',
                    isWeekend && isCurrentMonth && !isSel && 'bg-slate-50/60',
                    isSel && 'bg-emerald-50',
                    !isSel && isCurrentMonth && !isWeekend && 'hover:bg-gray-50',
                  )}
                >
                  {/* Número do dia */}
                  <div className="flex items-center justify-between mb-1">
                    <span className={cn(
                      'text-xs font-medium w-6 h-6 flex items-center justify-center rounded-full leading-none',
                      isToday  && 'bg-emerald-500 text-white font-bold',
                      !isToday && isCurrentMonth  && 'text-gray-800',
                      !isToday && !isCurrentMonth && 'text-gray-300',
                    )}>
                      {date.getDate()}
                    </span>
                    {dayEvs.length > 0 && (
                      <span className="text-[9px] font-bold text-gray-300 leading-none">
                        {dayEvs.length}
                      </span>
                    )}
                  </div>

                  {/* Pills de eventos */}
                  <div className="space-y-0.5">
                    {shown.map(ev => {
                      const m = statusMeta(ev)
                      return (
                        <div
                          key={ev.id}
                          className={cn(
                            'flex items-center gap-1 px-1.5 py-px rounded text-[10px] font-medium truncate border',
                            m.pill
                          )}
                        >
                          <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', m.dot)} />
                          <span className="truncate">{ev.contact_name || 'Cliente'}</span>
                        </div>
                      )
                    })}
                    {moreCount > 0 && (
                      <p className="text-[10px] text-gray-400 pl-1">
                        +{moreCount} mais
                      </p>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Legenda */}
        <div className="flex items-center gap-5 mt-3 shrink-0">
          {[
            { dot: 'bg-blue-400',    label: 'Agendado' },
            { dot: 'bg-amber-400',   label: 'Lembrete D-1' },
            { dot: 'bg-orange-400',  label: 'Lembrete enviado' },
            { dot: 'bg-emerald-400', label: 'Pago' },
            { dot: 'bg-gray-300',    label: 'Cancelado' },
          ].map(({ dot, label }) => (
            <div key={label} className="flex items-center gap-1.5">
              <span className={cn('w-2 h-2 rounded-full shrink-0', dot)} />
              <span className="text-[11px] text-gray-400">{label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Painel lateral ── */}
      <div className="w-72 shrink-0 border-l border-gray-200 bg-white flex flex-col overflow-hidden">

        {selectedDateObj ? (
          <>
            {/* Cabeçalho do dia */}
            <div className="p-4 border-b border-gray-100 shrink-0">
              <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest">
                {WEEKDAYS[selectedDateObj.getDay()]}
              </p>
              <p className="text-2xl font-bold text-gray-900 mt-0.5 leading-tight">
                {selectedDateObj.getDate()} de {MONTHS[selectedDateObj.getMonth()]}
              </p>
              <p className="text-xs text-gray-400 mt-0.5">
                {selectedEvents.length === 0
                  ? 'Nenhum agendamento'
                  : `${selectedEvents.length} agendamento${selectedEvents.length > 1 ? 's' : ''}`}
              </p>
            </div>

            {/* Lista de eventos */}
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {selectedEvents.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-32 text-center">
                  <CalendarDays className="w-7 h-7 text-gray-200 mb-2" />
                  <p className="text-xs text-gray-400">Nenhum agendamento neste dia</p>
                </div>
              ) : (
                selectedEvents.map(ev => {
                  const m   = statusMeta(ev)
                  const val = fmtCurrency(ev.boleto_valor)

                  return (
                    <div key={ev.id} className="bg-gray-50 border border-gray-200 rounded-xl p-3 space-y-2.5">

                      {/* Contato + status */}
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center shrink-0">
                            <User className="w-3.5 h-3.5 text-gray-500" />
                          </div>
                          <div className="min-w-0">
                            <p className="text-xs font-semibold text-gray-800 truncate leading-tight">
                              {ev.contact_name || 'Cliente'}
                            </p>
                            {ev.contact_wa_id && (
                              <p className="text-[10px] text-gray-400 font-mono leading-tight">
                                +{ev.contact_wa_id}
                              </p>
                            )}
                          </div>
                        </div>
                        <span className={cn(
                          'text-[10px] px-1.5 py-0.5 rounded-full border font-semibold shrink-0',
                          m.pill
                        )}>
                          {m.label}
                        </span>
                      </div>

                      {/* Parcela */}
                      {ev.boleto_parcela && (
                        <div className="flex items-center gap-1.5 text-[11px] text-gray-600">
                          <CreditCard className="w-3 h-3 text-gray-400 shrink-0" />
                          <span className="truncate">{ev.boleto_parcela}</span>
                        </div>
                      )}

                      {/* Valor */}
                      {val && (
                        <p className="text-sm font-bold text-gray-900">{val}</p>
                      )}

                      {/* Notas */}
                      {ev.notes && (
                        <p className="text-[10px] text-gray-500 italic leading-relaxed">
                          {ev.notes}
                        </p>
                      )}

                      {/* Rodapé */}
                      <div className="flex items-center justify-between pt-1 border-t border-gray-100">
                        <div className="flex items-center gap-1 text-[10px] text-gray-400">
                          <Clock className="w-2.5 h-2.5" />
                          Criado em {fmtDate(ev.created_at.slice(0, 10))}
                        </div>
                        {ev.conversation_id && (
                          <a
                            href={`/conversations/${ev.conversation_id}`}
                            className="flex items-center gap-1 text-[10px] text-emerald-600 hover:text-emerald-700 font-medium"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <MessageSquare className="w-2.5 h-2.5" />
                            Conversa
                          </a>
                        )}
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </>
        ) : (
          /* Estado vazio */
          <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
            <CalendarDays className="w-10 h-10 text-gray-200 mb-3" />
            <p className="text-sm font-medium text-gray-400">Selecione um dia</p>
            <p className="text-xs text-gray-300 mt-1">para ver os agendamentos</p>
          </div>
        )}
      </div>
    </div>
  )
}
