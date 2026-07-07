'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { CheckCircle, ArchiveIcon, RotateCcw, UserCheck, ChevronDown, Bot, UserRound } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Conversation, Attendant, HandledBy } from '@/lib/types'

interface Props {
  conversation: Conversation
  attendants:   Pick<Attendant, 'id' | 'name' | 'avatar_url'>[]
  onUpdate:     (conv: Conversation) => void
}

export default function ConversationActions({ conversation, attendants, onUpdate }: Props) {
  const supabase   = createClient()
  const router     = useRouter()
  const assignRef  = useRef<HTMLDivElement>(null)

  const [loading,         setLoading]         = useState(false)
  const [showAssign,      setShowAssign]       = useState(false)
  const [currentAttendantId, setCurrentAttendantId] = useState<string | null>(null)

  // Descobrir o attendant_id do usuário logado
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session?.user?.id) return
      supabase
        .from('chat_attendants')
        .select('id')
        .eq('id', session.user.id)
        .maybeSingle()
        .then(({ data }) => { if (data) setCurrentAttendantId(data.id) })
    })
  }, [])

  // Fechar dropdown ao clicar fora
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (assignRef.current && !assignRef.current.contains(e.target as Node))
        setShowAssign(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  async function updateStatus(status: 'open' | 'resolved' | 'archived') {
    setLoading(true)
    // Ao resolver/arquivar, a conversa fica LIMPA: sai de atendimento humano e
    // volta para a IA, e encerra os marcadores (validação de comprovante /
    // "aguarda atendente" some junto do handled_by='bot').
    const patch: Record<string, unknown> = { status }
    if (status !== 'open') {
      patch.receipt_validation = false
      patch.handled_by = 'bot'
    }
    const { data } = await supabase
      .from('chat_conversations')
      .update(patch)
      .eq('id', conversation.id)
      .select('*, contact:chat_contacts(*), assignee:chat_attendants(id,name,avatar_url)')
      .single()

    if (data) onUpdate(data as any)
    setLoading(false)
    router.refresh()
  }

  async function assignTo(attendantId: string | null) {
    setShowAssign(false)
    const { data } = await supabase
      .from('chat_conversations')
      .update({ assignee_id: attendantId })
      .eq('id', conversation.id)
      .select('*, contact:chat_contacts(*), assignee:chat_attendants(id,name,avatar_url)')
      .single()

    if (data) onUpdate(data as any)
    router.refresh()
  }

  async function updateHandledBy(handledBy: HandledBy) {
    setLoading(true)
    const patch: Record<string, unknown> = { handled_by: handledBy }
    // Ao assumir como humano, atribuir automaticamente ao atendente logado e
    // encerrar a pendência de validação de comprovante (o atendente está cuidando).
    if (handledBy === 'human') {
      patch.receipt_validation = false
      if (currentAttendantId) patch.assignee_id = currentAttendantId
    }
    const { data } = await supabase
      .from('chat_conversations')
      .update(patch)
      .eq('id', conversation.id)
      .select('*, contact:chat_contacts(*), assignee:chat_attendants(id,name,avatar_url)')
      .single()

    if (data) onUpdate(data as any)
    setLoading(false)
    router.refresh()
  }

  const { status, handled_by } = conversation

  return (
    <div className="flex items-center gap-1.5 relative">
      {/* Bot / Humano */}
      {handled_by === 'human' ? (
        <button
          onClick={() => updateHandledBy('bot')}
          disabled={loading}
          className="flex items-center gap-1 px-2 py-1.5 text-xs rounded-lg bg-violet-50 text-violet-700 hover:bg-violet-100 transition-colors border border-violet-200"
          title="Devolver para o bot"
        >
          <Bot className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Devolver ao Bot</span>
        </button>
      ) : (
        <button
          onClick={() => updateHandledBy('human')}
          disabled={loading}
          className={cn(
            'flex items-center gap-1 px-2 py-1.5 text-xs rounded-lg transition-colors border',
            handled_by === 'pending_human'
              ? 'bg-amber-50 text-amber-700 border-amber-300 animate-pulse'
              : 'bg-gray-50 text-gray-600 hover:bg-gray-100 border-gray-200'
          )}
          title={handled_by === 'pending_human' ? 'Cliente aguardando atendente — clique para assumir' : 'Assumir atendimento'}
        >
          <UserRound className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">
            {handled_by === 'pending_human' ? 'Assumir (urgente)' : 'Assumir'}
          </span>
        </button>
      )}

      {/* Atribuir */}
      <div className="relative" ref={assignRef}>
        <button
          onClick={() => setShowAssign(!showAssign)}
          className={cn(
            'flex items-center gap-1 px-2 py-1.5 text-xs rounded-lg border transition-colors',
            conversation.assignee
              ? 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
              : 'border-gray-200 hover:bg-gray-50 text-gray-600'
          )}
          title={conversation.assignee ? `Atribuído a ${conversation.assignee.name} — clique para reatribuir` : 'Atribuir atendente'}
        >
          <UserCheck className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">
            {conversation.assignee?.name || 'Atribuir'}
          </span>
          <ChevronDown className="w-3 h-3" />
        </button>

        {showAssign && (
          <div className="absolute right-0 top-full mt-1 w-48 bg-white border border-gray-200 rounded-xl shadow-lg z-50 overflow-hidden">
            <button
              onClick={() => assignTo(null)}
              className="w-full px-3 py-2 text-xs text-left hover:bg-gray-50 text-gray-500"
            >
              Sem atribuição
            </button>
            {attendants.map((a) => (
              <button
                key={a.id}
                onClick={() => assignTo(a.id)}
                className={cn(
                  'w-full px-3 py-2 text-xs text-left hover:bg-gray-50 text-gray-700',
                  conversation.assignee_id === a.id && 'bg-emerald-50 text-emerald-700 font-medium'
                )}
              >
                {a.name}
                {conversation.assignee_id === a.id && (
                  <span className="ml-1 text-[10px]">✓</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Resolver / Reabrir */}
      {status === 'open' ? (
        <button
          onClick={() => updateStatus('resolved')}
          disabled={loading}
          className="flex items-center gap-1 px-2 py-1.5 text-xs rounded-lg bg-green-50 text-green-700 hover:bg-green-100 transition-colors border border-green-200"
          title="Marcar como resolvida"
        >
          <CheckCircle className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Resolver</span>
        </button>
      ) : (
        <button
          onClick={() => updateStatus('open')}
          disabled={loading}
          className="flex items-center gap-1 px-2 py-1.5 text-xs rounded-lg bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors border border-blue-200"
          title="Reabrir conversa"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Reabrir</span>
        </button>
      )}

      {/* Arquivar */}
      {status !== 'archived' && (
        <button
          onClick={() => updateStatus('archived')}
          disabled={loading}
          className="flex items-center gap-1 px-2 py-1.5 text-xs rounded-lg text-gray-500 hover:bg-gray-100 transition-colors border border-gray-200"
          title="Arquivar"
        >
          <ArchiveIcon className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  )
}
