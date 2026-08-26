import { createClient } from '@/lib/supabase/server'

/**
 * Papel do usuário logado, para as rotas de API.
 *
 * As telas de campanha já eram fechadas a admin/gerente pelo layout, mas as rotas
 * conferiam apenas se HAVIA sessão — qualquer atendente logado que conhecesse o
 * endereço podia criar ou disparar campanha por fora da interface. Este helper é
 * a checagem que faltava (o padrão já existia em /api/campaigns/media).
 */
export type Papel = 'admin' | 'manager' | 'agent'

export async function usuarioAtual(): Promise<{ id: string; papel: Papel } | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data } = await supabase
    .from('chat_attendants').select('role').eq('id', user.id).maybeSingle()
  if (!data?.role) return null
  return { id: user.id, papel: data.role as Papel }
}

export const ehSupervisor = (p: Papel | undefined | null) => p === 'admin' || p === 'manager'
