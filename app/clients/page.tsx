import { createClient } from '@/lib/supabase/server'
import ClientsClient   from './ClientsClient'

export const dynamic = 'force-dynamic'

export default async function ClientsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const [{ data: clientes }, { data: eu }, { data: inboxes }, { data: vinculos }] = await Promise.all([
    supabase.from('vw_central_clientes').select('*')
      .order('ultima_atividade', { ascending: false, nullsFirst: false }).limit(2000),
    supabase.from('chat_attendants').select('role').eq('id', user?.id || '').maybeSingle(),
    supabase.from('chat_inboxes').select('id, name').eq('is_active', true).order('name'),
    supabase.from('chat_attendant_inboxes').select('inbox_id').eq('attendant_id', user?.id || ''),
  ])

  // Caixas em que este usuário pode abrir conversa (mesma regra do layout de Conversas).
  const supervisor = eu?.role === 'admin' || eu?.role === 'manager'
  const vinculadas = new Set((vinculos || []).map((v) => v.inbox_id))
  const minhasCaixas = supervisor ? (inboxes || []) : (inboxes || []).filter((i) => vinculadas.has(i.id))

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <ClientsClient initial={clientes || []} inboxes={minhasCaixas} />
    </div>
  )
}
