import { createClient } from '@/lib/supabase/server'
import CampaignWizard   from './CampaignWizard'

export const dynamic = 'force-dynamic'

export default async function NewCampaignPage() {
  const supabase = await createClient()

  const [{ data: inboxes }, { data: templates }] = await Promise.all([
    supabase.from('chat_inboxes').select('id, name').eq('is_active', true).order('name'),
    supabase.from('chat_wa_templates')
      .select('id, name, inbox_id, language, status, header_type, header_text, body_text, footer_text, header_var_count, body_var_count')
      .eq('status', 'APPROVED')
      .order('name'),
  ])

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <CampaignWizard inboxes={inboxes || []} templates={templates || []} />
    </div>
  )
}
