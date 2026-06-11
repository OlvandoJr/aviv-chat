import { NextRequest, NextResponse }         from 'next/server'
import { createServerClient }                from '@supabase/ssr'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { cookies }                           from 'next/headers'

export const runtime = 'nodejs'

async function getCaller(): Promise<{ id: string; role: string | null } | null> {
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
  if (!user) return null
  const { data: att } = await supabase.from('chat_attendants').select('role').eq('id', user.id).maybeSingle()
  return { id: user.id, role: att?.role ?? null }
}

const admin = createAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

/**
 * Exclui um LOTE de boletos: PDFs do bucket + boletos do lote + registro do lote.
 * Restrito a admin/manager. Desfaz um carregamento errado; a baixa de pagamento
 * vive em sienge_boletos, então excluir o boleto emitido não apaga histórico de
 * pagamento. Re-upload do ZIP recria tudo (upsert idempotente).
 */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const caller = await getCaller()
    if (!caller) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
    if (caller.role !== 'admin' && caller.role !== 'manager') {
      return NextResponse.json({ error: 'Apenas administradores e gerentes podem excluir lotes.' }, { status: 403 })
    }

    const { id } = await ctx.params

    const { data: lote } = await admin.from('boleto_lotes').select('id').eq('id', id).maybeSingle()
    if (!lote) return NextResponse.json({ error: 'Lote não encontrado' }, { status: 404 })

    const { data: boletos, error: selErr } = await admin
      .from('boletos_emitidos')
      .select('id, pdf_path')
      .eq('upload_id', id)
    if (selErr) return NextResponse.json({ error: selErr.message }, { status: 500 })

    // PDFs do bucket (o path {client_id}/{venc}.pdf pertence a exatamente 1 boleto)
    const paths = (boletos || []).map((b) => b.pdf_path).filter(Boolean) as string[]
    let pdfsRemovidos = 0
    for (let i = 0; i < paths.length; i += 100) {
      const chunk = paths.slice(i, i + 100)
      const { error: rmErr } = await admin.storage.from('boletos').remove(chunk)
      if (!rmErr) pdfsRemovidos += chunk.length
    }

    const { error: delErr, count } = await admin
      .from('boletos_emitidos')
      .delete({ count: 'exact' })
      .eq('upload_id', id)
    if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 })

    const { error: loteErr } = await admin.from('boleto_lotes').delete().eq('id', id)
    if (loteErr) return NextResponse.json({ error: loteErr.message }, { status: 500 })

    return NextResponse.json({ ok: true, boletosExcluidos: count || 0, pdfsRemovidos })
  } catch (err) {
    console.error('[boletos lote DELETE]', err)
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 })
  }
}
