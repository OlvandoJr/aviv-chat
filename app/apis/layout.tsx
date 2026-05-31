import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'

export default async function ApisLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: attendant } = await supabase
    .from('chat_attendants')
    .select('role')
    .eq('user_id', user.id)
    .single()

  if (attendant?.role !== 'admin') redirect('/conversations')

  return <>{children}</>
}
