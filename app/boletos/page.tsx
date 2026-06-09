import { createClient } from '@/lib/supabase/server'
import BoletoUpload      from '@/components/boletos/BoletoUpload'

export const dynamic = 'force-dynamic'

function fmtBRL(v: number | null) {
  if (v == null) return '—'
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v)
}
function fmtDate(d: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('pt-BR', { timeZone: 'UTC' })
}

export default async function BoletosPage() {
  const supabase = await createClient()

  const { data: recentes } = await supabase
    .from('boletos_emitidos')
    .select('id, client_id, customer_name, vencimento, valor, telefone, pdf_path, lote, status, created_at')
    .order('created_at', { ascending: false })
    .limit(50)

  const total = recentes?.length || 0
  const comPdf = (recentes || []).filter((b) => b.pdf_path).length

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Carregar boletos</h1>
        <p className="text-sm text-gray-500 mt-1">
          Arraste o <strong>ZIP do lote de 2ª via</strong> (o mesmo que o financeiro gera). O sistema
          extrai os dados, sobe os PDFs e atualiza a base — sem Google Drive.
        </p>
      </div>

      <BoletoUpload />

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-sm font-medium text-gray-700">Últimos boletos importados</h2>
          <span className="text-xs text-gray-400">{comPdf}/{total} com PDF</span>
        </div>
        {total === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-gray-400">Nenhum boleto importado ainda.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-gray-400 bg-gray-50">
                <tr>
                  <th className="text-left font-medium px-4 py-2">Cliente</th>
                  <th className="text-left font-medium px-4 py-2">Vencimento</th>
                  <th className="text-right font-medium px-4 py-2">Valor</th>
                  <th className="text-left font-medium px-4 py-2">Telefone</th>
                  <th className="text-center font-medium px-4 py-2">PDF</th>
                  <th className="text-left font-medium px-4 py-2">Lote</th>
                </tr>
              </thead>
              <tbody>
                {(recentes || []).map((b) => (
                  <tr key={b.id} className="border-t border-gray-50">
                    <td className="px-4 py-2 text-gray-800">
                      {b.customer_name || <span className="text-gray-400">#{b.client_id}</span>}
                    </td>
                    <td className="px-4 py-2 text-gray-600">{fmtDate(b.vencimento)}</td>
                    <td className="px-4 py-2 text-right text-gray-800">{fmtBRL(b.valor)}</td>
                    <td className="px-4 py-2 text-gray-600">
                      {b.telefone || <span className="text-amber-500">sem telefone</span>}
                    </td>
                    <td className="px-4 py-2 text-center">{b.pdf_path ? '✅' : '—'}</td>
                    <td className="px-4 py-2 text-gray-400 text-xs">{b.lote || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
