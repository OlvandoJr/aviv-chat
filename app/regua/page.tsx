import { createClient } from '@/lib/supabase/server'
import ReguaClient      from './ReguaClient'

export const dynamic = 'force-dynamic'

export default async function ReguaPage() {
  const supabase = await createClient()

  const [{ data: regras }, { data: inboxes }, { data: templates }] = await Promise.all([
    supabase.from('cobranca_regua')
      .select('*, inbox:chat_inboxes(name), steps:cobranca_regua_step(id, offset_days, send_time, template_id, variable_mapping, sort_order, on_load, template:chat_wa_templates(name))')
      .order('created_at', { ascending: false }),
    supabase.from('chat_inboxes').select('id, name').eq('is_active', true).order('name'),
    supabase.from('chat_wa_templates')
      .select('id, name, inbox_id, header_type, header_text, body_text, footer_text, header_var_count, body_var_count')
      .eq('status', 'APPROVED').order('name'),
  ])

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <ReguaClient
        initial={regras || []}
        inboxes={inboxes || []}
        templates={templates || []}
      />
    </div>
  )
}
