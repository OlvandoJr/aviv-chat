import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient }              from '@supabase/ssr'

// Gate global: enquanto o usuário tiver `must_change_password` no metadata do Auth
// (senha provisória gerada por um admin — criação ou reset), ele é direcionado para
// /change-password e não acessa o resto do app até definir a própria senha.
export async function middleware(req: NextRequest) {
  const res = NextResponse.next()

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return req.cookies.getAll() },
        setAll(cs) { cs.forEach(({ name, value, options }) => res.cookies.set(name, value, options)) },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  if (user?.user_metadata?.must_change_password) {
    const url = req.nextUrl.clone()
    url.pathname = '/change-password'
    return NextResponse.redirect(url)
  }

  return res
}

// Não roda em assets, api, login e na própria tela de troca (evita loop).
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/|login|change-password).*)'],
}
