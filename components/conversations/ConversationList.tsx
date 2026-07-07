'use client'

import { useEffect, useState, useCallback, useTransition, useRef } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Search, Bell, Loader2, ChevronDown, FileCheck2, Check, Lock } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { formatTime, getInitials, cn } from '@/lib/utils'
import type { Conversation } from '@/lib/types'

type StatusFilter     = 'open' | 'resolved' | 'archived'
type AttendanceFilter = 'all' | 'bot' | 'human'

const STATUS_OPTS: { value: StatusFilter; label: string }[] = [
  { value: 'open',     label: 'Abertas'    },
  { value: 'resolved', label: 'Resolvidas' },
  { value: 'archived', label: 'Arquivadas' },
]
const ATTENDANCE_OPTS: { value: AttendanceFilter; label: string }[] = [
  { value: 'all',   label: 'Todos'     },
  { value: 'human', label: 'Humano'    },
  { value: 'bot',   label: 'Agente IA' },
]

export default function ConversationList() {
  const router   = useRouter()
  const pathname = usePathname()
  const supabase = createClient()

  const [conversations, setConversations] = useState<Conversation[]>([])
  const [pendingCount,  setPendingCount]  = useState(0)
  const [receiptCount,  setReceiptCount]  = useState(0)
  const [internalCount, setInternalCount] = useState(0)
  const [search,        setSearch]        = useState('')
  const [statuses,      setStatuses]      = useState<StatusFilter[]>(['open'])
  const [attendance,    setAttendance]    = useState<AttendanceFilter>('all')
  const [receiptOnly,   setReceiptOnly]   = useState(false)
  const [internalOnly,  setInternalOnly]  = useState(false)
  const [loading,       setLoading]       = useState(true)
  const [isPending, startTransition]      = useTransition()
  const [optimisticId, setOptimisticId]   = useState<string | null>(null)

  const pathId   = pathname.split('/conversations/')[1] || null
  const activeId = optimisticId ?? pathId

  useEffect(() => { setOptimisticId(null) }, [pathname])

  const selectConversation = useCallback((convId: string) => {
    if (convId === pathId) return
    setOptimisticId(convId)
    startTransition(() => router.push(`/conversations/${convId}`))
  }, [pathId, router])

  const fetchConversations = useCallback(async () => {
    const activeStatuses = statuses.length ? statuses : ['open']
    let query = supabase
      .from('chat_conversations')
      .select(`
        *,
        contact:chat_contacts(id, wa_id, name, profile_picture_url),
        assignee:chat_attendants(id, name, avatar_url)
      `)
      .in('status', activeStatuses)
      .order('last_message_at', { ascending: false })
      .limit(50)

    if (attendance === 'bot') {
      query = query.eq('handled_by', 'bot')
    } else if (attendance === 'human') {
      query = query.in('handled_by', ['human', 'pending_human'])
    }
    if (receiptOnly) query = query.eq('receipt_validation', true)
    // Conversas internas (notificações a corretores) ficam ocultas por padrão.
    query = internalOnly ? query.eq('is_internal', true) : query.eq('is_internal', false)
    if (search.trim()) query = query.ilike('contact.name', `%${search}%`)

    const { data } = await query
    const list = (data as Conversation[]) || []

    // Ordenar: pending_human e validação de comprovante sempre no topo
    const score = (c: Conversation) =>
      (c.handled_by === 'pending_human' ? 2 : 0) + (c.receipt_validation ? 1 : 0)
    list.sort((a, b) => score(b) - score(a))

    setConversations(list)
    setLoading(false)
  }, [statuses, attendance, receiptOnly, internalOnly, search])

  // Contadores globais (independentes dos filtros ativos)
  const fetchCounts = useCallback(async () => {
    const [{ count: pend }, { count: rec }, { count: intern }] = await Promise.all([
      supabase.from('chat_conversations').select('id', { count: 'exact', head: true })
        .eq('status', 'open').eq('handled_by', 'pending_human').eq('is_internal', false),
      supabase.from('chat_conversations').select('id', { count: 'exact', head: true })
        .eq('status', 'open').eq('receipt_validation', true).eq('is_internal', false),
      supabase.from('chat_conversations').select('id', { count: 'exact', head: true })
        .eq('status', 'open').eq('is_internal', true),
    ])
    setPendingCount(pend || 0)
    setReceiptCount(rec || 0)
    setInternalCount(intern || 0)
  }, [])

  useEffect(() => {
    fetchConversations()
    fetchCounts()

    const channel = supabase
      .channel('conversations-list')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'chat_conversations' },
        () => { fetchConversations(); fetchCounts() }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [fetchConversations, fetchCounts])

  function toggleStatus(s: StatusFilter) {
    setStatuses((prev) => {
      const has = prev.includes(s)
      const next = has ? prev.filter((x) => x !== s) : [...prev, s]
      return next.length ? next : prev   // nunca deixa vazio
    })
  }

  const statusLabel =
    statuses.length === 0 || statuses.length === STATUS_OPTS.length
      ? 'Status: Todos'
      : statuses.length === 1
        ? `Status: ${STATUS_OPTS.find((o) => o.value === statuses[0])?.label}`
        : `Status: ${statuses.length} selecionados`

  return (
    <div className="w-80 flex flex-col border-r border-gray-200 bg-white shrink-0 h-full">
      {/* Header */}
      <div className="p-4 border-b border-gray-100">
        <div className="flex items-center justify-between mb-3 gap-1.5">
          <h1 className="text-base font-semibold text-gray-900 shrink-0">Conversas</h1>
          <div className="flex items-center gap-1.5 flex-wrap justify-end">
            {pendingCount > 0 && (
              <button
                onClick={() => { setStatuses(['open']); setAttendance('human'); setReceiptOnly(false); setInternalOnly(false) }}
                className="flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-50 border border-amber-300 text-amber-700 text-[11px] font-semibold animate-pulse hover:bg-amber-100 transition-colors"
                title="Ver conversas aguardando atendente"
              >
                <Bell className="w-3 h-3" />
                {pendingCount} aguardando
              </button>
            )}
            {receiptCount > 0 && (
              <button
                onClick={() => { setStatuses(['open']); setReceiptOnly(true); setAttendance('all'); setInternalOnly(false) }}
                className={cn(
                  'flex items-center gap-1 px-2 py-1 rounded-lg border text-[11px] font-semibold transition-colors',
                  receiptOnly
                    ? 'bg-violet-600 border-violet-600 text-white'
                    : 'bg-violet-50 border-violet-300 text-violet-700 hover:bg-violet-100'
                )}
                title="Ver conversas aguardando validação de comprovante"
              >
                <FileCheck2 className="w-3 h-3" />
                {receiptCount} comprovante
              </button>
            )}
            {internalCount > 0 && (
              <button
                onClick={() => { setStatuses(['open']); setInternalOnly(true); setReceiptOnly(false); setAttendance('all') }}
                className={cn(
                  'flex items-center gap-1 px-2 py-1 rounded-lg border text-[11px] font-semibold transition-colors',
                  internalOnly
                    ? 'bg-slate-600 border-slate-600 text-white'
                    : 'bg-slate-50 border-slate-300 text-slate-600 hover:bg-slate-100'
                )}
                title="Ver conversas internas (notificações a corretores)"
              >
                <Lock className="w-3 h-3" />
                {internalCount} internas
              </button>
            )}
          </div>
        </div>

        {/* Busca */}
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-gray-400" />
          <Input
            placeholder="Buscar..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-8 text-sm"
          />
        </div>

        {/* Filtros: Status (multi) + Atendimento (único) */}
        <div className="flex gap-2 mt-3">
          <FilterDropdown label={statusLabel} className="flex-1">
            {STATUS_OPTS.map((o) => (
              <OptionRow
                key={o.value}
                label={o.label}
                checked={statuses.includes(o.value)}
                onClick={() => toggleStatus(o.value)}
              />
            ))}
          </FilterDropdown>

          <FilterDropdown
            label={`Atendimento: ${ATTENDANCE_OPTS.find((o) => o.value === attendance)?.label}`}
            className="flex-1"
          >
            {ATTENDANCE_OPTS.map((o) => (
              <OptionRow
                key={o.value}
                label={o.label}
                checked={attendance === o.value}
                radio
                onClick={() => setAttendance(o.value)}
              />
            ))}
          </FilterDropdown>
        </div>

        {/* Filtro ativo de comprovante */}
        {receiptOnly && (
          <button
            onClick={() => setReceiptOnly(false)}
            className="mt-2 w-full flex items-center justify-center gap-1.5 px-2 py-1 rounded-md bg-violet-50 border border-violet-200 text-violet-700 text-[11px] font-medium hover:bg-violet-100 transition-colors"
          >
            <FileCheck2 className="w-3 h-3" />
            Filtrando: Validação de comprovante
            <span className="ml-1 text-violet-400">✕ limpar</span>
          </button>
        )}

        {/* Filtro ativo de internas */}
        {internalOnly && (
          <button
            onClick={() => setInternalOnly(false)}
            className="mt-2 w-full flex items-center justify-center gap-1.5 px-2 py-1 rounded-md bg-slate-100 border border-slate-200 text-slate-600 text-[11px] font-medium hover:bg-slate-200 transition-colors"
          >
            <Lock className="w-3 h-3" />
            Filtrando: Internas (corretores)
            <span className="ml-1 text-slate-400">✕ limpar</span>
          </button>
        )}
      </div>

      {/* Lista */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-4 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex gap-3 animate-pulse">
                <div className="w-10 h-10 rounded-full bg-gray-100 shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 bg-gray-100 rounded w-3/4" />
                  <div className="h-3 bg-gray-100 rounded w-1/2" />
                </div>
              </div>
            ))}
          </div>
        ) : conversations.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-400">
            {receiptOnly ? 'Nenhuma conversa aguardando validação de comprovante.'
              : internalOnly ? 'Nenhuma conversa interna.'
              : 'Nenhuma conversa encontrada.'}
          </div>
        ) : (
          conversations.map((conv) => (
            <ConversationItem
              key={conv.id}
              conversation={conv}
              active={conv.id === activeId}
              pending={isPending && conv.id === optimisticId}
              onClick={() => selectConversation(conv.id)}
              onPrefetch={() => router.prefetch(`/conversations/${conv.id}`)}
            />
          ))
        )}
      </div>
    </div>
  )
}

