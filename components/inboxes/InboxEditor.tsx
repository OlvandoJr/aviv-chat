'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { ArrowLeft, Save, Trash2, Eye, EyeOff, Inbox as InboxIcon, Copy, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Inbox } from '@/lib/types'

interface Props {
  inbox: Inbox | null
}

export default function InboxEditor({ inbox }: Props) {
  const router  = useRouter()
  const supabase = createClient()
  const isNew   = !inbox

  const [name,          setName]          = useState(inbox?.name || '')
  const [description,   setDescription]   = useState(inbox?.description || '')
  const [phoneNumber,   setPhoneNumber]   = useState(inbox?.phone_number || '')
  const [phoneNumberId, setPhoneNumberId] = useState(inbox?.phone_number_id || '')
  const [wabaId,        setWabaId]        = useState(inbox?.waba_id || '')
  const [accessToken,   setAccessToken]   = useState(inbox?.access_token || '')
  const [verifyToken,   setVerifyToken]   = useState(inbox?.verify_token || '')
  const [isActive,      setIsActive]      = useState(inbox?.is_active ?? true)

  const [showToken,  setShowToken]  = useState(false)
  const [copied,     setCopied]     = useState(false)
  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState('')
  const [saved,      setSaved]      = useState(false)

  const webhookUrl = typeof window !== 'undefined'
    ? `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/whatsapp-webhook`
    : ''

  async function copyWebhookUrl() {
    await navigator.clipboard.writeText(webhookUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  async function handleSave() {
    if (!name.trim())          { setError('Nome é obrigatório'); return }
    if (!phoneNumberId.trim()) { setError('Phone Number ID é obrigatório'); return }
    if (!accessToken.trim())   { setError('Access Token é obrigatório'); return }
    if (!verifyToken.trim())   { setError('Verify Token é obrigatório'); return }

    setLoading(true)
    setError('')

    const data = {
      name:            name.trim(),
      description:     description.trim() || null,
      phone_number:    phoneNumber.trim().replace(/\D/g, ''),
      phone_number_id: phoneNumberId.trim(),
      waba_id:         wabaId.trim() || null,
      access_token:    accessToken.trim(),
      verify_token:    verifyToken.trim(),
      is_active:       isActive,
    }

    if (isNew) {
      const { error: err } = await supabase.from('chat_inboxes').insert(data)
      if (err) { setError('Erro ao criar: ' + err.message); setLoading(false); return }
    } else {
      const { error: err } = await supabase.from('chat_inboxes').update(data).eq('id', inbox.id)
      if (err) { setError('Erro ao salvar: ' + err.message); setLoading(false); return }
    }

    setLoading(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)

    if (isNew) router.push('/inboxes')
    else router.refresh()
  }

  async function handleDelete() {
    if (!inbox) return
    if (!confirm('Excluir esta caixa de entrada? Esta ação não pode ser desfeita.')) return
    await supabase.from('chat_inboxes').delete().eq('id', inbox.id)
    router.push('/inboxes')
  }

  return (
    <div className="max-w-2xl mx-auto p-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push('/inboxes')}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-500 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div>
            <h1 className="text-xl font-bold text-gray-900">
              {isNew ? 'Nova Caixa de Entrada' : name || 'Editar Caixa'}
            </h1>
            <p className="text-xs text-gray-400 mt-0.5">
              {isNew ? 'Conecte um número de WhatsApp' : 'Configurações do canal WhatsApp'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {!isNew && (
            <button
              onClick={handleDelete}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg text-red-600 hover:bg-red-50 border border-red-200 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Excluir
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={loading}
            className={cn(
              'flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg font-medium transition-colors',
              saved
                ? 'bg-emerald-100 text-emerald-700 border border-emerald-200'
                : 'bg-emerald-600 text-white hover:bg-emerald-700'
            )}
          >
            <Save className="w-3.5 h-3.5" />
            {loading ? 'Salvando...' : saved ? 'Salvo ✓' : 'Salvar'}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="space-y-5">

        {/* ── IDENTIFICAÇÃO ── */}
        <Section icon={<InboxIcon className="w-4 h-4" />} title="Identificação">
          <div className="space-y-3">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Nome *</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ex: Cobrança Aviv, Suporte Técnico..."
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Descrição</label>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Breve descrição do propósito desta caixa"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-3 cursor-pointer">
                <div
                  onClick={() => setIsActive(!isActive)}
                  className={cn(
                    'relative w-9 h-5 rounded-full transition-colors cursor-pointer',
                    isActive ? 'bg-emerald-500' : 'bg-gray-300'
                  )}
                >
                  <span className={cn(
                    'absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform',
                    isActive ? 'translate-x-4' : 'translate-x-0'
                  )} />
                </div>
                <span className="text-sm text-gray-700 font-medium">Caixa ativa</span>
              </label>
            </div>
          </div>
        </Section>

        {/* ── NÚMERO ── */}
        <Section icon={<span className="text-sm">📱</span>} title="Número WhatsApp">
          <div className="space-y-3">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Número de telefone</label>
              <input
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                placeholder="554391318822 (com DDI, sem + ou espaços)"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
              <p className="text-[11px] text-gray-400 mt-1">
                Apenas para referência visual. Ex: 554391318822
              </p>
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Phone Number ID *</label>
              <input
                value={phoneNumberId}
                onChange={(e) => setPhoneNumberId(e.target.value)}
                placeholder="Ex: 761871190338757"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
              <p className="text-[11px] text-gray-400 mt-1">
                Encontrado no Meta Business Manager → WhatsApp → Configurações → Perfil do telefone → Identificação
              </p>
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">WABA ID <span className="text-gray-400">(necessário para templates)</span></label>
              <input
                value={wabaId}
                onChange={(e) => setWabaId(e.target.value)}
                placeholder="Ex: 4023700297885912"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
              <p className="text-[11px] text-gray-400 mt-1">
                Meta Business Suite → Contas do WhatsApp → clique na conta → Identificação
              </p>
            </div>
          </div>
        </Section>

        {/* ── CREDENCIAIS ── */}
        <Section icon={<span className="text-sm">🔑</span>} title="Credenciais da API">
          <div className="space-y-3">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Access Token *</label>
              <div className="relative">
                <input
                  type={showToken ? 'text' : 'password'}
                  value={accessToken}
                  onChange={(e) => setAccessToken(e.target.value)}
                  placeholder="EAAZCm..."
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 pr-10 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
                <button
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-[11px] text-gray-400 mt-1">
                Token de acesso do Meta Business (System User Token ou token temporário)
              </p>
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Verify Token *</label>
              <input
                value={verifyToken}
                onChange={(e) => setVerifyToken(e.target.value)}
                placeholder="Ex: aviv-webhook-2025"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
              <p className="text-[11px] text-gray-400 mt-1">
                Token de verificação que você define — deve ser igual ao configurado no Meta Business Webhook
              </p>
            </div>
          </div>
        </Section>

        {/* ── WEBHOOK ── */}
        <Section icon={<span className="text-sm">🔗</span>} title="URL do Webhook">
          <p className="text-xs text-gray-500 mb-2">
            Configure esta URL no Meta Business Manager → WhatsApp → Configurar Webhooks:
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-700 font-mono break-all">
              {`[SUPABASE_URL]/functions/v1/whatsapp-webhook`}
            </code>
            <button
              onClick={copyWebhookUrl}
              className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg bg-gray-100 hover:bg-gray-200 transition-colors shrink-0"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? 'Copiado!' : 'Copiar'}
            </button>
          </div>
          <div className="mt-3 p-3 bg-blue-50 border border-blue-100 rounded-lg">
            <p className="text-xs text-blue-700">
              <strong>Campos subscritos:</strong> messages, message_deliveries, message_reads
            </p>
          </div>
        </Section>

      </div>

      {/* Footer */}
      <div className="mt-8 flex justify-end">
        <button
          onClick={handleSave}
          disabled={loading}
          className={cn(
            'flex items-center gap-2 px-6 py-2.5 rounded-lg font-medium text-sm transition-colors',
            saved
              ? 'bg-emerald-100 text-emerald-700 border border-emerald-200'
              : 'bg-emerald-600 text-white hover:bg-emerald-700'
          )}
        >
          <Save className="w-4 h-4" />
          {loading ? 'Salvando...' : saved ? 'Salvo com sucesso ✓' : 'Salvar Caixa de Entrada'}
        </button>
      </div>
    </div>
  )
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-3 border-b border-gray-100 bg-gray-50">
        <span className="text-gray-500">{icon}</span>
        <h2 className="text-sm font-semibold text-gray-700">{title}</h2>
      </div>
      <div className="p-5 space-y-3">
        {children}
      </div>
    </div>
  )
}
