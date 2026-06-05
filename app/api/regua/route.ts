import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

const admin = createAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

/** Cria um fluxo de régua com seus disparos (passos). */
export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

    const b = await req.json()
    if (!b.name || !b.inboxId) {
      return NextResponse.json({ error: 'name e inboxId são obrigatórios' }, { status: 400 })
    }
    const steps = Array.isArray(b.steps) ? b.steps : []
    if (steps.length === 0) {
      return NextResponse.json({ error: 'Inclua ao menos um disparo' }, { status: 400 })
    }

    const { data: regua, error } = await admin.from('cobranca_regua').insert({
      name:            b.name,
      inbox_id:        b.inboxId,
      audience_filter: b.audienceFilter || {},
      active:          b.active ?? true,
    }).select('id').single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const rows = steps.map((s: any, i: number) => ({
      regua_id:         regua.id,
      offset_days:      Number(s.offsetDays) || 0,
      send_time:        s.sendTime || '09:00',
      template_id:      s.templateId,
      variable_mapping: s.variableMapping || {},
      sort_order:       i,
    }))
    const { error: stErr } = await admin.from('cobranca_regua_step').insert(rows)
    if (stErr) return NextResponse.json({ error: stErr.message }, { status: 500 })

    return NextResponse.json({ ok: true, id: regua.id })
  } catch (err) {
    console.error('[regua POST]', err)
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 })
  }
}
