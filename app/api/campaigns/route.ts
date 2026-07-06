import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

const admin = createAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

/** Cria uma campanha em rascunho. */
export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

    const { name, inboxId, templateId, ownerId, variableMapping = {}, scheduledAt = null,
            headerMediaPath = null, headerMediaFilename = null, headerMediaMode = 'upload' } = await req.json()
    if (!name || !inboxId || !templateId) {
      return NextResponse.json({ error: 'name, inboxId e templateId são obrigatórios' }, { status: 400 })
    }
    // Proprietário dos disparos é OBRIGATÓRIO: as conversas nascem atribuídas a ele.
    if (!ownerId) {
      return NextResponse.json({ error: 'Selecione o proprietário dos disparos (ownerId).' }, { status: 400 })
    }

    const { data, error } = await admin.from('chat_campaigns').insert({
      name,
      inbox_id:         inboxId,
      template_id:      templateId,
      owner_id:         ownerId,
      variable_mapping: variableMapping,
      scheduled_at:     scheduledAt,
      header_media_mode:     headerMediaMode === 'boleto' ? 'boleto' : 'upload',
      header_media_path:     headerMediaMode === 'boleto' ? null : headerMediaPath,
      header_media_filename: headerMediaMode === 'boleto' ? null : headerMediaFilename,
      created_by:       user.id,
      status:           'draft',
    }).select('id').single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, id: data.id })
  } catch (err) {
    console.error('[campaigns POST]', err)
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 })
  }
}
