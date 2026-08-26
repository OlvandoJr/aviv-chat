import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

const admin = createAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

/**
 * Reenvia destinatários que FALHARAM.
 *
 * Body: { recipientIds?: string[] } — sem a lista, reenvia todos os que falharam.
 * A campanha volta para 'running' e o dispatch é acionado; ele já processa só
 * quem está 'pending', então basta devolver os escolhidos a esse estado.
 *
 * Trava importante: o filtro `status='failed'` é aplicado NO SERVIDOR, então
 * nenhuma lista vinda do browser consegue reenviar para quem já recebeu.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

    const { id } = await ctx.params
    const body = await req.json().catch(() => ({}))
    const ids: string[] | null = Array.isArray(body?.recipientIds) && body.recipientIds.length
      ? body.recipientIds.map(String)
      : null

    const { data: camp } = await admin
      .from('chat_campaigns').select('id, status, deleted_at').eq('id', id).maybeSingle()
    if (!camp || camp.deleted_at) return NextResponse.json({ error: 'Campanha não encontrada' }, { status: 404 })
    if (camp.status === 'running') {
      return NextResponse.json({ error: 'A campanha ainda está enviando — aguarde terminar para reenviar.' }, { status: 422 })
    }

    let q = admin.from('chat_campaign_recipients')
      .update({ status: 'pending', error: null, wa_message_id: null, sent_at: null, claimed_at: null })
      .eq('campaign_id', id)
      .eq('status', 'failed')          // nunca reenvia para quem já recebeu
    if (ids) q = q.in('id', ids)

    const { data: resetados, error } = await q.select('id')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const n = resetados?.length || 0
    if (!n) return NextResponse.json({ error: 'Nenhum destinatário com falha para reenviar.' }, { status: 422 })

    // Volta a campanha para envio e reconta (o dispatch recalcula ao terminar).
    await admin.from('chat_campaigns')
      .update({ status: 'running', updated_at: new Date().toISOString() })
      .eq('id', id)

    fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/dispatch-campaign`, {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ campaignId: id }),
    }).catch(e => console.error('[campaigns retry] dispatch trigger falhou:', e))

    return NextResponse.json({ ok: true, reenviando: n })
  } catch (err) {
    console.error('[campaigns retry]', err)
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 })
  }
}
