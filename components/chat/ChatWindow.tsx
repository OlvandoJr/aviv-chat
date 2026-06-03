'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  Check, CheckCheck, Mic, FileText, Image as ImageIcon,
  ChevronDown, Bell, UserCheck, UserRound,
  Play, Pause, Download, MapPin, Video as VideoIcon,
  AlertTriangle, LayoutTemplate,
} from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { formatTime, formatCurrency, getInitials, cn } from '@/lib/utils'
import MessageInput from './MessageInput'
import ContactPanel from './ContactPanel'
import ConversationActions from './ConversationActions'
import ImageLightbox from './ImageLightbox'
import TemplateSelector from './TemplateSelector'
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
  const [currentAttendantId, setCurrentAttendantId] = useState<string | null>(null)
  const [templateOpen, setTemplateOpen] = useState(false)

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
        async (payload) => {
          // payload.new é a linha bruta (sem joins) — rebuscar com attendant para mostrar o nome correto
          const { data: fullMsg } = await supabase
            .from('chat_messages')
            .select('*, attendant:chat_attendants(id, name)')
            .eq('id', (payload.new as any).id)
            .maybeSingle()
          setMessages((prev) => [...prev, (fullMsg || payload.new) as Message])
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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Filtrar reações (são metadados de outra mensagem, não bolhas separadas)
  const visibleMessages = messages.filter(m => m.type !== 'reaction')

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Modal de seleção de template */}
      {templateOpen && (
        <TemplateSelector
          conversationId={conv.id}
          onClose={() => setTemplateOpen(false)}
        />
      )}
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

        {/* Alerta: aguardando atendente humano */}
        {conv.handled_by === 'pending_human' && (
          <div className="flex items-center gap-3 px-4 py-2.5 bg-amber-50 border-b border-amber-200">
            <Bell className="w-4 h-4 text-amber-600 shrink-0 animate-bounce" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-amber-800">Cliente aguardando atendimento humano</p>
              <p className="text-[11px] text-amber-600 truncate">
                O Agente IA sinalizou que esta conversa precisa de um atendente.
              </p>
            </div>
            <button
              onClick={() => {
                const patch: Record<string, unknown> = { handled_by: 'human' }
                if (currentAttendantId) patch.assignee_id = currentAttendantId
                supabase
                  .from('chat_conversations')
                  .update(patch)
                  .eq('id', conv.id)
                  .select('*, contact:chat_contacts(*), assignee:chat_attendants(id,name,avatar_url)')
                  .single()
                  .then(({ data }) => { if (data) setConv(data as any) })
              }}
              className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-xs font-semibold transition-colors"
            >
              <UserCheck className="w-3.5 h-3.5" />
              Assumir
            </button>
          </div>
        )}

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
          ) : visibleMessages.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-gray-400">Nenhuma mensagem ainda</p>
            </div>
          ) : (
            visibleMessages.map((msg, i) => {
              const prev = visibleMessages[i - 1]
              // Card especial: janela de conversa fechada
              if ((msg.metadata as any)?.system_type === 'window_closed') {
                return (
                  <WindowClosedCard
                    key={msg.id}
                    onOpenTemplate={() => setTemplateOpen(true)}
                  />
                )
              }
              const showSender = msg.direction === 'out'
              return (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  showAvatar={!prev || prev.direction !== msg.direction}
                  showSender={showSender}
                  contactName={name}
                />
              )
            })
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input de envio */}
        <MessageInput
          conversationId={conv.id}
          disabled={conv.status !== 'open'}
          onOpenTemplates={() => setTemplateOpen(true)}
        />
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

// ── MessageBubble ─────────────────────────────────────────────────────────────