// ── Dropdown de filtro (abre painel com opções) ──────────────────────────────
function FilterDropdown({ label, className, children }: {
  label: string; className?: string; children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])
  return (
    <div className={cn('relative', className)} ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'w-full flex items-center justify-between gap-1 px-2.5 py-1.5 text-xs rounded-md border transition-colors',
          open ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'
        )}
      >
        <span className="truncate">{label}</span>
        <ChevronDown className={cn('w-3.5 h-3.5 shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 w-full min-w-[150px] bg-white border border-gray-200 rounded-xl shadow-lg z-50 overflow-hidden py-1">
          {children}
        </div>
      )}
    </div>
  )
}

function OptionRow({ label, checked, radio, onClick }: {
  label: string; checked: boolean; radio?: boolean; onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-gray-50 transition-colors',
        checked ? 'text-emerald-700 font-medium' : 'text-gray-600'
      )}
    >
      <span className={cn(
        'w-3.5 h-3.5 flex items-center justify-center shrink-0 border',
        radio ? 'rounded-full' : 'rounded',
        checked ? 'bg-emerald-600 border-emerald-600 text-white' : 'border-gray-300'
      )}>
        {checked && <Check className="w-2.5 h-2.5" />}
      </span>
      {label}
    </button>
  )
}

function ConversationItem({
  conversation: conv,
  active,
  pending,
  onClick,
  onPrefetch,
}: {
  conversation: Conversation
  active:       boolean
  pending:      boolean
  onClick:      () => void
  onPrefetch:   () => void
}) {
  const contact     = conv.contact
  const name        = contact?.name || contact?.wa_id || 'Desconhecido'
  const isPending   = conv.handled_by === 'pending_human'
  const needsReceipt = conv.receipt_validation

  return (
    <button
      onClick={onClick}
      onMouseEnter={onPrefetch}
      className={cn(
        'w-full flex items-start gap-3 px-4 py-3 hover:bg-gray-50 transition-colors text-left border-b border-gray-50 relative',
        active     && 'bg-emerald-50 border-l-[3px] border-l-emerald-500',
        isPending  && !active && 'bg-amber-50/60 border-l-[3px] border-l-amber-400',
        !isPending && needsReceipt && !active && 'bg-violet-50/60 border-l-[3px] border-l-violet-400'
      )}
    >
      {pending && (
        <Loader2 className="absolute right-2.5 bottom-2.5 w-3.5 h-3.5 text-emerald-500 animate-spin" />
      )}
      <div className="relative shrink-0">
        <Avatar className="w-10 h-10">
          <AvatarImage src={contact?.profile_picture_url || ''} />
          <AvatarFallback>{getInitials(name)}</AvatarFallback>
        </Avatar>
        {isPending && (
          <span className="absolute -top-1 -right-1 w-4 h-4 bg-amber-500 rounded-full flex items-center justify-center">
            <Bell className="w-2.5 h-2.5 text-white" />
          </span>
        )}
        {!isPending && needsReceipt && (
          <span className="absolute -top-1 -right-1 w-4 h-4 bg-violet-500 rounded-full flex items-center justify-center">
            <FileCheck2 className="w-2.5 h-2.5 text-white" />
          </span>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className={cn(
            'text-sm font-medium truncate',
            isPending ? 'text-amber-900' : needsReceipt ? 'text-violet-900' : 'text-gray-900'
          )}>
            {name}
          </span>
          <span className="text-xs text-gray-400 shrink-0">
            {formatTime(conv.last_message_at)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2 mt-0.5">
          <p className="text-xs text-gray-500 truncate">
            {conv.last_message_preview || '—'}
          </p>
          {conv.unread_count > 0 && (
            <Badge className="text-[10px] px-1.5 py-0 h-4 shrink-0 bg-emerald-600">
              {conv.unread_count}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
          {conv.assignee && (
            <p className="text-[10px] text-gray-400 truncate">
              → {conv.assignee.name}
            </p>
          )}
          {isPending && (
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500 text-white shrink-0 flex items-center gap-1">
              <Bell className="w-2.5 h-2.5" />
              Aguarda atendente
            </span>
          )}
          {needsReceipt && (
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-violet-500 text-white shrink-0 flex items-center gap-1">
              <FileCheck2 className="w-2.5 h-2.5" />
              Validação de comprovante
            </span>
          )}
          {conv.is_internal && (
            <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-slate-200 text-slate-700 shrink-0 flex items-center gap-1">
              <Lock className="w-2.5 h-2.5" />
              Interna
            </span>
          )}
          {conv.handled_by === 'human' && !conv.is_internal && (
            <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 shrink-0">
              Humano
            </span>
          )}
        </div>
      </div>
    </button>
  )
}
