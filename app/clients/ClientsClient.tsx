'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { UsersRound, Search } from 'lucide-react'
import { cn } from '@/lib/utils'

type Filtro = 'todos' | 'sienge' | 'sgl' | 'ambos' | 'conversa' | 'vencido' | 'pago' | 'cancelado'

function fmtPhone(p?: string) {
  const d = String(p || '').replace(/\D/g, '')
  if (d.length >= 12) return `+${d.slice(0, 2)} (${d.slice(2, 4)}) ${d.slice(4, -4)}-${d.slice(-4)}`
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`
  return p || '—'
}

// ── Status do contrato ────────────────────────────────────────────────────────
function contratoBadge(s: string | null) {
  switch (s) {
    case 'Emitido':    return { label: 'Ativo',      cls: 'bg-emerald-100 text-emerald-700' }
    case 'Cancelado':  return { label: 'Cancelado',  cls: 'bg-red-100 text-red-700' }
    case 'Autorizado': return { label: 'Autorizado', cls: 'bg-blue-100 text-blue-700' }
    case 'Solicitado': return { label: 'Solicitado', cls: 'bg-amber-100 text-amber-700' }
    case null: case undefined: return null
    default:           return { label: s as string, cls: 'bg-gray-100 text-gray-600' }
  }
}

// ── Status do boleto mensal ───────────────────────────────────────────────────
const BOLETO_BADGE: Record<string, { label: string; cls: string }> = {
  pago:       { label: 'Pago',       cls: 'bg-emerald-100 text-emerald-700' },
  vencido:    { label: 'Vencido',    cls: 'bg-red-100 text-red-700' },
  enviado:    { label: 'Enviado',    cls: 'bg-blue-100 text-blue-700' },
  a_enviar:   { label: 'A enviar',   cls: 'bg-amber-100 text-amber-700' },
  sem_boleto: { label: 'Sem boleto', cls: 'bg-gray-100 text-gray-500' },
}

// ── Status da conversa ────────────────────────────────────────────────────────
function conversaInfo(c: any): { label: string; cls: string } {
  if (c.conversa_aberta) return { label: 'Aberta', cls: 'bg-emerald-100 text-emerald-700' }
  if (Number(c.conversas) > 0) return { label: 'Resolvida', cls: 'bg-gray-100 text-gray-600' }
  return { label: 'Sem conversa', cls: 'bg-gray-50 text-gray-400' }
}

function Badge({ label, cls }: { label: string; cls: string }) {
  return <span className={cn('inline-block text-[11px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap', cls)}>{label}</span>
}

export default function ClientsClient({ initial }: { initial: any[] }) {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [filtro, setFiltro] = useState<Filtro>('todos')

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase()
    const sDigits = s.replace(/\D/g, '')
    return initial.filter((c) => {
      if (s) {
        const hitNome  = (c.nome || '').toLowerCase().includes(s)
        const hitEmail = (c.email || '').toLowerCase().includes(s)
        const hitCpf   = sDigits && (c.cpf || '').includes(sDigits)
        const hitTel   = sDigits && (c.telefone || '').replace(/\D/g, '').includes(sDigits)
        if (!hitNome && !hitEmail && !hitCpf && !hitTel) return false
      }
      switch (filtro) {
        case 'sienge':    return c.origem === 'sienge'
        case 'sgl':       return c.origem === 'sgl'
        case 'ambos':     return c.origem === 'ambos'
        case 'conversa':  return c.conversa_aberta
        case 'vencido':   return c.boleto_status === 'vencido'
        case 'pago':      return c.boleto_status === 'pago'
        case 'cancelado': return c.contrato_situacao === 'Cancelado'
        default:          return true
      }
    })
  }, [initial, search, filtro])

  const chips: { key: Filtro; label: string }[] = [
    { key: 'todos', label: `Todos (${initial.length})` },
    { key: 'sienge', label: 'Sienge' },
    { key: 'sgl', label: 'SGL' },
    { key: 'ambos', label: 'Ambos' },
    { key: 'conversa', label: 'Conversa aberta' },
    { key: 'vencido', label: 'Boleto vencido' },
    { key: 'pago', label: 'Boleto pago' },
    { key: 'cancelado', label: 'Contrato cancelado' },
  ]

  return (
    <>
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
          <UsersRound className="w-5 h-5 text-emerald-600" /> Central de Clientes
        </h1>
        <p className="text-sm text-gray-500 mt-1">Visão 360 — contrato, plataforma, boletos e conversas por cliente.</p>
      </div>

      {/* Busca */}
      <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-xl px-3 py-2 mb-3">
        <Search className="w-4 h-4 text-gray-400 shrink-0" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por nome, e-mail, CPF ou telefone..."
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

      {/* Tabela */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[920px]">
            <thead>
              <tr className="bg-gray-50 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                <th className="px-4 py-2.5">Nome</th>
                <th className="px-4 py-2.5">Telefone</th>
                <th className="px-4 py-2.5">E-mail</th>
                <th className="px-4 py-2.5">Contrato</th>
                <th className="px-4 py-2.5">Plataforma</th>
                <th className="px-4 py-2.5">Boleto mensal</th>
                <th className="px-4 py-2.5">Conversa</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((c) => {
                const ct = contratoBadge(c.contrato_situacao)
                const bo = BOLETO_BADGE[c.boleto_status] || BOLETO_BADGE.sem_boleto
                const cv = conversaInfo(c)
                return (
                  <tr key={c.phone_norm}
                    onClick={() => router.push(`/clients/${c.phone_norm}`)}
                    className="hover:bg-emerald-50/40 cursor-pointer transition-colors">
                    <td className="px-4 py-3">
                      <span className="font-medium text-gray-900 block truncate max-w-[220px]">{c.nome || c.telefone || c.phone_norm}</span>
                      {c.cpf && <span className="text-[11px] text-gray-400">CPF {c.cpf}</span>}
                    </td>
                    <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{fmtPhone(c.telefone)}</td>
                    <td className="px-4 py-3 text-gray-600 truncate max-w-[200px]">{c.email || <span className="text-gray-300">—</span>}</td>
                    <td className="px-4 py-3">{ct ? <Badge {...ct} /> : <span className="text-gray-300">—</span>}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {c.is_sienge && <Badge label="Sienge" cls="bg-blue-100 text-blue-700" />}
                        {c.is_sgl && <Badge label="SGL" cls="bg-orange-100 text-orange-700" />}
                        {!c.is_sienge && !c.is_sgl && <span className="text-gray-300">—</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3"><Badge {...bo} /></td>
                    <td className="px-4 py-3"><Badge {...cv} /></td>
                  </tr>
                )
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={7} className="text-center py-16 text-gray-400 text-sm">Nenhum cliente encontrado.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
