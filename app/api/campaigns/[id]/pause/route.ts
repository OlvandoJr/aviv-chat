import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

const admin = createAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

/** Pausa uma campanha em execução/agendada (recipients pendentes ficam parados). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

    const { id } = await ctx.params
    const { data: camp } = await admin
      .from('chat_campaigns').select('status').eq('id', id).single()
    if (!camp) return NextResponse.json({ error: 'Campanha não encontrada' }, { status: 404 })
    if (!['running', 'scheduled'].includes(camp.status)) {
      return NextResponse.json({ error: `Não é possível pausar "${camp.status}"` }, { status: 422 })
    }

    await admin.from('chat_campaigns')
      .update({ status: 'paused', updated_at: new Date().toISOString() })
      .eq('id', id)

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[campaigns pause]', err)
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 })
  }
}
