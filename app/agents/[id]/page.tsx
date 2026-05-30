import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import AgentEditor from '@/components/agents/AgentEditor'

export const dynamic = 'force-dynamic'

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  // Inboxes sempre buscadas (necessário para o seletor de caixas)
  const { data: inboxes } = await supabase
    .from('chat_inboxes')
    .select('*')
    .order('created_at', { ascending: true })

  if (id === 'new') {
    return <AgentEditor agent={null} rules={[]} inboxes={inboxes || []} />
  }

  const [{ data: agent }, { data: rules }] = await Promise.all([
    supabase.from('chat_agents').select('*').eq('id', id).single(),
    supabase.from('chat_agent_rules').select('*').eq('agent_id', id).order('priority'),
  ])

  if (!agent) notFound()

  return <AgentEditor agent={agent} rules={rules || []} inboxes={inboxes || []} />
}
