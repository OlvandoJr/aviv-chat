import { createClient } from '@/lib/supabase/server'
import InboxList from '@/components/inboxes/InboxList'

export const dynamic = 'force-dynamic'

export default async function InboxesPage() {
  const supabase = await createClient()

  const { data: inboxes } = await supabase
    .from('chat_inboxes')
    .select('*')
    .order('created_at', { ascending: true })

  return <InboxList inboxes={inboxes || []} />
}
