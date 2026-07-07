import { createClient } from '@/lib/supabase/server'
import { notFound }     from 'next/navigation'
import CampaignDetail   from './CampaignDetail'

export const dynamic = 'force-dynamic'

export default async function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  const { data: campaign } = await supabase
    .from('chat_campaigns')
    .select('id, name, status, total, sent, failed, scheduled_at, created_at, template:chat_wa_templates(name), inbox:chat_inboxes(name), deleted_at')
    .eq('id', id)
    .single()

  if (!campaign || campaign.deleted_at) notFound()

  const { data: recipients } = await supabase
    .from('chat_campaign_recipients')
    .select('id, wa_id, name, status, error, sent_at, delivered_at, read_at, replied_at')
    .eq('campaign_id', id)
    .order('created_at', { ascending: true })
    .limit(1000)

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <CampaignDetail campaign={campaign} initialRecipients={recipients || []} />
    </div>
  )
}
