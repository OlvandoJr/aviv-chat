import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import ApiWizard from '@/components/apis/ApiWizard'
import type { ApiConfig } from '@/lib/types'

export const dynamic = 'force-dynamic'

export default async function ApiPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  if (id === 'new') {
    return <ApiWizard api={null} />
  }

  const supabase = await createClient()
  const { data: api } = await supabase
    .from('chat_api_configs')
    .select('*')
    .eq('id', id)
    .single()

  if (!api) notFound()

  return <ApiWizard api={api as ApiConfig} />
}
