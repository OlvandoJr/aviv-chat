import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

const admin = createAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

// Campos de configuração só podem mudar antes/durante a preparação do envio.
const EDITAVEL = ['draft', 'scheduled', 'paused']

/** Edita a campanha. Nome é sempre editável; inbox/template/mapping/agendamento só
 *  em rascunho/agendada/pausada (não mexe no que já foi enviado). */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

    const { id } = await ctx.params
    const b = await req.json()

    const { data: camp } = await admin
      .from('chat_campaigns').select('status, deleted_at').eq('id', id).maybeSingle()
    if (!camp || camp.deleted_at) return NextResponse.json({ error: 'Campanha não encontrada' }, { status: 404 })

    const patch: Record<string, any> = { updated_at: new Date().toISOString() }
    if (b.name !== undefined) patch.name = b.name

    const mudaConfig = b.inboxId !== undefined || b.templateId !== undefined
      || b.variableMapping !== undefined || b.scheduledAt !== undefined
      || b.headerMediaPath !== undefined || b.headerMediaFilename !== undefined
    if (mudaConfig) {
      if (!EDITAVEL.includes(camp.status)) {
        return NextResponse.json({ error: `Não é possível editar a configuração de uma campanha "${camp.status}".` }, { status: 422 })
      }
      if (b.inboxId !== undefined)            patch.inbox_id = b.inboxId
      if (b.templateId !== undefined)         patch.template_id = b.templateId
      if (b.variableMapping !== undefined)    patch.variable_mapping = b.variableMapping
      if (b.scheduledAt !== undefined)        patch.scheduled_at = b.scheduledAt || null
      if (b.headerMediaPath !== undefined)    patch.header_media_path = b.headerMediaPath || null
      if (b.headerMediaFilename !== undefined) patch.header_media_filename = b.headerMediaFilename || null
    }

    const { error } = await admin.from('chat_campaigns').update(patch).eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[campaigns PATCH]', err)
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 })
  }
}

/** Exclui a campanha (soft-delete): some da lista, mas o histórico do cliente
 *  ainda resolve o nome da campanha. Para uma campanha em andamento, também a
 *  interrompe (o dispatch ignora campanhas com deleted_at). */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

    const { id } = await ctx.params
    const { data: camp } = await admin
      .from('chat_campaigns').select('id, deleted_at').eq('id', id).maybeSingle()
    if (!camp || camp.deleted_at) return NextResponse.json({ error: 'Campanha não encontrada' }, { status: 404 })

    const { error } = await admin.from('chat_campaigns')
      .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[campaigns DELETE]', err)
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 })
  }
}
