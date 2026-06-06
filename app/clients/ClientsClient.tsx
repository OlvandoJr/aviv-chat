'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { UsersRound, Search, MessageSquare, FileText, AlertTriangle, Send } from 'lucide-react'
import { cn, formatCurrency } from '@/lib/utils'

const ORIGEM_BADGE: Record<string, { label: string; cls: string }> = {
  sienge:  { label: 'Sienge', cls: 'bg-blue-100 text-blue-700' },
  sgl:     { label: 'SGL',    cls: 'bg-orange-100 text-orange-700' },
  ambos:   { label: 'Ambos',  cls: 'bg-violet-100 text-violet-700' },
  contato: { label: 'Contato',cls: 'bg-gray-100 text-gray-600' },
}

type Filtro = 'todos' | 'sienge' | 'sgl' | 'ambos' | 'contato' | 'conversa' | 'boleto' | 'vencido' | 'cobrado'

function fmtPhone(p?: string) {
  const d = String(p || '').replace(/\D/g, '')
  if (d.length >= 12) return `+${d.slice(0,2)} (${d.slice(2,4)}) ${d.slice(4,-4)}-${d.slice(-4)}`
  return p || '—'
}
function fmtDate(d?: string | null) {
  return d ? new Date(d).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : '—'
}

export default function ClientsClient({ initial }: { initial: any[] }) {
  const [search, setSearch] = useState('')
  const [filtro, setFiltro] = useState<Filtro>('todos')

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase()
    const sDigits = s.replace(/\D/g, '')
    return initial.filter((c) => {
      if (s) {
        const hitNome = (c.nome || '').toLowerCase().includes(s)
        const hitCpf  = sDigits && (c.cpf || '').includes(sDigits)
        const hitTel  = sDigits && (c.telefone || '').replace(/\D/g, '').includes(sDigits)
        if (!hitNome && !hitCpf && !hitTel) return false
      }
      switch (filtro) {
        case 'sienge':   return c.origem === 'sienge'
        case 'sgl':      return c.origem === 'sgl'
        case 'ambos':    return c.origem === 'ambos'
        case 'contato':  return c.origem === 'contato'
        case 'conversa': return c.conversa_aberta
        case 'boleto':   return c.tem_boleto
        case 'vencido':  return c.boleto_vencido
        case 'cobrado':  return c.ja_cobrado
        default:         return true
      }
    })
  }, [initial, search, filtro])

  const chips: { key: Filtro; label: string }[] = [
    { key: 'todos', label: `Todos (${initial.length})` },
    { key: 'sienge', label: 'Sienge' },
    { key: 'sgl', label: 'SGL' },
    { key: 'ambos', label: 'Ambos' },
    { key: 'conversa', label: 'Conversa aberta' },
    { key: 'boleto', label: 'Com boleto' },
    { key: 'vencido', label: 'Boleto vencido' },
    { key: 'cobrado', label: 'Já cobrado' },
  ]

  return (
    <>
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
          <UsersRound className="w-5 h-5 text-emerald-600" /> Central de Clientes
        </h1>
        <p className="text-sm text-gray-500 mt-1">Visão 360 — boletos, cobrança, conversas e histórico por cliente.</p>
      </div>

      {/* Busca */}
      <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-xl px-3 py-2 mb-3">
        <Search className="w-4 h-4 text-gray-400 shrink-0" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por nome, CPF ou telefone..."
          className="flex-1 bg-transparent text-sm outline-none text-gray-900 placeholder:text-gray-400"
        />
      </div>

      {/* Filtros */}
      <div className="flex flex-wrap gap-1.5 mb-4">
        {chips.map((c) => (
          <button key={c.key} onClick={() => setFiltro(c.key)}
            className={cn('text-xs font-medium px-3 py-1.5 rounded-full transition-colors',
              filtro === c.key ? 'bg-emerald-600 text-white' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50')}>
            {c.label}
          </button>
        ))}
      </div>

      <p className="text-xs text-gray-400 mb-2">{filtered.length} cliente(s)</p>

      {/* Lista */}
      <div className="space-y-1.5">
        {filtered.map((c) => {
          const o = ORIGEM_BADGE[c.origem] || ORIGEM_BADGE.contato
          return (
            <Link key={c.phone_norm} href={`/clients/${c.phone_norm}`}
              className="flex items-center gap-3 bg-white border border-gray-100 rounded-xl px-4 py-3 hover:border-emerald-200 hover:shadow-sm transition-all">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-gray-900 truncate">{c.nome || c.telefone || c.phone_norm}</span>
                  <span className={cn('text-[10px] font-bold px-2 py-0.5 rounded-full uppercase shrink-0', o.cls)}>{o.label}</span>
                  {c.conversa_aberta && <MessageSquare className="w-3.5 h-3.5 text-emerald-500 shrink-0" />}
                  {c.boleto_vencido && <AlertTriangle className="w-3.5 h-3.5 text-red-500 shrink-0" />}
                </div>
                <p className="text-xs text-gray-400 mt-0.5">{fmtPhone(c.telefone)}{c.cpf ? ` · CPF ${c.cpf}` : ''}</p>
              </div>

              <div className="hidden sm:flex flex-col items-end text-right shrink-0 gap-0.5">
                {c.tem_boleto ? (
                  <span className="text-xs text-gray-700 flex items-center gap-1">
                    <FileText className="w-3 h-3 text-gray-400" />
                    vence {fmtDate(c.proximo_venc)}{c.boleto_valor ? ` · ${formatCurrency(Number(c.boleto_valor))}` : ''}
                  </span>
                ) : <span className="text-xs text-gray-300">sem boleto</span>}
                <span className="text-[11px] text-gray-400 flex items-center gap-2">
                  {c.msgs_enviadas > 0 && <span className="flex items-center gap-0.5"><Send className="w-2.5 h-2.5" />{c.msgs_enviadas}</span>}
                  {c.ja_cobrado && <span className="text-emerald-600">cobrado</span>}
                </span>
              </div>
            </Link>
          )
        })}
        {filtered.length === 0 && (
          <div className="text-center py-16 text-gray-400 text-sm">Nenhum cliente encontrado.</div>
        )}
      </div>
    </>
  )
}
