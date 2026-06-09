import { NextRequest, NextResponse }            from 'next/server'
import { createServerClient }                   from '@supabase/ssr'
import { createClient as createAdminClient }    from '@supabase/supabase-js'
import { cookies }                              from 'next/headers'

// GET /api/boletos/pdf?id=<emitido_id> → 302 para uma signed URL fresca do PDF (bucket privado "boletos")
async function getCaller(): Promise<boolean> {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll() { return cookieStore.getAll() }, setAll() {} } }
  )
  const { data: { user } } = await supabase.auth.getUser()
  return !!user
}

const admin = createAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(req: NextRequest) {
  if (!(await getCaller())) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const id = new URL(req.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id obrigatório' }, { status: 400 })

  const { data: b } = await admin
    .from('boletos_emitidos').select('pdf_path').eq('id', id).maybeSingle()
  if (!b?.pdf_path) return NextResponse.json({ error: 'Boleto sem PDF no banco' }, { status: 404 })

  const { data: signed, error } = await admin.storage.from('boletos').createSignedUrl(b.pdf_path, 300)
  if (error || !signed?.signedUrl) {
    return NextResponse.json({ error: error?.message || 'Falha ao gerar URL' }, { status: 500 })
  }
  return NextResponse.redirect(signed.signedUrl)
}
