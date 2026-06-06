'use client'

import Link from 'next/link'
import { X, Phone, Calendar, DollarSign, AlertCircle, CheckCircle, Tags, ExternalLink, Building2, ArrowUpRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { cn, formatCurrency, formatDate, getInitials } from '@/lib/utils'
import type { Contact, Conversation, SiengeBoleto, SglBoleto, ContactAttribute } from '@/lib/types'

interface Props {
  contact:           Contact | undefined
  conversation:      Conversation
  siengeBoletos:     Pick<SiengeBoleto, 'id' | 'parcela_descricao' | 'due_date' | 'amount' | 'status'>[]
  sglBoletos:        SglBoleto[]
  contactAttributes: ContactAttribute[]
  central?:          any
  onClose:           () => void
}

const ORIGEM_TAG: Record<string, { label: string; cls: string }> = {
  sienge: { label: 'Sienge',       cls: 'bg-blue-100 text-blue-700' },
  sgl:    { label: 'SGL',          cls: 'bg-orange-100 text-orange-700' },
  ambos:  { label: 'Sienge + SGL', cls: 'bg-violet-100 text-violet-700' },
}

// Dedup SGL por parcela: mantém o registro com status mais avançado / mais recente
const PAGO_ST  = ['pago', 'comprovante_confirmado', 'baixado', 'pago_confirmado', 'quitado']
const COMPR_ST = ['comprovante_recebido', 'comprovante', 'em_validacao']
const sglRank = (s: string | null) => PAGO_ST.includes((s || '').toLowerCase()) ? 3 : COMPR_ST.includes((s || '').toLowerCase()) ? 2 : 1

export default function ContactPanel({ contact, conversation, siengeBoletos, sglBoletos, contactAttributes, central, onClose }: Props) {
  const name   = contact?.name || contact?.wa_id || 'Desconhecido'
  const origem = central?.origem as string | undefined
  const tag    = origem ? ORIGEM_TAG[origem] : undefined

  // Dedup SGL por parcela
  const sglMap: Record<string, any> = {}
  for (const b of sglBoletos) {
    const k = b.contasreceberparcela || String(b.id)
    const prev = sglMap[k]
    if (!prev || sglRank(b.status) > sglRank(prev.status) ||
        (sglRank(b.status) === sglRank(prev.status) && new Date(b.created_at || 0) > new Date(prev.created_at || 0))) sglMap[k] = b
  }
  const sglUnicos = Object.values(sglMap) as SglBoleto[]

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
              <div className="flex items-center justify-center gap-2 flex-wrap">
                <p className="font-semibold text-gray-900">{name}</p>
                {tag && (
                  <span className={cn('text-[10px] font-bold px-1.5 py-0.5 rounded-full uppercase', tag.cls)}>{tag.label}</span>
                )}
              </div>
              <div className="flex items-center justify-center gap-1 mt-0.5">
                <Phone className="w-3 h-3 text-gray-400" />
                <p className="text-xs text-gray-500">{contact?.wa_id}</p>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            {central?.cpf && <InfoRow label="CPF/CNPJ" value={formatAttrValue(String(central.cpf).replace(/\D/g, ''), 'cpf')} />}
            <InfoRow
              label="Primeiro contato"
              value={contact?.created_at ? formatDate(contact.created_at) : '—'}
            />
            {central?.ultima_cobranca && <InfoRow label="Última cobrança" value={formatDate(central.ultima_cobranca)} />}
            {central?.total_cobrancas != null && Number(central.total_cobrancas) > 0 && (
              <InfoRow label="Cobranças enviadas" value={String(central.total_cobrancas)} />
            )}
            {conversation.assignee && (
              <InfoRow label="Atendente" value={conversation.assignee.name} />
            )}
          </div>

          {central?.phone_norm && (
            <Link
              href={`/clients/${central.phone_norm}`}
              className="mt-3 flex items-center justify-center gap-1 text-xs font-medium text-emerald-600 hover:text-emerald-700 border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 rounded-lg py-1.5 transition-colors"
            >
              Ver ficha completa na Central <ArrowUpRight className="w-3.5 h-3.5" />
            </Link>
          )}
        </section>

        {/* Campos Capturados */}
        {contactAttributes.length > 0 && (
          <section>
            <div className="flex items-center gap-1.5 mb-3">
              <Tags className="w-3.5 h-3.5 text-gray-400" />
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                Campos Capturados
              </p>
            </div>
            <div className="space-y-1.5">
              {contactAttributes.map((attr) => (
                <InfoRow
                  key={attr.id}
                  label={attr.attribute_label || attr.attribute_key}
                  value={formatAttrValue(attr.attribute_value, attr.attribute_key)}
                />
              ))}
            </div>
          </section>
        )}

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

        {siengeBoletos.length === 0 && sglUnicos.length === 0 && (
          <section>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Boletos
            </p>
            <p className="text-xs text-gray-400">Nenhum boleto encontrado para este número.</p>
          </section>
        )}

        {/* Boletos SGL (mensagens_cobranca) */}
        {sglUnicos.length > 0 && (
          <section>
            <div className="flex items-center gap-1.5 mb-3">
              <Building2 className="w-3.5 h-3.5 text-orange-400" />
              <p className="text-xs font-semibold text-orange-600 uppercase tracking-wide">
                Boletos SGL
              </p>
              <span className="text-[10px] px-1.5 py-0.5 bg-orange-50 text-orange-500 border border-orange-200 rounded-full ml-auto">
                Migrando para Sienge
              </span>
            </div>
            <div className="space-y-2">
              {sglUnicos.map((boleto) => (
                <SglBoletoCard key={boleto.id} boleto={boleto} />
              ))}
            </div>
          </section>
        )}
      </div>
    </aside>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2 text-xs">
      <span className="text-gray-400 shrink-0">{label}</span>
      <span className="text-gray-700 font-medium text-right">{value}</span>
    </div>
  )
}

