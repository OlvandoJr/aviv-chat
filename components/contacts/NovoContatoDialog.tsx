'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { X, Loader2, MessageSquarePlus } from 'lucide-react'
import { mascaraTelefone, telefoneValido } from '@/lib/whatsapp/telefone'

/**
 * Criar contato + conversa. Usado na lista de Conversas e na Central de Clientes —
 * um diálogo só, para as duas telas não divergirem.
 */
export default function NovoContatoDialog({ inboxes, onClose }: {
  inboxes: { id: string; name: string }[]
  onClose: () => void
}) {
  const router = useRouter()
  const supabase = createClient()

  const [telefone, setTelefone] = useState('')
  const [nome, setNome]         = useState('')
  const [inboxId, setInboxId]   = useState(inboxes[0]?.id || '')
  const [busy, setBusy]         = useState(false)
  const [erro, setErro]         = useState<string | null>(null)

  const podeSalvar = telefoneValido(telefone) && !!inboxId && !busy

  async function salvar() {
    setBusy(true); setErro(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const r = await fetch('/api/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ telefone, nome, inboxId }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || 'Falha ao criar o contato.')
      onClose()
      router.push(`/conversations/${j.conversationId}`)
      router.refresh()
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
            <MessageSquarePlus className="w-4 h-4 text-emerald-600" /> Novo contato
          </h2>
          <button onClick={onClose} disabled={busy} className="text-gray-400 hover:text-gray-600">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-gray-600 mb-1 block">Telefone (com DDD) *</label>
            <input
              value={telefone}
              onChange={(e) => setTelefone(mascaraTelefone(e.target.value))}
              placeholder="(43) 99999-9999"
              autoFocus
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
            {telefone.length > 0 && !telefoneValido(telefone) && (
              <p className="text-[11px] text-amber-600 mt-1">Informe DDD + número.</p>
            )}
          </div>

          <div>
            <label className="text-xs font-medium text-gray-600 mb-1 block">Nome</label>
            <input
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder="Como o cliente será exibido"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>

          {inboxes.length > 1 && (
            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">Caixa de entrada</label>
              <select value={inboxId} onChange={(e) => setInboxId(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white">
                {inboxes.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
            </div>
          )}

          <p className="text-[11px] text-gray-400 leading-relaxed">
            O WhatsApp só permite iniciar uma conversa com um template aprovado — a conversa
            abre com o campo de digitação bloqueado até o cliente responder. Se o telefone já
            for de um cliente do Sienge, a ficha dele aparece na Central automaticamente.
          </p>

          {erro && <p className="text-xs text-red-600">{erro}</p>}
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} disabled={busy}
            className="text-sm px-3 py-2 rounded-lg text-gray-600 hover:bg-gray-100">Cancelar</button>
          <button onClick={salvar} disabled={!podeSalvar}
            className="text-sm px-3 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 flex items-center gap-1.5">
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Criar e abrir conversa
          </button>
        </div>
      </div>
    </div>
  )
}
