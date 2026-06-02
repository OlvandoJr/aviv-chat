'use client'

import { useState, useRef, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Send, Paperclip, Mic, Square, X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Props {
  conversationId: string
  disabled?:      boolean
}

export default function MessageInput({ conversationId, disabled }: Props) {
  const supabase     = createClient()
  const textareaRef  = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const mediaRecRef  = useRef<MediaRecorder | null>(null)
  const streamRef    = useRef<MediaStream | null>(null)
  const chunksRef    = useRef<Blob[]>([])
  const timerRef     = useRef<ReturnType<typeof setInterval> | null>(null)

  const [text,       setText]       = useState('')
  const [sending,    setSending]    = useState(false)
  const [file,       setFile]       = useState<File | null>(null)
  const [recording,  setRecording]  = useState(false)
  const [recSeconds, setRecSeconds] = useState(0)
  const [error,      setError]      = useState<string | null>(null)

  // Cleanup ao desmontar
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      streamRef.current?.getTracks().forEach(t => t.stop())
    }
  }, [])

  async function getToken(): Promise<string | null> {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token ?? null
  }

  // ── Envio de texto ────────────────────────────────────────────────────────
  async function handleSendText() {
    const content = text.trim()
    if (!content || sending || disabled) return

    setSending(true)
    setText('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'

    const token = await getToken()
    if (!token) { setSending(false); return }

    try {
      const resp = await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/send-message`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body:    JSON.stringify({ conversationId, text: content }),
        }
      )
      if (!resp.ok) {
        console.error('Erro ao enviar mensagem:', resp.status)
        setText(content)
      }
    } catch (err) {
      console.error('Erro de rede:', err)
      setText(content)
    }

    setSending(false)
    textareaRef.current?.focus()
  }

  // ── Envio de mídia (arquivo ou blob de gravação) ───────────────────────────
  async function handleSendMedia(blob: File | Blob, caption?: string) {
    setSending(true)
    setError(null)
    const token = await getToken()
    if (!token) { setSending(false); return }

    try {
      const fileName = blob instanceof File
        ? blob.name
        : `voice-note-${Date.now()}.${blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : 'webm'}`

      const fd = new FormData()
      fd.append('file', blob, fileName)
      fd.append('conversationId', conversationId)
      if (caption) fd.append('caption', caption)

      const resp = await fetch('/api/send-media', {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}` },
        body:    fd,
      })

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}))
        console.error('Erro ao enviar mídia:', err)
        setError(err?.error || 'Falha ao enviar. Tente novamente.')
      } else {
        setFile(null)
        setText('')
        if (textareaRef.current) textareaRef.current.style.height = 'auto'
      }
    } catch (err) {
      console.error('Erro de rede:', err)
      setError('Falha na conexão. Tente novamente.')
    }

    setSending(false)
  }

  // ── Envio unificado (decide texto vs mídia) ───────────────────────────────
  async function handleSend() {
    if (sending || disabled) return
    if (file) {
      await handleSendMedia(file, text.trim() || undefined)
    } else {
      await handleSendText()
    }
  }

  // ── Gravação de áudio ─────────────────────────────────────────────────────
  async function startRecording() {
    if (disabled || sending) return
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current  = stream
      chunksRef.current  = []

      const mimeType =
        MediaRecorder.isTypeSupported('audio/ogg;codecs=opus') ? 'audio/ogg;codecs=opus' :
        MediaRecorder.isTypeSupported('audio/mp4')             ? 'audio/mp4'             :
                                                                  'audio/webm'

      const rec = new MediaRecorder(stream, { mimeType })
      mediaRecRef.current = rec

      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      rec.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: mimeType })
        stream.getTracks().forEach(t => t.stop())
        streamRef.current   = null
        mediaRecRef.current = null
        if (blob.size > 0) await handleSendMedia(blob)
      }

      rec.start()
      setRecording(true)
      setRecSeconds(0)
      timerRef.current = setInterval(() => setRecSeconds(s => s + 1), 1000)
    } catch {
      setError('Microfone não disponível. Verifique as permissões.')
    }
  }

  function stopRecording() {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    setRecording(false)
    mediaRecRef.current?.stop()
  }

  // ── Helpers da textarea ───────────────────────────────────────────────────
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

  function fmtSeconds(s: number) {
    const m   = Math.floor(s / 60).toString().padStart(2, '0')
    const sec = (s % 60).toString().padStart(2, '0')
    return `${m}:${sec}`
  }

  const hasContent = !!(text.trim() || file)

  // ── Render: conversa encerrada ────────────────────────────────────────────
  if (disabled) {
    return (
      <div className="px-4 py-3 bg-white border-t border-gray-200 shrink-0">
        <p className="text-center text-sm text-gray-400 py-1">
          Conversa encerrada — reabra para enviar mensagens
        </p>
      </div>
    )
  }

  // ── Render: normal ────────────────────────────────────────────────────────
  return (
    <div className="px-4 py-3 bg-white border-t border-gray-200 shrink-0">
      {/* Mensagem de erro */}
      {error && (
        <div className="flex items-center justify-between text-xs text-red-600 bg-red-50 rounded-lg px-3 py-1.5 mb-2">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-2 hover:text-red-800">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Preview de arquivo selecionado */}
      {file && !recording && (
        <div className="flex items-center gap-2 bg-gray-50 rounded-xl px-3 py-2 mb-2 border border-gray-200">
          {file.type.startsWith('image/') ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={URL.createObjectURL(file)}
              alt="Preview"
              className="w-10 h-10 rounded-md object-cover shrink-0"
            />
          ) : (
            <div className="w-10 h-10 rounded-md bg-emerald-100 flex items-center justify-center shrink-0">
              <Paperclip className="w-4 h-4 text-emerald-600" />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-gray-700 truncate">{file.name}</p>
            <p className="text-[11px] text-gray-400">{(file.size / 1024).toFixed(0)} KB</p>
          </div>
          <button
            onClick={() => setFile(null)}
            className="text-gray-400 hover:text-gray-600 transition-colors"
            title="Remover arquivo"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* UI de gravação */}
      {recording ? (
        <div className="flex items-center gap-3 bg-gray-100 rounded-2xl px-3 py-2.5">
          <div className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse shrink-0" />
          <span className="text-sm font-mono text-gray-700 tabular-nums">{fmtSeconds(recSeconds)}</span>
          <span className="text-xs text-gray-400 flex-1">Gravando mensagem de voz...</span>
          <button
            onClick={stopRecording}
            className="w-9 h-9 rounded-full flex items-center justify-center bg-red-500 hover:bg-red-600 text-white transition-colors shrink-0"
            title="Parar e enviar"
          >
            <Square className="w-3.5 h-3.5" />
          </button>
        </div>
      ) : (
        /* UI de texto / arquivo */
        <div className="flex items-end gap-2 bg-gray-100 rounded-2xl px-3 py-2">
          {/* Anexar arquivo */}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="text-gray-400 hover:text-gray-600 transition-colors mb-0.5 shrink-0"
            title="Anexar arquivo"
            disabled={sending}
          >
            <Paperclip className="w-5 h-5" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.zip"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) setFile(f)
              e.target.value = ''   // permite selecionar o mesmo arquivo novamente
            }}
          />

          {/* Textarea */}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            placeholder={file ? 'Legenda (opcional)...' : 'Digite uma mensagem...'}
            rows={1}
            className="flex-1 bg-transparent text-sm text-gray-900 placeholder:text-gray-400 resize-none outline-none leading-5 max-h-28"
          />

          {/* Enviar ou Gravar */}
          {hasContent ? (
            <button
              onClick={handleSend}
              disabled={sending}
              className={cn(
                'w-8 h-8 rounded-full flex items-center justify-center transition-colors shrink-0',
                !sending
                  ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                  : 'bg-gray-300 text-gray-400 cursor-not-allowed'
              )}
              title="Enviar"
            >
              <Send className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={startRecording}
              disabled={sending}
              className="w-8 h-8 rounded-full flex items-center justify-center text-gray-400 hover:text-emerald-600 hover:bg-emerald-50 transition-colors shrink-0"
              title="Gravar mensagem de voz"
            >
              <Mic className="w-4 h-4" />
            </button>
          )}
        </div>
      )}
    </div>
  )
}
