import { createClient } from '@/lib/supabase/server'
import ApiList from '@/components/apis/ApiList'
import type { ApiConfig } from '@/lib/types'

export const dynamic = 'force-dynamic'

export default async function ApisPage() {
  const supabase = await createClient()
  const { data: apis } = await supabase
    .from('chat_api_configs')
    .select('*')
    .order('created_at', { ascending: false })

  return <ApiList apis={(apis || []) as ApiConfig[]} />
}
