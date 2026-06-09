import { NextRequest, NextResponse }            from 'next/server'
import { createServerClient }                   from '@supabase/ssr'
import { createClient as createAdminClient }    from '@supabase/supabase-js'
import { cookies }                              from 'next/headers'

// GET /api/media?path=<storagePath> → 302 para uma signed URL fresca do bucket
// privado "chat-media". Proxy autenticado: só atendente logado vê mídia do cliente
// (imagens, áudios, documentos, comprovantes). Meta/OpenAI NÃO usam isto — recebem
// signed URLs direto dos produtores (não há como autenticá-los).

async function isLogged(): Promise<boolean> {
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
  if (!(await isLogged())) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  let path = new URL(req.url).searchParams.get('path') || ''
  // aceita também a URL pública completa (compat com media_url antigos)
  const m = path.match(/\/object\/(?:public|sign)\/chat-media\/(.+?)(?:\?|$)/)
  if (m) path = decodeURIComponent(m[1])
  path = path.replace(/^\/+/, '')
  if (!path) return NextResponse.json({ error: 'path obrigatório' }, { status: 400 })

  const { data, error } = await admin.storage.from('chat-media').createSignedUrl(path, 300)
  if (error || !data?.signedUrl) {
    return NextResponse.json({ error: error?.message || 'Arquivo não encontrado' }, { status: 404 })
  }
  return NextResponse.redirect(data.signedUrl)
}
