'use client'

import Link from 'next/link'
import { X, Phone, Tags, ArrowUpRight } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { cn, formatCurrency, formatDate, getInitials } from '@/lib/utils'
import ConfirmPaymentButton from '@/components/clients/ConfirmPaymentButton'
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

  // Lista unificada compacta (Sienge + SGL), ordenada por vencimento desc
  const boletoRows = [
    ...siengeBoletos.map((b) => ({ key: 's' + b.id, id: b.id, source: 'sienge' as const, parcela: b.parcela_descricao || 'Parcela', due: b.due_date, amount: Number(b.amount) || 0, status: b.status, src: 'Sienge' })),
    ...sglUnicos.map((b) => ({ key: 'g' + b.id, id: b.id, source: 'sgl' as const, parcela: b.contasreceberparcela || 'Parcela', due: b.contasrecebervencimento, amount: parseSglAmount(b.contasrecebervalor), status: b.status, src: 'SGL' })),
  ].sort((a, b) => new Date(b.due || 0).getTime() - new Date(a.due || 0).getTime())

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

        {/* Boletos — lista compacta (máx. 3) + expandir p/ a Central */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Boletos{boletoRows.length > 0 ? ` (${boletoRows.length})` : ''}
            </p>
          </div>

          {boletoRows.length === 0 ? (
            <p className="text-xs text-gray-400">Nenhum boleto para este número.</p>
          ) : (
            <div className="rounded-lg border border-gray-100 overflow-hidden">
              {boletoRows.slice(0, 3).map((r) => {
                const e = estadoBoleto(r.status, r.due)
                return (
                  <div key={r.key} className="flex items-center gap-2 px-2.5 py-1.5 border-b border-gray-50 last:border-0">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-gray-800 truncate">{r.parcela}</p>
                      <p className="text-[10px] text-gray-400">{r.src} · {r.due ? formatDate(r.due) : '—'}</p>
                    </div>
                    {r.amount > 0 && <span className="text-xs font-semibold text-gray-700 shrink-0">{formatCurrency(r.amount)}</span>}
                    <span className={cn('text-[9px] font-bold px-1.5 py-0.5 rounded-full shrink-0', e.cls)}>{e.label}</span>
                    {e.label !== 'Pago' && <ConfirmPaymentButton source={r.source} id={r.id} variant="icon" />}
                  </div>
                )
              })}
            </div>
          )}

          {central?.phone_norm && (
            <Link
              href={`/clients/${central.phone_norm}`}
              className="mt-2 flex items-center justify-center gap-1 text-xs font-medium text-emerald-600 hover:text-emerald-700 border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 rounded-lg py-1.5 transition-colors"
            >
              {boletoRows.length > 3 ? `Ver todos (${boletoRows.length}) na Central` : 'Ver ficha completa na Central'}
              <ArrowUpRight className="w-3.5 h-3.5" />
            </Link>
          )}
        </section>
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

// Estado de pagamento compacto: Pago (verde) · Comprovante (amarelo) · Vencido · Em aberto
function estadoBoleto(status: string | null, due: string | null) {
  const s = (status || '').toLowerCase()
  if (PAGO_ST.includes(s))  return { label: 'Pago',        cls: 'bg-emerald-100 text-emerald-700' }
  if (COMPR_ST.includes(s)) return { label: 'Comprovante', cls: 'bg-amber-100 text-amber-700' }
  const hoje = new Date().toISOString().slice(0, 10)
  if (due && String(due).slice(0, 10) < hoje) return { label: 'Vencido', cls: 'bg-red-100 text-red-600' }
  return { label: 'Em aberto', cls: 'bg-gray-100 text-gray-500' }
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

