import { createClient } from '@/lib/supabase/server'
import { redirect }     from 'next/navigation'
import Sidebar          from '@/components/conversations/Sidebar'

export default async function CampaignsLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: attendant } = await supabase
    .from('chat_attendants')
    .select('id, name, email, role, avatar_url, is_active, created_at')
    .eq('id', user.id)
    .single()

  // Admin/gerente entram sempre. Atendente entra só se houver ao menos uma campanha
  // liberada para ele — a RLS (migration 080) é quem filtra, então basta perguntar.
  const supervisor = attendant?.role === 'admin' || attendant?.role === 'manager'
  if (!supervisor) {
    const { data: liberadas } = await supabase
      .from('chat_campaigns').select('id').is('deleted_at', null).limit(1)
    if (!liberadas?.length) redirect('/conversations')
  }

  return (
    <div className="flex h-screen overflow-hidden bg-white">
      <Sidebar attendant={attendant} />
      <main className="flex-1 overflow-auto bg-gray-50">
        {children}
      </main>
    </div>
  )
}
