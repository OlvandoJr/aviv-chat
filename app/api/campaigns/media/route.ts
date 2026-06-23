import { NextRequest, NextResponse }         from 'next/server'
import { createServerClient }                from '@supabase/ssr'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { cookies }                           from 'next/headers'

export const runtime = 'nodejs'

async function getRole(): Promise<string | null> {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll() { return cookieStore.getAll() }, setAll() {} } },
  )
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: att } = await supabase.from('chat_attendants').select('role').eq('id', user.id).maybeSingle()
  return att?.role ?? null
}

const admin = createAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

/** Upload da mídia do header de um template de campanha (DOCUMENT/IMAGE/VIDEO).
 *  Bucket privado campaign-media; o dispatch-campaign gera signed URL no envio. */
export async function POST(req: NextRequest) {
  try {
    const role = await getRole()
    if (!role) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
    if (role !== 'admin' && role !== 'manager') {
      return NextResponse.json({ error: 'Apenas administradores e gerentes.' }, { status: 403 })
    }

    const form = await req.formData()
    const file = form.get('file') as File | null
    if (!file) return NextResponse.json({ error: 'Arquivo obrigatório' }, { status: 400 })
    if (file.size > 20 * 1024 * 1024) return NextResponse.json({ error: 'Arquivo acima de 20MB' }, { status: 413 })

    const mime = file.type || 'application/octet-stream'
    const safeName = (file.name || 'arquivo').replace(/[^\w.\-() ]+/g, '_').slice(0, 120)
    const path = `${crypto.randomUUID()}/${safeName}`

    const { error } = await admin.storage.from('campaign-media')
      .upload(path, Buffer.from(await file.arrayBuffer()), { contentType: mime, upsert: false })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ ok: true, path, filename: safeName })
  } catch (err) {
    console.error('[campaigns media upload]', err)
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 })
  }
}
