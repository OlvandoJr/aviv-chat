import { createClient } from '@/lib/supabase/server'
import AgentList from '@/components/agents/AgentList'

export const dynamic = 'force-dynamic'

export default async function AgentsPage() {
  const supabase = await createClient()

  const { data: agents } = await supabase
    .from('chat_agents')
    .select('*')
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: true })

  return <AgentList agents={agents || []} />
}
