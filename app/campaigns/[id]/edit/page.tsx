import { createClient } from '@/lib/supabase/server'
import { notFound }     from 'next/navigation'
import CampaignWizard   from '../../new/CampaignWizard'

export const dynamic = 'force-dynamic'

export default async function EditCampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  const [{ data: campaign }, { data: inboxes }, { data: templates }, { data: attendants }, { data: memberships }, { data: agents }, { data: disparos }] = await Promise.all([
    supabase.from('chat_campaigns')
      .select('id, name, status, inbox_id, template_id, owner_id, variable_mapping, audience, scheduled_at, deleted_at, header_media_path, header_media_filename, header_media_mode, bot_ativo, agent_id, visivel_para')
      .eq('id', id).single(),
    supabase.from('chat_inboxes').select('id, name').eq('is_active', true).order('name'),
    supabase.from('chat_wa_templates')
      .select('id, name, inbox_id, language, status, header_type, header_text, body_text, footer_text, header_var_count, body_var_count')
      .eq('status', 'APPROVED')
      .order('name'),
    supabase.from('chat_attendants').select('id, name, role')
      .eq('is_active', true).is('deleted_at', null).order('name'),
    supabase.from('chat_attendant_inboxes').select('attendant_id, inbox_id'),
    supabase.from('chat_agents').select('id, name, avatar_emoji, is_default')
      .eq('is_active', true).order('name'),
    supabase.from('chat_campaign_disparos')
      .select('id, ordem, scheduled_at, template_id, variable_mapping, status, sent, failed')
      .eq('campaign_id', id).order('scheduled_at'),
  ])

  // Só rascunho/agendada/pausada podem ser editadas (não mexer no que já enviou)
  if (!campaign || campaign.deleted_at || !['draft', 'scheduled', 'paused'].includes(campaign.status)) notFound()

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <CampaignWizard inboxes={inboxes || []} templates={templates || []} campaign={campaign}
        attendants={attendants || []} memberships={memberships || []} agents={agents || []} disparos={disparos || []} />
    </div>
  )
}
