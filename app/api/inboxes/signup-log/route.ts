import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@/lib/supabase/server'
import { usuarioAtual }              from '@/lib/api/papel'
import { createClient as createAdminClient } from '@supabase/supabase-js'

const admin = createAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

/**
 * Registra um evento da jornada do Cadastro Incorporado (meta_signup_log).
 * Best-effort de auditoria: nunca deve travar o fluxo — erro aqui vira 200 vazio.
 */
export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ ok: false }, { status: 401 })
    const eu = await usuarioAtual()

    const { evento, dados = null } = await req.json()
    if (!evento || typeof evento !== 'string') return NextResponse.json({ ok: false }, { status: 400 })

    await admin.from('meta_signup_log').insert({
      evento: String(evento).slice(0, 60),
      dados,
      attendant_id: eu?.id || null,
    })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: false })
  }
}