function SglBoletoCard({ boleto }: { boleto: SglBoleto }) {
  const amount  = parseSglAmount(boleto.contasrecebervalor)
  const dueDate = boleto.contasrecebervencimento
    ? new Date(boleto.contasrecebervencimento).toLocaleDateString('pt-BR')
    : '—'
  const isOverdue = boleto.contasrecebervencimento
    ? new Date(boleto.contasrecebervencimento) < new Date()
    : false

  const statusLabel =
    boleto.status === 'pago'               ? { text: 'Pago',          color: 'default' as const } :
    boleto.status === 'comprovante_recebido' ? { text: 'Comprovante',   color: 'info' as const    } :
    isOverdue                               ? { text: 'Vencido',       color: 'destructive' as const } :
                                              { text: 'Em aberto',     color: 'warning' as const }

  const parcela = [
    boleto.contasreceberparcela,
    [boleto.unidadequadraandar, boleto.unidadeloteapartamento].filter(Boolean).join(' / '),
  ].filter(Boolean).join(' — ')

  return (
    <div className="rounded-xl border border-orange-100 p-3 bg-orange-50/50 space-y-2">
      {/* Empreendimento */}
      {boleto.unidadeempreendimento && (
        <p className="text-[10px] font-medium text-orange-700 uppercase tracking-wide truncate">
          {boleto.unidadeempreendimento}
        </p>
      )}

      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-gray-800 leading-tight">
          {parcela || 'Parcela'}
        </p>
        <Badge variant={statusLabel.color} className="text-[9px] px-1.5 h-4 shrink-0">
          {statusLabel.text}
        </Badge>
      </div>

      <div className="flex justify-between text-xs">
        <div className="flex items-center gap-1 text-gray-500">
          <Calendar className="w-3 h-3" />
          <span>{dueDate}</span>
        </div>
        {amount > 0 && (
          <div className="flex items-center gap-1 font-semibold text-gray-800">
            <DollarSign className="w-3 h-3 text-gray-400" />
            <span>{formatCurrency(amount)}</span>
          </div>
        )}
      </div>

      {boleto.linkboleto && (
        <a
          href={boleto.linkboleto}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 text-[11px] text-orange-600 hover:text-orange-800 hover:underline font-medium"
        >
          <ExternalLink className="w-3 h-3" />
          Ver / baixar boleto
        </a>
      )}
    </div>
  )
}

function parseSglAmount(value: string | null): number {
  if (!value) return 0
  return parseFloat(value.replace(/\./g, '').replace(',', '.')) || 0
}

function formatAttrValue(value: string, key: string): string {
  // Format CPF: 00000000000 → 000.000.000-00
  if (/cpf/i.test(key) && /^\d{11}$/.test(value)) {
    return value.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')
  }
  // Format CNPJ: 00000000000000 → 00.000.000/0001-00
  if (/cnpj|cpf/i.test(key) && /^\d{14}$/.test(value)) {
    return value.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5')
  }
  // Format phone: 5511999999999 → +55 (11) 99999-9999
  if (/phone|tel|fone/i.test(key) && /^\d{10,13}$/.test(value)) {
    const d = value.replace(/\D/g, '')
    if (d.length === 13) return `+${d.slice(0,2)} (${d.slice(2,4)}) ${d.slice(4,9)}-${d.slice(9)}`
    if (d.length === 11) return `(${d.slice(0,2)}) ${d.slice(2,7)}-${d.slice(7)}`
  }
  return value
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
