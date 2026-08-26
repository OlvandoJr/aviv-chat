import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@/lib/supabase/server'
import { usuarioAtual, ehSupervisor } from '@/lib/api/papel'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { resolverAudiencia }         from '@/lib/campaigns/audiencia'

const admin = createAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

/**
 * SUBSTITUI a audiência da campanha (apaga os destinatários e reinsere).
 *
 * Só em rascunho/agendada/pausada — depois de enviar, trocar a audiência apagaria
 * o histórico de quem recebeu. Para acrescentar gente numa campanha já enviada,
 * use POST /api/campaigns/[id]/audience/add, que só INSERE o que falta.
 *
 * Body:
 *  - { mode: 'view', base: 'boletos'|'clientes', filter: {...} }
 *  - { mode: 'manual', rows: [{ wa_id, name?, ...colunas }] }
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
    const eu = await usuarioAtual()
    if (!ehSupervisor(eu?.papel)) {
      return NextResponse.json({ error: 'Apenas administradores e gerentes gerenciam campanhas.' }, { status: 403 })
    }

    const { id } = await ctx.params
    const body = await req.json()
    const { mode = 'view', base = 'boletos', filter = {}, rows = [] } = body

    const { data: camp } = await admin
      .from('chat_campaigns')
      .select('id, status, variable_mapping, deleted_at, incluir_distratados')
      .eq('id', id)
      .single()
    if (!camp || camp.deleted_at) return NextResponse.json({ error: 'Campanha não encontrada' }, { status: 404 })
    if (!['draft', 'scheduled', 'paused'].includes(camp.status)) {
      return NextResponse.json({ error: 'Só é possível editar audiência em rascunho/agendada/pausada' }, { status: 422 })
    }

    const res = await resolverAudiencia(admin, camp, { mode, base, filter, rows })
    if ('erro' in res) return NextResponse.json({ error: res.erro }, { status: 500 })
    const { recipients, removidosDistrato } = res

    await admin.from('chat_campaign_recipients').delete().eq('campaign_id', id)
    for (let i = 0; i < recipients.length; i += 500) {
      const { error } = await admin.from('chat_campaign_recipients')
        .upsert(recipients.slice(i, i + 500), { onConflict: 'campaign_id,wa_id', ignoreDuplicates: true })
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }

    await admin.from('chat_campaigns').update({
      total: recipients.length,
      sent: 0,
      failed: 0,
      audience: { mode, base, filter, ...(mode === 'manual' ? { manualCount: recipients.length } : {}) },
      updated_at: new Date().toISOString(),
    }).eq('id', id)

    return NextResponse.json({ ok: true, total: recipients.length, removidosDistrato })
  } catch (err) {
    console.error('[campaigns audience]', err)
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 })
  }
}
