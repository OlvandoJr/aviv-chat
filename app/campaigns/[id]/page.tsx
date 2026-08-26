import { createClient } from '@/lib/supabase/server'
import { notFound }     from 'next/navigation'
import CampaignDetail   from './CampaignDetail'

export const dynamic = 'force-dynamic'

export default async function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const { data: eu } = await supabase.from('chat_attendants').select('role').eq('id', user?.id || '').maybeSingle()
  const supervisor = eu?.role === 'admin' || eu?.role === 'manager'

  const { data: campaign } = await supabase
    .from('chat_campaigns')
    .select('id, name, status, total, sent, failed, scheduled_at, created_at, template:chat_wa_templates(name), inbox:chat_inboxes(name), bot_ativo, agente:chat_agents(name), deleted_at')
    .eq('id', id)
    .single()

  if (!campaign || campaign.deleted_at) notFound()

  const { data: disparos } = await supabase
    .from('chat_campaign_disparos')
    .select('id, ordem, scheduled_at, status, sent, failed, template:chat_wa_templates(name)')
    .eq('campaign_id', id).order('scheduled_at')

  const { data: recipients } = await supabase
    .from('chat_campaign_recipients')
    .select('id, wa_id, name, status, error, sent_at, delivered_at, read_at, replied_at')
    .eq('campaign_id', id)
    .order('created_at', { ascending: true })
    .limit(1000)

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <CampaignDetail supervisor={supervisor} campaign={campaign} initialRecipients={recipients || []} disparos={disparos || []} />
    </div>
  )
}
