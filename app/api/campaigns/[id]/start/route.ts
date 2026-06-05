import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

const admin = createAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

/** Inicia (ou agenda) a campanha e dispara o processamento imediato. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

    const { id } = await ctx.params

    const { data: camp } = await admin
      .from('chat_campaigns')
      .select('id, status, scheduled_at, total')
      .eq('id', id)
      .single()
    if (!camp) return NextResponse.json({ error: 'Campanha não encontrada' }, { status: 404 })
    if (!camp.total) return NextResponse.json({ error: 'Campanha sem destinatários' }, { status: 422 })
    if (!['draft', 'paused', 'scheduled'].includes(camp.status)) {
      return NextResponse.json({ error: `Campanha já está "${camp.status}"` }, { status: 422 })
    }

    const future = camp.scheduled_at && new Date(camp.scheduled_at) > new Date()
    const newStatus = future ? 'scheduled' : 'running'

    await admin.from('chat_campaigns')
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq('id', id)

    // Dispara o processamento imediato (não bloqueia se já agendada para o futuro)
    if (newStatus === 'running') {
      fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/dispatch-campaign`, {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ campaignId: id }),
      }).catch(e => console.error('[campaigns start] dispatch trigger falhou:', e))
    }

    return NextResponse.json({ ok: true, status: newStatus })
  } catch (err) {
    console.error('[campaigns start]', err)
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 })
  }
}
