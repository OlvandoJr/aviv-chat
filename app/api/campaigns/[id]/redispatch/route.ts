import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@/lib/supabase/server'
import { usuarioAtual, ehSupervisor } from '@/lib/api/papel'
import { createClient as createAdminClient } from '@supabase/supabase-js'

const admin = createAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

/**
 * Dispara de novo uma campanha já encerrada.
 *
 * escopo:
 *  - 'novos' → envia só quem está pendente (os contatos recém-adicionados).
 *  - 'todos' → devolve TODOS os destinatários a pendente e reenvia. É envio em
 *    massa de verdade: quem já recebeu recebe outra vez. A tela confirma.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
    const eu = await usuarioAtual()
    if (!ehSupervisor(eu?.papel)) {
      return NextResponse.json({ error: 'Apenas administradores e gerentes gerenciam campanhas.' }, { status: 403 })
    }

    const { id } = await ctx.params
    const { escopo = 'novos' } = await req.json().catch(() => ({}))
    if (!['novos', 'todos'].includes(escopo)) {
      return NextResponse.json({ error: 'escopo inválido' }, { status: 400 })
    }

    const { data: camp } = await admin
      .from('chat_campaigns').select('id, status, deleted_at').eq('id', id).maybeSingle()
    if (!camp || camp.deleted_at) return NextResponse.json({ error: 'Campanha não encontrada' }, { status: 404 })
    if (camp.status === 'running') {
      return NextResponse.json({ error: 'A campanha já está enviando.' }, { status: 422 })
    }

    if (escopo === 'todos') {
      const { error } = await admin.from('chat_campaign_recipients')
        .update({ status: 'pending', error: null, wa_message_id: null, sent_at: null, claimed_at: null,
                  delivered_at: null, read_at: null })
        .eq('campaign_id', id)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const { count: pendentes } = await admin.from('chat_campaign_recipients')
      .select('id', { count: 'exact', head: true }).eq('campaign_id', id).eq('status', 'pending')
    if (!pendentes) {
      return NextResponse.json({ error: 'Não há destinatários pendentes para enviar.' }, { status: 422 })
    }

    await admin.from('chat_campaigns')
      .update({ status: 'running', updated_at: new Date().toISOString() }).eq('id', id)

    fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/dispatch-campaign`, {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ campaignId: id }),
    }).catch(e => console.error('[campaigns redispatch] dispatch trigger falhou:', e))

    return NextResponse.json({ ok: true, enviando: pendentes, escopo })
  } catch (err) {
    console.error('[campaigns redispatch]', err)
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 })
  }
}
