'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { ChevronRight, Loader2, FileText, User, Calendar, Layers, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Lote {
  id: string
  created_at: string
  uploaded_by_name: string | null
  filename: string | null
  lote: string | null
  recebidos: number
  gravados: number
  com_pdf: number
  sem_telefone: number
  falhas: number
  valor_total: number | null
}

interface Boleto {
  id: string
  customer_name: string | null
  client_id: number
  vencimento: string | null
  valor: number | null
  telefone: string | null
  pdf_path: string | null
  status: string | null
}

function fmtBRL(v: number | null | undefined) {
  if (v == null) return '—'
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v)
}
function fmtDate(d: string | null) {
  return d ? new Date(d).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : '—'
}
function fmtDateTime(d: string | null) {
  return d ? new Date(d).toLocaleString('pt-BR') : '—'
}

export default function LotesList({ lotes, canDelete = false }: { lotes: Lote[]; canDelete?: boolean }) {
  if (lotes.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-sm text-gray-400">
        Nenhum lote carregado ainda.
      </div>
    )
  }
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100">
        <h2 className="text-sm font-medium text-gray-700">Lotes carregados</h2>
      </div>
      <div className="divide-y divide-gray-100">
        {lotes.map((l) => <LoteRow key={l.id} lote={l} canDelete={canDelete} />)}
      </div>
    </div>
  )
}

function LoteRow({ lote, canDelete }: { lote: Lote; canDelete: boolean }) {
  const supabase = createClient()
  const router = useRouter()
  const [open, setOpen]         = useState(false)
  const [loading, setLoading]   = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [boletos, setBoletos] = useState<Boleto[] | null>(null)

  async function excluirLote(ev: React.MouseEvent) {
    ev.stopPropagation()
    if (!confirm(
      `Excluir o lote de ${fmtDateTime(lote.created_at)}?\n\n` +
      `Isso apaga ${lote.gravados} boleto(s) (${fmtBRL(lote.valor_total)}) e os PDFs deste lote. ` +
      `Recarregar o ZIP recria tudo.`
    )) return
    setDeleting(true)
    const r = await fetch(`/api/boletos/lotes/${lote.id}`, { method: 'DELETE' })
    const j = await r.json().catch(() => ({}))
    setDeleting(false)
    if (!r.ok) { alert(j.error || 'Falha ao excluir o lote.'); return }
    router.refresh()
  }

  async function toggle() {
    const next = !open
    setOpen(next)
    if (next && boletos === null) {
      setLoading(true)
      const { data } = await supabase
        .from('boletos_emitidos')
        .select('id, customer_name, client_id, vencimento, valor, telefone, pdf_path, status')
        .eq('upload_id', lote.id)
        .order('vencimento', { ascending: true })
      setBoletos((data as Boleto[]) || [])
      setLoading(false)
    }
  }

  return (
    <div>
      {/* Cabeçalho do lote */}
      <div className="flex items-center hover:bg-gray-50 transition-colors">
        <button onClick={toggle} className="flex-1 min-w-0 flex items-center gap-3 px-4 py-3 text-left">
          <ChevronRight className={cn('w-4 h-4 text-gray-400 shrink-0 transition-transform', open && 'rotate-90')} />
          <div className="flex-1 min-w-0 grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1">
            <span className="flex items-center gap-1.5 text-sm text-gray-800 font-medium">
              <Calendar className="w-3.5 h-3.5 text-gray-400" /> {fmtDateTime(lote.created_at)}
            </span>
            <span className="flex items-center gap-1.5 text-xs text-gray-500 truncate">
              <User className="w-3.5 h-3.5 text-gray-400" /> {lote.uploaded_by_name || '—'}
            </span>
            <span className="flex items-center gap-1.5 text-xs text-gray-500 truncate">
              <Layers className="w-3.5 h-3.5 text-gray-400" /> Remessa {lote.lote || '—'}
            </span>
            <span className="text-xs text-gray-500">
              <strong>{lote.gravados}</strong> boletos · {lote.com_pdf} c/ PDF · {fmtBRL(lote.valor_total)}
            </span>
          </div>
          {lote.falhas > 0 && (
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 shrink-0">
              {lote.falhas} falha(s)
            </span>
          )}
        </button>
        {canDelete && (
          <button onClick={excluirLote} disabled={deleting} title="Excluir lote (apaga os boletos e PDFs)"
            className="px-4 py-3 text-gray-300 hover:text-red-500 disabled:opacity-50 shrink-0">
            {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
          </button>
        )}
      </div>

      {/* Boletos do lote */}
      {open && (
        <div className="bg-gray-50/60 px-4 pb-3">
          {loading ? (
            <div className="flex items-center gap-2 py-4 text-sm text-gray-400">
              <Loader2 className="w-4 h-4 animate-spin" /> Carregando boletos…
            </div>
          ) : !boletos || boletos.length === 0 ? (
            <p className="py-4 text-sm text-gray-400">Nenhum boleto neste lote.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-gray-400">
                  <tr>
                    <th className="text-left font-medium px-2 py-1.5">Cliente</th>
                    <th className="text-left font-medium px-2 py-1.5">Vencimento</th>
                    <th className="text-right font-medium px-2 py-1.5">Valor</th>
                    <th className="text-left font-medium px-2 py-1.5">Telefone</th>
                    <th className="text-center font-medium px-2 py-1.5">PDF</th>
                  </tr>
                </thead>
                <tbody>
                  {boletos.map((b) => (
                    <tr key={b.id} className="border-t border-gray-100">
                      <td className="px-2 py-1.5 text-gray-800">{b.customer_name || <span className="text-gray-400">#{b.client_id}</span>}</td>
                      <td className="px-2 py-1.5 text-gray-600">{fmtDate(b.vencimento)}</td>
                      <td className="px-2 py-1.5 text-right text-gray-800">{fmtBRL(b.valor)}</td>
                      <td className="px-2 py-1.5 text-gray-600">{b.telefone || <span className="text-amber-500">—</span>}</td>
                      <td className="px-2 py-1.5 text-center">{b.pdf_path ? '✅' : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
