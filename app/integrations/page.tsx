import { createClient } from '@/lib/supabase/server'
import IntegrationsClient from './IntegrationsClient'

export const dynamic = 'force-dynamic'

export default async function IntegrationsPage() {
  const supabase = await createClient()

  const { data: connections } = await supabase
    .from('chat_api_connections')
    .select('*')
    .order('created_at', { ascending: true })

  return <IntegrationsClient initialConnections={connections || []} />
}
