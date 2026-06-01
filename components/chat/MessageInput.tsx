'use client'

import { useState, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Send } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Props {
  conversationId: string
  disabled?:      boolean
}

export default function MessageInput({ conversationId, disabled }: Props) {
  const supabase  = createClient()
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const [text,    setText]    = useState('')
  const [sending, setSending] = useState(false)

  async function handleSend() {
    const content = text.trim()
    if (!content || sending || disabled) return

    setSending(true)
    setText('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'

    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { setSending(false); return }

    try {
      const resp = await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/send-message`,
        {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ conversationId, text: content }),
        }
      )

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}))
        console.error('Erro ao enviar mensagem:', resp.status, err)
        setText(content) // restaura o texto em caso de erro HTTP
      }
    } catch (networkErr) {
      // CORS, timeout ou falha de rede — restaura o texto para o usuário não perder o que digitou
      console.error('Erro de rede ao enviar:', networkErr)
      setText(content)
    }

    setSending(false)
    textareaRef.current?.focus()
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  function handleInput() {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }

  return (
    <div className="px-4 py-3 bg-white border-t border-gray-200 shrink-0">
      {disabled ? (
        <p className="text-center text-sm text-gray-400 py-1">
          Conversa encerrada — reabra para enviar mensagens
        </p>
      ) : (
        <div className="flex items-end gap-2 bg-gray-100 rounded-2xl px-3 py-2">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            placeholder="Digite uma mensagem... (Enter para enviar)"
            rows={1}
            className="flex-1 bg-transparent text-sm text-gray-900 placeholder:text-gray-400 resize-none outline-none leading-5 max-h-28"
          />
          <button
            onClick={handleSend}
            disabled={!text.trim() || sending}
            className={cn(
              'w-8 h-8 rounded-full flex items-center justify-center transition-colors shrink-0',
              text.trim() && !sending
                ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                : 'bg-gray-300 text-gray-400 cursor-not-allowed'
            )}
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  )
}
