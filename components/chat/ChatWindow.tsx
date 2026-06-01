'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Check, CheckCheck, Mic, FileText, Image as ImageIcon, ChevronDown } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { formatTime, formatCurrency, formatDate, getInitials, cn } from '@/lib/utils'
import MessageInput from './MessageInput'
import ContactPanel from './ContactPanel'
import ConversationActions from './ConversationActions'
import type { Conversation, Message, Attendant, SiengeBoleto, SglBoleto, ContactAttribute } from '@/lib/types'

interface Props {
  conversation:      Conversation
  attendants:        Pick<Attendant, 'id' | 'name' | 'avatar_url'>[]
  siengeBoletos:     Pick<SiengeBoleto, 'id' | 'parcela_descricao' | 'due_date' | 'amount' | 'status'>[]
  sglBoletos:        SglBoleto[]
  contactAttributes: ContactAttribute[]
}

export default function ChatWindow({ conversation, attendants, siengeBoletos, sglBoletos, contactAttributes }: Props) {
  const supabase  = createClient()
  const bottomRef = useRef<HTMLDivElement>(null)

  const [messages,    setMessages]    = useState<Message[]>([])
  const [loading,     setLoading]     = useState(true)
  const [panelOpen,   setPanelOpen]   = useState(false)
  const [conv,        setConv]        = useState(conversation)

  const contact = conv.contact
  const name    = contact?.name || contact?.wa_id || 'Desconhecido'

  const fetchMessages = useCallback(async () => {
    const { data } = await supabase
      .from('chat_messages')
      .select('*, attendant:chat_attendants(id, name)')
      .eq('conversation_id', conv.id)
      .order('created_at', { ascending: true })
      .limit(100)

    setMessages((data as Message[]) || [])
    setLoading(false)
  }, [conv.id])

  useEffect(() => {
    fetchMessages()

    const channel = supabase
      .channel(`chat-${conv.id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `conversation_id=eq.${conv.id}` },
        (payload) => {
          setMessages((prev) => [...prev, payload.new as Message])
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'chat_messages', filter: `conversation_id=eq.${conv.id}` },
        (payload) => {
          setMessages((prev) => prev.map((m) => m.id === payload.new.id ? { ...m, ...payload.new } : m))
        }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [fetchMessages, conv.id])

  // Scroll ao fundo quando chegam mensagens
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Área principal do chat */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-white shrink-0">
          <div className="flex items-center gap-3">
            <Avatar className="w-9 h-9">
              <AvatarImage src={contact?.profile_picture_url || ''} />
              <AvatarFallback>{getInitials(name)}</AvatarFallback>
            </Avatar>
            <div>
              <p className="text-sm font-semibold text-gray-900">{name}</p>
              <p className="text-xs text-gray-400">{contact?.wa_id}</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <ConversationActions
              conversation={conv}
              attendants={attendants}
              onUpdate={setConv}
            />
            <button
              onClick={() => setPanelOpen(!panelOpen)}
              className={cn(
                'p-2 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors',
                panelOpen && 'bg-gray-100 text-gray-600'
              )}
              title="Informações do contato"
            >
              <ChevronDown className={cn('w-4 h-4 transition-transform', panelOpen && 'rotate-180')} />
            </button>
          </div>
        </div>

        {/* Status da conversa */}
        {conv.status !== 'open' && (
          <div className={cn(
            'px-4 py-2 text-xs text-center font-medium',
            conv.status === 'resolved' ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'
          )}>
            {conv.status === 'resolved' ? '✓ Conversa resolvida' : '📦 Conversa arquivada'}
          </div>
        )}

        {/* Mensagens */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-1 bg-[#f0f2f5]">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-gray-400">Carregando mensagens...</p>
            </div>
          ) : messages.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-gray-400">Nenhuma mensagem ainda</p>
            </div>
          ) : (
            messages.map((msg, i) => (
              <MessageBubble
                key={msg.id}
                message={msg}
                showAvatar={i === 0 || messages[i - 1]?.direction !== msg.direction}
                contactName={name}
              />
            ))
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input de envio */}
        <MessageInput conversationId={conv.id} disabled={conv.status !== 'open'} />
      </div>

      {/* Painel lateral de informações */}
      {panelOpen && (
        <ContactPanel
          contact={contact}
          conversation={conv}
          siengeBoletos={siengeBoletos}
          sglBoletos={sglBoletos}
          contactAttributes={contactAttributes}
          onClose={() => setPanelOpen(false)}
        />
      )}
    </div>
  )
}

function MessageBubble({
  message: msg,
  showAvatar,
  contactName,
}: {
  message:     Message
  showAvatar:  boolean
  contactName: string
}) {
  const isIn  = msg.direction === 'in'
  const isOut = msg.direction === 'out'

  return (
    <div className={cn('flex items-end gap-2', isOut && 'flex-row-reverse')}>
      {/* Avatar (só mostra no lado esquerdo para mensagens recebidas) */}
      {isIn && showAvatar ? (
        <Avatar className="w-6 h-6 shrink-0 mb-1">
          <AvatarFallback className="text-[9px]">{getInitials(contactName)}</AvatarFallback>
        </Avatar>
      ) : isIn ? (
        <div className="w-6 shrink-0" />
      ) : null}

      {/* Balão */}
      <div
        className={cn(
          'max-w-xs md:max-w-md lg:max-w-lg rounded-2xl px-3 py-2 shadow-sm',
          isIn
            ? 'bg-white rounded-bl-sm'
            : 'bg-emerald-600 text-white rounded-br-sm'
        )}
      >
        <MessageContent message={msg} isOut={isOut} />

        {/* Análise de comprovante */}
        {msg.ai_analysis && (
          <AiAnalysisCard analysis={msg.ai_analysis} />
        )}

        {/* Transcrição de áudio */}
        {msg.metadata?.transcription && (
          <p className={cn('text-xs mt-1 italic', isOut ? 'text-emerald-100' : 'text-gray-400')}>
            🎙 {msg.metadata.transcription}
          </p>
        )}

        {/* Footer: hora + status */}
        <div className={cn('flex items-center justify-end gap-1 mt-1', isIn && 'justify-start')}>
          <span className={cn('text-[10px]', isOut ? 'text-emerald-100' : 'text-gray-400')}>
            {formatTime(msg.created_at)}
          </span>
          {isOut && <MessageStatus status={msg.wa_status} />}
        </div>
      </div>
    </div>
  )
}

function MessageContent({ message: msg, isOut }: { message: Message; isOut: boolean }) {
  switch (msg.type) {
    case 'text':
    case 'button':
      return (
        <p className={cn('text-sm whitespace-pre-wrap', isOut ? 'text-white' : 'text-gray-900')}>
          {msg.content}
        </p>
      )
    case 'image':
      return (
        <div>
          {msg.media_url ? (
            <img
              src={msg.media_url}
              alt="Imagem"
              className="rounded-lg max-w-full max-h-64 object-cover"
            />
          ) : (
            <div className="flex items-center gap-2 py-1">
              <ImageIcon className="w-4 h-4" />
              <span className="text-sm">Imagem</span>
            </div>
          )}
          {msg.content && (
            <p className={cn('text-sm mt-1', isOut ? 'text-white' : 'text-gray-900')}>{msg.content}</p>
          )}
        </div>
      )
    case 'audio':
      return (
        <div className="flex items-center gap-2 py-1">
          <Mic className="w-4 h-4 shrink-0" />
          {msg.media_url ? (
            <audio controls src={msg.media_url} className="h-8 max-w-[200px]" />
          ) : (
            <span className="text-sm">Áudio</span>
          )}
        </div>
      )
    case 'document':
      return (
        <div className="flex items-center gap-2 py-1">
          <FileText className="w-4 h-4 shrink-0" />
          <div>
            <p className="text-sm font-medium">{msg.media_filename || 'Documento'}</p>
            {msg.media_url && (
              <a
                href={msg.media_url}
                target="_blank"
                rel="noreferrer"
                className={cn('text-xs underline', isOut ? 'text-emerald-100' : 'text-emerald-600')}
              >
                Baixar
              </a>
            )}
          </div>
        </div>
      )
    default:
      return <p className="text-sm text-gray-400 italic">[{msg.type}]</p>
  }
}

function AiAnalysisCard({ analysis }: { analysis: any }) {
  const isSiengePaid    = analysis.sienge_status === 'pago'
  const isSiengePending = analysis.sienge_status === 'pendente'

  return (
    <div className="mt-2 bg-white/90 rounded-lg p-2.5 border border-gray-100 space-y-1.5">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold text-gray-600 uppercase tracking-wide">
          Análise do comprovante
        </p>
        {analysis.sienge_status && (
          <Badge
            variant={isSiengePaid ? 'default' : 'warning'}
            className="text-[9px] px-1.5 py-0 h-4"
          >
            Sienge: {isSiengePaid ? 'Pago' : 'Pendente'}
          </Badge>
        )}
      </div>
      {analysis.beneficiario && (
        <AnalysisRow label="Beneficiário" value={analysis.beneficiario} />
      )}
      {analysis.valor && (
        <AnalysisRow label="Valor" value={analysis.valor} />
      )}
      {analysis.vencimento && (
        <AnalysisRow label="Vencimento" value={analysis.vencimento} />
      )}
      {analysis.data_pagamento && (
        <AnalysisRow label="Pago em" value={analysis.data_pagamento} />
      )}
      {analysis.pagador && (
        <AnalysisRow label="Pagador" value={analysis.pagador} />
      )}
      {analysis.sienge_boleto && (
        <AnalysisRow
          label="Parcela Sienge"
          value={`${analysis.sienge_boleto.parcela} — ${formatCurrency(analysis.sienge_boleto.valor)}`}
        />
      )}
    </div>
  )
}

function AnalysisRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2 text-[11px]">
      <span className="text-gray-400 shrink-0">{label}</span>
      <span className="text-gray-700 text-right truncate">{value}</span>
    </div>
  )
}

function MessageStatus({ status }: { status: string }) {
  if (status === 'read')      return <CheckCheck className="w-3 h-3 text-blue-300" />
  if (status === 'delivered') return <CheckCheck className="w-3 h-3 text-emerald-100" />
  if (status === 'failed')    return <span className="text-[10px] text-red-300">!</span>
  return <Check className="w-3 h-3 text-emerald-100" />
}
