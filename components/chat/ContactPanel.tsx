'use client'

import { X, Phone, Calendar, DollarSign, AlertCircle, CheckCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { formatCurrency, formatDate, getInitials } from '@/lib/utils'
import type { Contact, Conversation, SiengeBoleto } from '@/lib/types'

interface Props {
  contact:       Contact | undefined
  conversation:  Conversation
  siengeBoletos: Pick<SiengeBoleto, 'id' | 'parcela_descricao' | 'due_date' | 'amount' | 'status'>[]
  onClose:       () => void
}

export default function ContactPanel({ contact, conversation, siengeBoletos, onClose }: Props) {
  const name = contact?.name || contact?.wa_id || 'Desconhecido'

  return (
    <aside className="w-72 border-l border-gray-200 bg-white flex flex-col overflow-hidden shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <p className="text-sm font-semibold text-gray-700">Informações</p>
        <button
          onClick={onClose}
          className="p-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Contato */}
        <section>
          <div className="flex flex-col items-center text-center gap-2 mb-4">
            <Avatar className="w-14 h-14">
              <AvatarImage src={contact?.profile_picture_url || ''} />
              <AvatarFallback className="text-lg">{getInitials(name)}</AvatarFallback>
            </Avatar>
            <div>
              <p className="font-semibold text-gray-900">{name}</p>
              <div className="flex items-center justify-center gap-1 mt-0.5">
                <Phone className="w-3 h-3 text-gray-400" />
                <p className="text-xs text-gray-500">{contact?.wa_id}</p>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <InfoRow label="WhatsApp ID" value={contact?.wa_id || '—'} />
            <InfoRow
              label="Primeiro contato"
              value={contact?.created_at ? formatDate(contact.created_at) : '—'}
            />
            {conversation.assignee && (
              <InfoRow label="Atendente" value={conversation.assignee.name} />
            )}
          </div>
        </section>

        {/* Boletos Sienge */}
        {siengeBoletos.length > 0 && (
          <section>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
              Boletos Sienge
            </p>
            <div className="space-y-2">
              {siengeBoletos.map((boleto) => (
                <BoletoCard key={boleto.id} boleto={boleto} />
              ))}
            </div>
          </section>
        )}

        {siengeBoletos.length === 0 && (
          <section>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Boletos Sienge
            </p>
            <p className="text-xs text-gray-400">Nenhum boleto encontrado para este número.</p>
          </section>
        )}
      </div>
    </aside>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2 text-xs">
      <span className="text-gray-400">{label}</span>
      <span className="text-gray-700 font-medium text-right">{value}</span>
    </div>
  )
}

function BoletoCard({
  boleto,
}: {
  boleto: Pick<SiengeBoleto, 'id' | 'parcela_descricao' | 'due_date' | 'amount' | 'status'>
}) {
  const isPaid     = boleto.status === 'pago'
  const isOverdue  = !isPaid && new Date(boleto.due_date) < new Date()
  const hasComp    = boleto.status === 'comprovante_recebido'

  return (
    <div className="rounded-xl border border-gray-100 p-3 bg-gray-50 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-gray-800 leading-tight">
          {boleto.parcela_descricao || 'Parcela'}
        </p>
        <StatusBadge status={boleto.status} isOverdue={isOverdue} />
      </div>

      <div className="flex justify-between text-xs">
        <div className="flex items-center gap-1 text-gray-500">
          <Calendar className="w-3 h-3" />
          <span>{formatDate(boleto.due_date)}</span>
        </div>
        <div className="flex items-center gap-1 font-semibold text-gray-800">
          <DollarSign className="w-3 h-3 text-gray-400" />
          <span>{formatCurrency(boleto.amount)}</span>
        </div>
      </div>
    </div>
  )
}

function StatusBadge({
  status,
  isOverdue,
}: {
  status:    string
  isOverdue: boolean
}) {
  if (status === 'pago')
    return <Badge variant="default" className="text-[9px] px-1.5 h-4"><CheckCircle className="w-2.5 h-2.5 mr-0.5" />Pago</Badge>
  if (status === 'comprovante_recebido')
    return <Badge variant="info" className="text-[9px] px-1.5 h-4">Comprovante</Badge>
  if (isOverdue)
    return <Badge variant="destructive" className="text-[9px] px-1.5 h-4"><AlertCircle className="w-2.5 h-2.5 mr-0.5" />Vencido</Badge>
  return <Badge variant="warning" className="text-[9px] px-1.5 h-4">Em aberto</Badge>
}
