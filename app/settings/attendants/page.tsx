import { createClient } from '@/lib/supabase/server'
import AttendantsClient from './AttendantsClient'

export default async function AttendantsPage() {
  const supabase = await createClient()

  const { data: attendants } = await supabase
    .from('chat_attendants')
    .select('*')
    .order('created_at', { ascending: false })

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Atendentes</h1>
        <p className="text-sm text-gray-500 mt-1">Gerencie os membros da equipe de atendimento.</p>
      </div>
      <AttendantsClient initialAttendants={attendants || []} />
    </div>
  )
}
