'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { FileText, Send, Loader2, AlertTriangle, Check } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Props {
  emitidoId:      string
  hasPdf:         boolean
  conversationId: string | null
  windowOpen:     boolean
}

const WINDOW_WARN = 'Janela de 24h fechada — envie o boleto por um template na conversa.'

export default function BoletoActions({ emitidoId, hasPdf, conversationId, windowOpen }: Props) {
  const router = useRouter()
  const [sending, setSending] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(
    conversationId && hasPdf && !windowOpen ? { kind: 'warn', text: WINDOW_WARN } : null
  )

  async function forward(e: React.MouseEvent) {
    e.stopPropagation()
    if (sending || !conversationId) return
    setSending(true); setMsg(null)
    try {
      const resp = await fetch('/api/boletos/forward', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emitido_id: emitidoId, conversationId }),
      })
      const data = await resp.json().catch(() => ({}))
      if (data.windowClosed) {
        setMsg({ kind: 'warn', text: WINDOW_WARN })
      } else if (!resp.ok) {
        setMsg({ kind: 'err', text: data.error || 'Falha ao encaminhar.' })
      } else {
        setMsg({ kind: 'ok', text: 'Boleto enviado na conversa.' })
        router.refresh()
      }
    } catch {
      setMsg({ kind: 'err', text: 'Falha de rede.' })
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        {hasPdf && (
          <a
            href={`/api/boletos/pdf?id=${emitidoId}`}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md border border-gray-200 text-gray-600 hover:bg-gray-100 transition-colors"
          >
            <FileText className="w-3 h-3" /> Abrir PDF
          </a>
        )}
        <button
          onClick={forward}
          disabled={sending || !conversationId || !hasPdf || !windowOpen}
          title={!conversationId ? 'Cliente sem conversa' : !hasPdf ? 'Boleto sem PDF' : !windowOpen ? WINDOW_WARN : 'Encaminhar o PDF na conversa'}
          className={cn(
            'flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md border transition-colors',
            'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 disabled:opacity-50 disabled:cursor-not-allowed',
          )}
        >
          {sending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
          Encaminhar na conversa
        </button>
      </div>
      {msg && (
        <p className={cn(
          'text-[10px] flex items-center gap-1',
          msg.kind === 'ok' ? 'text-emerald-600' : msg.kind === 'warn' ? 'text-amber-600' : 'text-red-600',
        )}>
          {msg.kind === 'ok' ? <Check className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
          {msg.text}
        </p>
      )}
    </div>
  )
}