function MessageBubble({
  message: msg,
  showAvatar,
  showSender,
  contactName,
}: {
  message:     Message
  showAvatar:  boolean
  showSender:  boolean
  contactName: string
}) {
  const isIn      = msg.direction === 'in'
  const isOut     = msg.direction === 'out'
  const isSticker = msg.type === 'sticker'
  const reactions: { wa_id: string; emoji: string }[] = (msg.metadata?.reactions as any[]) || []

  // ── Remetente para mensagens enviadas ──────────────────────────────────────
  const meta       = msg.metadata as Record<string, any> | null
  const isBotMsg   = meta?.sent_by === 'bot'
  const agentName  = meta?.agent_name  as string | null
  const agentEmoji = meta?.agent_emoji as string | null
  const senderLabel = isBotMsg
    ? (agentName || 'Agente IA')
    : (msg.attendant as any)?.name || 'Atendente'

  return (
    <div className={cn('flex flex-col', isOut && 'items-end')}>
      {/* Nome do remetente — só para mensagens enviadas, apenas na primeira da sequência */}
      {showSender && isOut && (
        <div className={cn('flex items-center gap-1 mb-0.5 mr-1', isBotMsg ? 'text-violet-500' : 'text-emerald-600')}>
          {isBotMsg ? (
            <>
              <span className="text-sm leading-none">{agentEmoji || '🤖'}</span>
              <span className="text-[11px] font-medium">{senderLabel}</span>
              <span className="text-[10px] bg-violet-100 text-violet-600 rounded px-1 py-0 font-semibold">IA</span>
            </>
          ) : (
            <>
              <UserRound className="w-3 h-3" />
              <span className="text-[11px] font-medium">{senderLabel}</span>
            </>
          )}
        </div>
      )}

      <div className={cn('flex items-end gap-2', isOut && 'flex-row-reverse')}>
        {/* Avatar (só lado esquerdo para mensagens recebidas) */}
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
            'max-w-xs md:max-w-md lg:max-w-lg',
            isSticker
              ? 'p-1'   // figurinha: sem fundo
              : cn(
                  'rounded-2xl px-3 py-2 shadow-sm',
                  isIn ? 'bg-white rounded-bl-sm' : 'bg-emerald-600 text-white rounded-br-sm'
                )
          )}
        >
          <MessageContent message={msg} isOut={isOut} />

          {/* Análise de comprovante */}
          {msg.ai_analysis && !isSticker && (
            <AiAnalysisCard analysis={msg.ai_analysis} />
          )}

          {/* Transcrição de áudio */}
          {msg.metadata?.transcription && !isSticker && (
            <p className={cn('text-xs mt-1 italic', isOut ? 'text-emerald-100' : 'text-gray-400')}>
              🎙 {msg.metadata.transcription}
            </p>
          )}

          {/* Footer: hora + status */}
          {!isSticker && (
            <div className={cn('flex items-center justify-end gap-1 mt-1', isIn && 'justify-start')}>
              <span className={cn('text-[10px]', isOut ? 'text-emerald-100' : 'text-gray-400')}>
                {formatTime(msg.created_at)}
              </span>
              {isOut && <MsgStatus status={msg.wa_status} />}
            </div>
          )}
        </div>
      </div>

      {/* Reações de emoji abaixo do balão */}
      {reactions.length > 0 && (
        <div className={cn('flex flex-wrap gap-0.5 mt-0.5', isIn ? 'ml-8' : 'mr-0')}>
          {reactions.map((r, i) => (
            <span
              key={i}
              className="bg-white text-sm rounded-full px-1.5 py-0.5 shadow-sm border border-gray-100 leading-tight"
              title={`Reação de ${r.wa_id}`}
            >
              {r.emoji}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// ── MessageContent ────────────────────────────────────────────────────────────

function MessageContent({ message: msg, isOut }: { message: Message; isOut: boolean }) {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)

  return (
    <>
      {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}

      {msg.type === 'text' || msg.type === 'button' || msg.type === 'template' ? (
        <p className={cn('text-sm whitespace-pre-wrap break-words', isOut ? 'text-white' : 'text-gray-900')}>
          {msg.content}
        </p>

      ) : msg.type === 'image' ? (
        <div>
          {msg.media_url ? (
            <img
              src={msg.media_url}
              alt="Imagem"
              className="rounded-lg max-w-full max-h-64 object-cover cursor-zoom-in"
              onClick={() => setLightboxSrc(msg.media_url!)}
            />
          ) : (
            <div className={cn('flex items-center gap-2 py-1 text-sm', isOut ? 'text-emerald-100' : 'text-gray-400')}>
              <ImageIcon className="w-4 h-4" />
              <span>Imagem</span>
            </div>
          )}
          {msg.content && (
            <p className={cn('text-sm mt-1', isOut ? 'text-white' : 'text-gray-900')}>{msg.content}</p>
          )}
        </div>

      ) : msg.type === 'sticker' ? (
        <div>
          {msg.media_url ? (
            <img
              src={msg.media_url}
              alt="Figurinha"
              className="w-28 h-28 object-contain cursor-zoom-in"
              onClick={() => setLightboxSrc(msg.media_url!)}
            />
          ) : (
            <span className="text-3xl">🖼</span>
          )}
        </div>

      ) : msg.type === 'video' ? (
        <div>
          {msg.media_url ? (
            <video
              src={msg.media_url}
              controls
              className="rounded-lg max-w-full max-h-64"
              preload="metadata"
            />
          ) : (
            <div className={cn('flex items-center gap-2 py-1 text-sm', isOut ? 'text-emerald-100' : 'text-gray-400')}>
              <VideoIcon className="w-4 h-4" />
              <span>Vídeo</span>
            </div>
          )}
          {msg.content && (
            <p className={cn('text-sm mt-1', isOut ? 'text-white' : 'text-gray-900')}>{msg.content}</p>
          )}
        </div>

      ) : msg.type === 'audio' || msg.type === 'voice' ? (
        <div className="flex items-center gap-2 py-1 min-w-[180px]">
          <Mic className="w-3.5 h-3.5 shrink-0 opacity-60" />
          {msg.media_url ? (
            <AudioPlayer src={msg.media_url} isOut={isOut} />
          ) : (
            <span className={cn('text-sm', isOut ? 'text-emerald-100' : 'text-gray-400')}>Áudio</span>
          )}
        </div>

      ) : msg.type === 'document' ? (
        <DocumentCard message={msg} isOut={isOut} />

      ) : msg.type === 'location' ? (
        <LocationCard content={msg.content} isOut={isOut} />

      ) : msg.type === 'contacts' ? (
        <p className={cn('text-sm', isOut ? 'text-white' : 'text-gray-900')}>
          {msg.content || 'Contato'}
        </p>

      ) : (
        <p className={cn('text-xs italic', isOut ? 'text-emerald-100' : 'text-gray-400')}>
          [{msg.type}]
        </p>
      )}
    </>
  )
}

// ── AudioPlayer ───────────────────────────────────────────────────────────────

function AudioPlayer({ src, isOut }: { src: string; isOut: boolean }) {
  const audioRef             = useRef<HTMLAudioElement>(null)
  const [playing,  setPlaying]  = useState(false)
  const [progress, setProgress] = useState(0)
  const [duration, setDuration] = useState(0)
  const [curTime,  setCurTime]  = useState(0)

  const fmt = (s: number) => {
    if (!s || !isFinite(s)) return '0:00'
    const m   = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${sec.toString().padStart(2, '0')}`
  }

  function toggle() {
    const a = audioRef.current
    if (!a) return
    if (playing) a.pause()
    else         a.play().catch(() => {})
    setPlaying(p => !p)
  }

  function seek(e: React.MouseEvent<HTMLDivElement>) {
    const a = audioRef.current
    if (!a || !a.duration) return
    const rect = e.currentTarget.getBoundingClientRect()
    a.currentTime = ((e.clientX - rect.left) / rect.width) * a.duration
  }

  return (
    <div className="flex items-center gap-2 w-48">
      <audio
        ref={audioRef}
        src={src}
        onTimeUpdate={() => {
          const a = audioRef.current!
          setCurTime(a.currentTime)
          setProgress((a.currentTime / (a.duration || 1)) * 100)
        }}
        onLoadedMetadata={() => setDuration(audioRef.current!.duration)}
        onEnded={() => { setPlaying(false); setProgress(0); setCurTime(0) }}
        className="hidden"
        preload="metadata"
      />
      <button
        onClick={toggle}
        className={cn(
          'w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-colors',
          isOut
            ? 'bg-white/20 hover:bg-white/30 text-white'
            : 'bg-emerald-100 hover:bg-emerald-200 text-emerald-700'
        )}
      >
        {playing
          ? <Pause className="w-3.5 h-3.5" />
          : <Play  className="w-3.5 h-3.5 ml-0.5" />
        }
      </button>
      <div className="flex-1 min-w-0">
        <div
          className={cn('h-1.5 rounded-full cursor-pointer mb-1', isOut ? 'bg-white/25' : 'bg-gray-200')}
          onClick={seek}
        >
          <div
            className={cn('h-full rounded-full transition-all', isOut ? 'bg-white' : 'bg-emerald-500')}
            style={{ width: `${progress}%` }}
          />
        </div>
        <span className={cn('text-[10px]', isOut ? 'text-emerald-100' : 'text-gray-400')}>
          {fmt(curTime > 0 ? curTime : duration)}
        </span>
      </div>
    </div>
  )
}

// ── DocumentCard ──────────────────────────────────────────────────────────────

function DocumentCard({ message: msg, isOut }: { message: Message; isOut: boolean }) {
  const ext = msg.media_filename?.split('.').pop()?.toUpperCase() || 'DOC'

  return (
    <div className={cn(
      'flex items-center gap-3 rounded-xl p-2 min-w-[200px]',
      isOut ? 'bg-white/10' : 'bg-gray-50 border border-gray-100'
    )}>
      <div className={cn(
        'w-10 h-10 rounded-lg flex flex-col items-center justify-center shrink-0',
        isOut ? 'bg-white/20' : 'bg-emerald-100'
      )}>
        <FileText className={cn('w-4 h-4', isOut ? 'text-white' : 'text-emerald-600')} />
        <span className={cn('text-[8px] font-bold mt-0.5', isOut ? 'text-white/80' : 'text-emerald-500')}>
          {ext}
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <p className={cn('text-sm font-medium truncate', isOut ? 'text-white' : 'text-gray-900')}>
          {msg.media_filename || 'Documento'}
        </p>
        <p className={cn('text-[11px]', isOut ? 'text-emerald-100' : 'text-gray-400')}>
          {msg.media_mime_type || 'Arquivo'}
        </p>
      </div>
      {msg.media_url && (
        <a
          href={msg.media_url}
          target="_blank"
          rel="noreferrer"
          download={msg.media_filename || true}
          title="Baixar"
          className={cn('shrink-0', isOut ? 'text-white/70 hover:text-white' : 'text-gray-400 hover:text-gray-600')}
        >
          <Download className="w-4 h-4" />
        </a>
      )}
    </div>
  )
}

// ── LocationCard ──────────────────────────────────────────────────────────────

function LocationCard({ content, isOut }: { content: string | null; isOut: boolean }) {
  if (!content) return <p className={cn('text-sm', isOut ? 'text-white' : 'text-gray-900')}>📍 Localização</p>

  const lines   = content.split('\n')
  const mapLink = lines.find(l => l.includes('maps.google.com'))
  const textLines = lines.filter(l => !l.includes('maps.google.com'))

  return (
    <div>
      {textLines.map((line, i) => (
        <p key={i} className={cn('text-sm', isOut ? 'text-white' : 'text-gray-900')}>{line}</p>
      ))}
      {mapLink && (
        <a
          href={mapLink}
          target="_blank"
          rel="noreferrer"
          className={cn(
            'inline-flex items-center gap-1 text-xs mt-1 underline underline-offset-2',
            isOut ? 'text-emerald-100 hover:text-white' : 'text-emerald-600 hover:text-emerald-700'
          )}
        >
          <MapPin className="w-3 h-3" />
          Ver no mapa
        </a>
      )}
    </div>
  )
}

// ── AiAnalysisCard ────────────────────────────────────────────────────────────

function AiAnalysisCard({ analysis }: { analysis: any }) {
  const isSiengePaid = analysis.sienge_status === 'pago'

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
      {analysis.beneficiario   && <AnalysisRow label="Beneficiário" value={analysis.beneficiario} />}
      {analysis.valor          && <AnalysisRow label="Valor"        value={analysis.valor} />}
      {analysis.vencimento     && <AnalysisRow label="Vencimento"   value={analysis.vencimento} />}
      {analysis.data_pagamento && <AnalysisRow label="Pago em"      value={analysis.data_pagamento} />}
      {analysis.pagador        && <AnalysisRow label="Pagador"      value={analysis.pagador} />}
      {analysis.sienge_boleto  && (
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

function MsgStatus({ status }: { status: string }) {
  if (status === 'read')      return <CheckCheck className="w-3 h-3 text-blue-300" />
  if (status === 'delivered') return <CheckCheck className="w-3 h-3 text-emerald-100" />
  if (status === 'failed')    return <span className="text-[10px] text-red-300">!</span>
  return <Check className="w-3 h-3 text-emerald-100" />
}

// ── WindowClosedCard ──────────────────────────────────────────────────────────

function WindowClosedCard({ onOpenTemplate }: { onOpenTemplate: () => void }) {
  return (
    <div className="flex justify-center my-2">
      <div className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 max-w-sm w-full text-center shadow-sm">
        <div className="flex items-center justify-center gap-2 mb-1">
          <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
          <p className="text-xs font-semibold text-amber-800">Janela de conversa encerrada</p>
        </div>
        <p className="text-[11px] text-amber-600 mb-3">
          Passaram-se mais de 24h desde a última mensagem do cliente.<br />
          Somente templates podem ser enviados agora.
        </p>
        <button
          onClick={onOpenTemplate}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-white text-xs font-semibold rounded-lg transition-colors"
        >
          <LayoutTemplate className="w-3.5 h-3.5" />
          Enviar template
        </button>
      </div>
    </div>
  )
}
