'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Search, Bell } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { formatTime, getInitials, cn } from '@/lib/utils'
import type { Conversation } from '@/lib/types'

type StatusFilter     = 'open' | 'resolved' | 'archived'
type AttendanceFilter = 'all' | 'bot' | 'human'

export default function ConversationList() {
  const router   = useRouter()
  const pathname = usePathname()
  const supabase = createClient()

  const [conversations, setConversations] = useState<Conversation[]>([])
  const [pendingCount,  setPendingCount]  = useState(0)
  const [search,        setSearch]        = useState('')
  const [status,        setStatus]        = useState<StatusFilter>('open')
  const [attendance,    setAttendance]    = useState<AttendanceFilter>('all')
  const [loading,       setLoading]       = useState(true)

  const activeId = pathname.split('/conversations/')[1] || null

  const fetchConversations = useCallback(async () => {
    let query = supabase
      .from('chat_conversations')
      .select(`
        *,
        contact:chat_contacts(id, wa_id, name, profile_picture_url),
        assignee:chat_attendants(id, name, avatar_url)
      `)
      .eq('status', status)
      .order('last_message_at', { ascending: false })
      .limit(50)

    if (attendance === 'bot') {
      query = query.eq('handled_by', 'bot')
    } else if (attendance === 'human') {
      query = query.in('handled_by', ['human', 'pending_human'])
    }

    if (search.trim()) {
      query = query.ilike('contact.name', `%${search}%`)
    }

    const { data } = await query
    const list = (data as Conversation[]) || []

    // Ordenar: pending_human sempre no topo
    list.sort((a, b) => {
      if (a.handled_by === 'pending_human' && b.handled_by !== 'pending_human') return -1
      if (b.handled_by === 'pending_human' && a.handled_by !== 'pending_human') return 1
      return 0
    })

    setConversations(list)
    setLoading(false)
  }, [status, attendance, search])

  // Contador global de pending_human abertas (independente dos filtros ativos)
  const fetchPendingCount = useCallback(async () => {
    const { count } = await supabase
      .from('chat_conversations')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'open')
      .eq('handled_by', 'pending_human')
    setPendingCount(count || 0)
  }, [])

  useEffect(() => {
    fetchConversations()
    fetchPendingCount()

    const channel = supabase
      .channel('conversations-list')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'chat_conversations' },
        () => { fetchConversations(); fetchPendingCount() }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [fetchConversations, fetchPendingCount])

  return (
    <div className="w-80 flex flex-col border-r border-gray-200 bg-white shrink-0 h-full">
      {/* Header */}
      <div className="p-4 border-b border-gray-100">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-base font-semibold text-gray-900">Conversas</h1>
          {pendingCount > 0 && (
            <button
              onClick={() => { setStatus('open'); setAttendance('human') }}
              className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-amber-50 border border-amber-300 text-amber-700 text-xs font-semibold animate-pulse hover:bg-amber-100 transition-colors"
              title="Ver conversas aguardando atendente"
            >
              <Bell className="w-3 h-3" />
              {pendingCount} aguardando
            </button>
          )}
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

        {/* Filtros de status */}
        <div className="flex gap-1 mt-3">
          {(['open', 'resolved', 'archived'] as StatusFilter[]).map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={cn(
                'flex-1 py-1 text-xs rounded-md font-medium transition-colors',
                status === s
                  ? 'bg-emerald-600 text-white'
                  : 'text-gray-500 hover:bg-gray-100'
              )}
            >
              {s === 'open' ? 'Abertas' : s === 'resolved' ? 'Resolvidas' : 'Arquivadas'}
            </button>
          ))}
        </div>

        {/* Filtro de atendimento */}
        <div className="flex gap-1 mt-2">
          <span className="text-[10px] text-gray-400 self-center mr-1 shrink-0">Atendimento:</span>
          {([
            { value: 'all',   label: 'Todos'     },
            { value: 'human', label: 'Humano'    },
            { value: 'bot',   label: 'Agente IA' },
          ] as { value: AttendanceFilter; label: string }[]).map(({ value, label }) => (
            <button
              key={value}
              onClick={() => setAttendance(value)}
              className={cn(
                'flex-1 py-1 text-[11px] rounded-md font-medium transition-colors',
                attendance === value
                  ? value === 'human'
                    ? 'bg-blue-600 text-white'
                    : value === 'bot'
                    ? 'bg-violet-600 text-white'
                    : 'bg-gray-600 text-white'
                  : 'text-gray-500 hover:bg-gray-100'
              )}
            >
              {label}
            </button>
          ))}
        </div>
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
            Nenhuma conversa{' '}
            {status === 'open' ? 'aberta' : status === 'resolved' ? 'resolvida' : 'arquivada'}
            {attendance === 'human' ? ' com atendimento humano' : attendance === 'bot' ? ' com Agente IA' : ''}
          </div>
        ) : (
          conversations.map((conv) => (
            <ConversationItem
              key={conv.id}
              conversation={conv}
              active={conv.id === activeId}
              onClick={() => router.push(`/conversations/${conv.id}`)}
            />
          ))
        )}
      </div>
    </div>
  )
}

function ConversationItem({
  conversation: conv,
  active,
  onClick,
}: {
  conversation: Conversation
  active:       boolean
  onClick:      () => void
}) {
  const contact   = conv.contact
  const name      = contact?.name || contact?.wa_id || 'Desconhecido'
  const isPending = conv.handled_by === 'pending_human'

  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-start gap-3 px-4 py-3 hover:bg-gray-50 transition-colors text-left border-b border-gray-50 relative',
        active    && 'bg-emerald-50 border-l-[3px] border-l-emerald-500',
        isPending && !active && 'bg-amber-50/60 border-l-[3px] border-l-amber-400'
      )}
    >
      {/* Avatar com indicador de urgência */}
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
      </div>

      {/* Conteúdo */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className={cn(
            'text-sm font-medium truncate',
            isPending ? 'text-amber-900' : 'text-gray-900'
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
        <div className="flex items-center gap-1.5 mt-1">
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
          {conv.handled_by === 'human' && (
            <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 shrink-0">
              Humano
            </span>
          )}
        </div>
      </div>
    </button>
  )
}
