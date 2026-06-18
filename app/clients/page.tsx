import { createClient } from '@/lib/supabase/server'
import ClientsClient   from './ClientsClient'

export const dynamic = 'force-dynamic'

export default async function ClientsPage() {
  const supabase = await createClient()

  const { data: clientes } = await supabase
    .from('vw_central_clientes')
    .select('*')
    .order('ultima_atividade', { ascending: false, nullsFirst: false })
    .limit(2000)

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <ClientsClient initial={clientes || []} />
    </div>
  )
}
