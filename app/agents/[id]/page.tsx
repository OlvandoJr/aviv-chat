import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import AgentEditor from '@/components/agents/AgentEditor'

export const dynamic = 'force-dynamic'

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  // Buscar inboxes, modelos e api_connections em paralelo
  const [
    { data: inboxes },
    modelsResult,
    { data: apiConnections },
  ] = await Promise.all([
    supabase.from('chat_inboxes').select('*').order('created_at', { ascending: true }),
    supabase.functions.invoke('list-models').catch(() => ({ data: null, error: null })),
    supabase.from('chat_api_connections').select('*').order('created_at', { ascending: true }),
  ])

  const availableModels: string[] = (modelsResult as any)?.data?.models || []

  if (id === 'new') {
    return (
      <AgentEditor
        agent={null}
        rules={[]}
        inboxes={inboxes || []}
        availableModels={availableModels}
        attrDefs={[]}
        tools={[]}
        apiConnections={apiConnections || []}
        updateDefs={[]}
      />
    )
  }

  const [{ data: agent }, { data: rules }, { data: attrDefs }, { data: tools }, { data: updateDefs }] = await Promise.all([
    supabase.from('chat_agents').select('*').eq('id', id).single(),
    supabase.from('chat_agent_rules').select('*').eq('agent_id', id).order('priority'),
    supabase.from('chat_contact_attribute_defs').select('*').eq('agent_id', id).order('sort_order'),
    supabase
      .from('chat_agent_tools')
      .select('*, api_connection:chat_api_connections(*)')
      .eq('agent_id', id)
      .order('sort_order'),
    supabase
      .from('chat_conversation_update_defs')
      .select('*')
      .eq('agent_id', id)
      .order('sort_order'),
  ])

  if (!agent) notFound()

  return (
    <AgentEditor
      agent={agent}
      rules={rules || []}
      inboxes={inboxes || []}
      availableModels={availableModels}
      attrDefs={attrDefs || []}
      tools={tools || []}
      apiConnections={apiConnections || []}
      updateDefs={updateDefs || []}
    />
  )
}
