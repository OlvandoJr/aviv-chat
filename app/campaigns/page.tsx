import { createClient } from '@/lib/supabase/server'
import CampaignsClient  from './CampaignsClient'

export const dynamic = 'force-dynamic'

export default async function CampaignsPage() {
  const supabase = await createClient()

  const { data: campaigns } = await supabase
    .from('chat_campaigns')
    .select('id, name, status, total, sent, failed, scheduled_at, created_at, template:chat_wa_templates(name), inbox:chat_inboxes(name), owner:chat_attendants!chat_campaigns_owner_id_fkey(name)')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <CampaignsClient initial={campaigns || []} />
    </div>
  )
}
