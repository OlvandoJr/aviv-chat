import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import AgentEditor from '@/components/agents/AgentEditor'

export const dynamic = 'force-dynamic'

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  if (id === 'new') {
    return <AgentEditor agent={null} rules={[]} />
  }

  const [{ data: agent }, { data: rules }] = await Promise.all([
    supabase.from('chat_agents').select('*').eq('id', id).single(),
    supabase.from('chat_agent_rules').select('*').eq('agent_id', id).order('priority'),
  ])

  if (!agent) notFound()

  return <AgentEditor agent={agent} rules={rules || []} />
}
