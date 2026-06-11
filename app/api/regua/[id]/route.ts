import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

const admin = createAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

/** Atualiza o fluxo (campos do pai e/ou toggle active) e, se enviado, substitui os passos. */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

    const { id } = await ctx.params
    const b = await req.json()

    const patch: Record<string, any> = { updated_at: new Date().toISOString() }
    if (b.name !== undefined)           patch.name = b.name
    if (b.inboxId !== undefined)        patch.inbox_id = b.inboxId
    if (b.audienceFilter !== undefined) patch.audience_filter = b.audienceFilter
    if (b.active !== undefined)         patch.active = b.active

    if (Object.keys(patch).length > 1) {
      const { error } = await admin.from('cobranca_regua').update(patch).eq('id', id)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Substituir passos, se enviados
    if (Array.isArray(b.steps)) {
      await admin.from('cobranca_regua_step').delete().eq('regua_id', id)
      if (b.steps.length) {
        const rows = b.steps.map((s: any, i: number) => ({
          regua_id:         id,
          // on_load usa offset 999 (sentinela) só p/ a UNIQUE do log deduplicar
          on_load:          !!s.onLoad,
          offset_days:      s.onLoad ? 999 : Number(s.offsetDays) || 0,
          send_time:        s.sendTime || '09:00',
          template_id:      s.templateId,
          variable_mapping: s.variableMapping || {},
          sort_order:       i,
        }))
        const { error: stErr } = await admin.from('cobranca_regua_step').insert(rows)
        if (stErr) return NextResponse.json({ error: stErr.message }, { status: 500 })
      }
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[regua PATCH]', err)
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 })
  }
}

/** Remove o fluxo (cascateia passos e log). */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

    const { id } = await ctx.params
    const { error } = await admin.from('cobranca_regua').delete().eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[regua DELETE]', err)
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 })
  }
}
