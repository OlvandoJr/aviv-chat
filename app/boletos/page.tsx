import { createClient } from '@/lib/supabase/server'
import BoletoUpload      from '@/components/boletos/BoletoUpload'
import LotesList         from '@/components/boletos/LotesList'

export const dynamic = 'force-dynamic'

export default async function BoletosPage() {
  const supabase = await createClient()

  const [{ data: lotes }, { data: { user } }] = await Promise.all([
    supabase
      .from('boleto_lotes')
      .select('id, created_at, uploaded_by_name, filename, lote, recebidos, gravados, com_pdf, sem_telefone, falhas, valor_total')
      .order('created_at', { ascending: false })
      .limit(100),
    supabase.auth.getUser(),
  ])

  // Excluir lote é restrito a admin/manager (a API valida de novo no DELETE)
  let canDelete = false
  if (user) {
    const { data: att } = await supabase.from('chat_attendants').select('role').eq('id', user.id).maybeSingle()
    canDelete = att?.role === 'admin' || att?.role === 'manager'
  }

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Carregar boletos</h1>
        <p className="text-sm text-gray-500 mt-1">
          Arraste o <strong>ZIP do lote de 2ª via</strong>. Cada carregamento vira um <strong>lote</strong> —
          clique para ver os boletos dele.
        </p>
      </div>

      <BoletoUpload />

      <LotesList lotes={lotes || []} canDelete={canDelete} />
    </div>
  )
}
