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
    user_metadata: { must_change_password: true },   // troca obrigatória no 1º acesso
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

  const { id, name, sector, role, is_active, action } = await req.json()
  if (!id) return NextResponse.json({ error: 'id obrigatório' }, { status: 400 })

  // ── Reset de senha: gera nova senha forte e devolve para exibir ─────────────
  if (action === 'reset_password') {
    const pwd = genPassword()
    const { error: pErr } = await admin.auth.admin.updateUserById(id, {
      password: pwd,
      user_metadata: { must_change_password: true },   // força nova troca no próximo acesso
    })
    if (pErr) return NextResponse.json({ error: pErr.message }, { status: 400 })
    return NextResponse.json({ ok: true, password: pwd })
  }

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

// ── DELETE — excluir usuário (soft-delete + revoga login) ─────────────────────
// Body: { id, action?, transferTo? }
//  - sem action: se houver conversas ABERTAS atribuídas, retorna { needsAction, openCount, team }
//  - action='transfer' + transferTo: reatribui as abertas; action='archive': arquiva as abertas
export async function DELETE(req: NextRequest) {
  const caller = await getCallerRole()
  if (!caller) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  if (caller.role !== 'admin' && caller.role !== 'manager') {
    return NextResponse.json({ error: 'Sem permissão para excluir usuários' }, { status: 403 })
  }

  const { id, action, transferTo } = await req.json()
  if (!id) return NextResponse.json({ error: 'id obrigatório' }, { status: 400 })
  if (id === caller.userId) {
    return NextResponse.json({ error: 'Você não pode excluir o próprio usuário.' }, { status: 400 })
  }

  const { data: target } = await admin
    .from('chat_attendants').select('id, name, role, sector').eq('id', id).single()
  if (!target) return NextResponse.json({ error: 'Usuário não encontrado' }, { status: 404 })

  // Gerente só exclui Atendentes
  if (caller.role === 'manager' && target.role !== 'agent') {
    return NextResponse.json({ error: 'Gerentes podem excluir apenas Atendentes' }, { status: 403 })
  }

  // Conversas ABERTAS atribuídas a este usuário
  const { count: openCount } = await admin
    .from('chat_conversations')
    .select('id', { count: 'exact', head: true })
    .eq('assignee_id', id).eq('status', 'open')

  if ((openCount || 0) > 0 && action !== 'transfer' && action !== 'archive') {
    // Opções de transferência: ativos do MESMO setor (fallback: todos ativos)
    let team: any[] = []
    if (target.sector) {
      const { data } = await admin.from('chat_attendants')
        .select('id, name, sector').eq('is_active', true).is('deleted_at', null)
        .eq('sector', target.sector).neq('id', id)
      team = data || []
    }
    if (team.length === 0) {
      const { data } = await admin.from('chat_attendants')
        .select('id, name, sector').eq('is_active', true).is('deleted_at', null).neq('id', id)
      team = data || []
    }
    return NextResponse.json({ needsAction: true, openCount, team })
  }

  // Tratar as conversas abertas conforme a ação
  if ((openCount || 0) > 0) {
    if (action === 'transfer') {
      if (!transferTo) return NextResponse.json({ error: 'Selecione para quem transferir' }, { status: 400 })
      const { error: tErr } = await admin.from('chat_conversations')
        .update({ assignee_id: transferTo })
        .eq('assignee_id', id).eq('status', 'open')
      if (tErr) return NextResponse.json({ error: tErr.message }, { status: 400 })
    } else if (action === 'archive') {
      const { error: aErr } = await admin.from('chat_conversations')
        .update({ status: 'archived' })
        .eq('assignee_id', id).eq('status', 'open')
      if (aErr) return NextResponse.json({ error: aErr.message }, { status: 400 })
    }
  }

  // Soft-delete (preserva histórico) + revoga o login no Auth (libera o e-mail)
  const { error: dErr } = await admin.from('chat_attendants')
    .update({ deleted_at: new Date().toISOString(), is_active: false }).eq('id', id)
  if (dErr) return NextResponse.json({ error: dErr.message }, { status: 400 })

  await admin.auth.admin.deleteUser(id).catch(() => { /* best-effort: login revogado */ })

  return NextResponse.json({ ok: true })
}

// Senha forte e legível (sem caracteres ambíguos)
function genPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const lower = 'abcdefghijkmnpqrstuvwxyz'
  const dig   = '23456789'
  const all   = upper + lower + dig
  const rnd   = (set: string) => set[Math.floor(Math.random() * set.length)]
  let p = rnd(upper) + rnd(lower) + rnd(dig) + '@'
  for (let i = 0; i < 8; i++) p += rnd(all)
  return p
}
