import { createClient } from '@/lib/supabase/server'
import TemplatesClient  from './TemplatesClient'
import type { Inbox }   from '@/lib/types'

export const dynamic = 'force-dynamic'

export default async function TemplatesPage() {
  const supabase = await createClient()

  const [{ data: templates }, { data: inboxes }] = await Promise.all([
    supabase
      .from('chat_wa_templates')
      .select('*, inbox:chat_inboxes(id, name, waba_id)')
      .order('created_at', { ascending: false }),
    supabase
      .from('chat_inboxes')
      .select('id, name, waba_id, access_token')
      .eq('is_active', true)
      .order('name'),
  ])

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Templates WhatsApp</h1>
        <p className="text-sm text-gray-500 mt-1">
          Crie e gerencie templates aprovados pela Meta para envio fora da janela de 24h.
        </p>
      </div>
      <TemplatesClient
        initialTemplates={templates || []}
        inboxes={(inboxes || []) as Inbox[]}
      />
    </div>
  )
}
