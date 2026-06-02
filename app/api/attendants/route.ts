import { NextRequest, NextResponse } from 'next/server'
import { createServerClient }        from '@supabase/ssr'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { cookies }                   from 'next/headers'

// ── Helper: cliente autenticado por cookie ────────────────────────────────────
async function getCallerRole(): Promise<{ userId: string; role: string } | null> {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll()                        { return cookieStore.getAll() },
        setAll(cs) { cs.forEach(({ name, value, options }) => cookieStore.set(name, value, options)) },
      },
    }
  )
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: me } = await supabase.from('chat_attendants').select('role').eq('id', user.id).single()
  return me ? { userId: user.id, role: me.role } : null
}

const admin = createAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// ── POST — criar usuário ──────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const caller = await getCallerRole()
  if (!caller) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  if (caller.role !== 'admin' && caller.role !== 'manager') {
    return NextResponse.json({ error: 'Sem permissão para criar usuários' }, { status: 403 })
  }

  const { name, email, password, role, sector } = await req.json()

  // Gerente só pode criar Atendentes
  if (caller.role === 'manager' && role !== 'agent') {
    return NextResponse.json({ error: 'Gerentes podem criar apenas Atendentes' }, { status: 403 })
  }

  const { data: authData, error: authError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (authError || !authData.user) {
    return NextResponse.json({ error: authError?.message || 'Erro ao criar usuário' }, { status: 400 })
  }

  const { data: attendant, error: dbError } = await admin
    .from('chat_attendants')
    .insert({ id: authData.user.id, name, email, role, sector: sector || null })
    .select()
    .single()

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 400 })
  }

  return NextResponse.json({ attendant }, { status: 201 })
}

// ── PATCH — editar usuário ────────────────────────────────────────────────────
export async function PATCH(req: NextRequest) {
  const caller = await getCallerRole()
  if (!caller) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  if (caller.role !== 'admin' && caller.role !== 'manager') {
    return NextResponse.json({ error: 'Sem permissão para editar usuários' }, { status: 403 })
  }

  const { id, name, sector, role, is_active } = await req.json()
  if (!id) return NextResponse.json({ error: 'id obrigatório' }, { status: 400 })

  // Gerente não pode mudar role para admin ou manager
  if (caller.role === 'manager' && role && role !== 'agent') {
    return NextResponse.json({ error: 'Gerentes podem definir apenas perfil Atendente' }, { status: 403 })
  }

  const patch: Record<string, unknown> = {}
  if (name      !== undefined) patch.name      = name
  if (sector    !== undefined) patch.sector    = sector || null
  if (role      !== undefined) patch.role      = role
  if (is_active !== undefined) patch.is_active = is_active

  const { data: attendant, error } = await admin
    .from('chat_attendants')
    .update(patch)
    .eq('id', id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 400 })

  return NextResponse.json({ attendant })
}
