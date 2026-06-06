import { NextRequest, NextResponse } from 'next/server'
import { createServerClient }        from '@supabase/ssr'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { cookies }                   from 'next/headers'

// Cliente autenticado por cookie — só para validar que há um atendente logado
async function getCaller(): Promise<string | null> {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll()   { return cookieStore.getAll() },
        setAll(cs) { cs.forEach(({ name, value, options }) => cookieStore.set(name, value, options)) },
      },
    }
  )
  const { data: { user } } = await supabase.auth.getUser()
  return user?.id || null
}

const admin = createAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// POST { source: 'sienge' | 'sgl', id, undo? } → marca/desmarca o boleto como pago
export async function POST(req: NextRequest) {
  const userId = await getCaller()
  if (!userId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const { source, id, undo } = await req.json()
  if (!source || id == null) {
    return NextResponse.json({ error: 'source e id são obrigatórios' }, { status: 400 })
  }

  const now = new Date().toISOString()

  if (source === 'sgl') {
    // mensagens_cobranca: confirmado pelo comprovante (não há API de baixa no SGL)
    const { error } = await admin
      .from('mensagens_cobranca')
      .update({ status: undo ? 'mensagem_enviada' : 'comprovante_confirmado', updated_at: now })
      .eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  } else if (source === 'sienge') {
    const { error } = await admin
      .from('sienge_boletos')
      .update(undo
        ? { status: 'aberto', paid_at: null, updated_at: now }
        : { status: 'pago', paid_at: now, updated_at: now })
      .eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  } else {
    return NextResponse.json({ error: 'source inválido' }, { status: 400 })
  }

  return NextResponse.json({ ok: true })
}
