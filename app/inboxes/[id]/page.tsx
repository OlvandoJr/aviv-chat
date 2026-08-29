import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import InboxEditor from '@/components/inboxes/InboxEditor'
import NovaCaixaWizard from '@/components/inboxes/NovaCaixaWizard'

export const dynamic = 'force-dynamic'

export default async function InboxPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  if (id === 'new') {
    // Seleção em duas etapas (método → canal); o formulário manual clássico vive
    // dentro do wizard, no caminho Manual + WhatsApp Oficial.
    return <NovaCaixaWizard />
  }

  const { data: inbox } = await supabase
    .from('chat_inboxes')
    .select('*')
    .eq('id', id)
    .single()

  if (!inbox) notFound()

  return <InboxEditor inbox={inbox} />
}
