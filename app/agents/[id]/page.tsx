import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import AgentEditor from '@/components/agents/AgentEditor'

export const dynamic = 'force-dynamic'

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  // Buscar inboxes e modelos disponíveis em paralelo
  const [
    { data: inboxes },
    modelsResult,
  ] = await Promise.all([
    supabase.from('chat_inboxes').select('*').order('created_at', { ascending: true }),
    supabase.functions.invoke('list-models').catch(() => ({ data: null, error: null })),
  ])

  const availableModels: string[] = (modelsResult as any)?.data?.models || []

  if (id === 'new') {
    return <AgentEditor agent={null} rules={[]} inboxes={inboxes || []} availableModels={availableModels} attrDefs={[]} />
  }

  const [{ data: agent }, { data: rules }, { data: attrDefs }] = await Promise.all([
    supabase.from('chat_agents').select('*').eq('id', id).single(),
    supabase.from('chat_agent_rules').select('*').eq('agent_id', id).order('priority'),
    supabase.from('chat_contact_attribute_defs').select('*').eq('agent_id', id).order('sort_order'),
  ])

  if (!agent) notFound()

  return (
    <AgentEditor
      agent={agent}
      rules={rules || []}
      inboxes={inboxes || []}
      availableModels={availableModels}
      attrDefs={attrDefs || []}
    />
  )
}
