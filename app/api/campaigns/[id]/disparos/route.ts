import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@/lib/supabase/server'
import { usuarioAtual, ehSupervisor } from '@/lib/api/papel'
import { createClient as createAdminClient } from '@supabase/supabase-js'

const admin = createAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

/**
 * Disparos ADICIONAIS da campanha (chat_campaign_disparos) — modelo da régua:
 * cada disparo tem data/hora, template e mapeamento próprios.
 *
 * PUT substitui a lista, mas **preserva o que já saiu**: disparo com status
 * 'running'/'done' não é apagado nem reescrito. Sem isso, editar a campanha
 * apagaria o histórico de envio e o log de quem recebeu junto (cascade).
 *
 * Body: { disparos: [{ id?, scheduledAt, templateId, mapping }] }
 */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
    const eu = await usuarioAtual()
    if (!ehSupervisor(eu?.papel)) {
      return NextResponse.json({ error: 'Apenas administradores e gerentes gerenciam campanhas.' }, { status: 403 })
    }

    const { id } = await ctx.params
    const { disparos = [] } = await req.json()

    const { data: camp } = await admin
      .from('chat_campaigns').select('id, deleted_at').eq('id', id).maybeSingle()
    if (!camp || camp.deleted_at) return NextResponse.json({ error: 'Campanha não encontrada' }, { status: 404 })

    const { data: atuais } = await admin.from('chat_campaign_disparos')
      .select('id, status').eq('campaign_id', id)
    const intocaveis = new Set((atuais || []).filter(d => d.status !== 'scheduled').map(d => d.id))

    // Apaga só os agendados que sumiram da lista (os já disparados ficam).
    const mantidos = new Set(disparos.map((d: any) => d.id).filter(Boolean))
    const remover = (atuais || [])
      .filter(d => d.status === 'scheduled' && !mantidos.has(d.id))
      .map(d => d.id)
    if (remover.length) {
      await admin.from('chat_campaign_disparos').delete().in('id', remover)
    }

    let ordem = 0
    for (const d of disparos) {
      ordem++
      if (!d.scheduledAt || !d.templateId) {
        return NextResponse.json({ error: `Disparo ${ordem}: informe data/hora e template.` }, { status: 400 })
      }
      if (d.id && intocaveis.has(d.id)) continue      // já enviado: não mexe

      const linha = {
        campaign_id: id,
        ordem,
        scheduled_at: new Date(d.scheduledAt).toISOString(),
        template_id: d.templateId,
        variable_mapping: d.mapping || {},
        updated_at: new Date().toISOString(),
      }
      if (d.id) {
        await admin.from('chat_campaign_disparos').update(linha).eq('id', d.id)
      } else {
        await admin.from('chat_campaign_disparos').insert(linha)
      }
    }

    const { data: final } = await admin.from('chat_campaign_disparos')
      .select('id, ordem, scheduled_at, template_id, variable_mapping, status, sent, failed')
      .eq('campaign_id', id).order('scheduled_at')

    return NextResponse.json({ ok: true, disparos: final || [] })
  } catch (err) {
    console.error('[campaigns disparos PUT]', err)
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 })
  }
}
