import { createClient } from '@/lib/supabase/server'
import AttendantsClient from './AttendantsClient'

export default async function AttendantsPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  const { data: me } = await supabase
    .from('chat_attendants')
    .select('role')
    .eq('id', user!.id)
    .single()

  const [{ data: attendants }, { data: inboxes }, { data: memberships }] = await Promise.all([
    supabase
      .from('chat_attendants')
      .select('*')
      .is('deleted_at', null)
      .order('created_at', { ascending: false }),
    supabase.from('chat_inboxes').select('id, name').eq('is_active', true).order('name'),
    supabase.from('chat_attendant_inboxes').select('attendant_id, inbox_id'),
  ])

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Usuários</h1>
        <p className="text-sm text-gray-500 mt-1">Gerencie os membros da equipe.</p>
      </div>
      <AttendantsClient
        initialAttendants={attendants || []}
        currentUserRole={(me?.role as any) || 'agent'}
        currentUserId={user!.id}
        inboxes={inboxes || []}
        memberships={memberships || []}
      />
    </div>
  )
}
