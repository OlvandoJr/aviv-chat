import { createClient } from '@/lib/supabase/server'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import Sidebar from '@/components/conversations/Sidebar'
import ConversationList, { INBOX_COOKIE } from '@/components/conversations/ConversationList'

export default async function ConversationsLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const [{ data: attendant }, { data: inboxes }, { data: vinculos }] = await Promise.all([
    supabase
      .from('chat_attendants')
      .select('id, name, email, role, avatar_url, is_active, created_at')
      .eq('id', user.id)
      .single(),
    supabase.from('chat_inboxes').select('id, name').eq('is_active', true).order('name'),
    supabase.from('chat_attendant_inboxes').select('inbox_id').eq('attendant_id', user.id),
  ])

  // Caixas que ESTE usuário atende. Admin/gerente veem todas (mesma regra da RLS,
  // migration 060); agente vê só as vinculadas. O recorte tem de ser aqui: a RLS de
  // chat_inboxes é USING(true), então listar a tabela crua exporia caixas alheias.
  const supervisor = attendant?.role === 'admin' || attendant?.role === 'manager'
  const vinculadas = new Set((vinculos || []).map((v) => v.inbox_id))
  const minhasCaixas = supervisor
    ? (inboxes || [])
    : (inboxes || []).filter((i) => vinculadas.has(i.id))

  // Caixa lembrada da última visita. Vem em cookie (e não em localStorage) para o
  // servidor já renderizar a lista certa: sem "pisca" de Todas→caixa e sem 2ª busca.
  // Validada contra as caixas atuais — o vínculo pode ter sido revogado.
  const salva = (await cookies()).get(INBOX_COOKIE)?.value
  const caixaInicial = salva && minhasCaixas.some((i) => i.id === salva) ? salva : null

  return (
    <div className="flex h-screen overflow-hidden bg-white">
      <Sidebar attendant={attendant} />
      <main className="flex-1 flex overflow-hidden">
        <ConversationList inboxes={minhasCaixas} initialInboxId={caixaInicial} />
        {children}
      </main>
    </div>
  )
}
