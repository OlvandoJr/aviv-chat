import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@/lib/supabase/server'
import { usuarioAtual, ehSupervisor } from '@/lib/api/papel'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { resolverAudiencia }         from '@/lib/campaigns/audiencia'

const admin = createAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

/**
 * ACRESCENTA contatos a uma campanha — inclusive já encerrada.
 *
 * Diferente de /audience (que substitui e só roda antes do envio), aqui nada é
 * apagado: resolve a mesma audiência e insere APENAS os telefones que ainda não
 * estão na campanha. Quem já recebeu continua com o histórico intacto e NÃO é
 * reenviado por engano — a chave é (campaign_id, wa_id).
 *
 * `dryRun: true` devolve só a contagem, para a tela perguntar antes de gravar.
 *
 * Body: { mode, base, filter, rows, dryRun? }
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
    const { mode = 'view', base = 'boletos', filter = {}, rows = [], dryRun = false } = await req.json()

    const { data: camp } = await admin
      .from('chat_campaigns')
      .select('id, status, variable_mapping, deleted_at, incluir_distratados')
      .eq('id', id).single()
    if (!camp || camp.deleted_at) return NextResponse.json({ error: 'Campanha não encontrada' }, { status: 404 })
    if (camp.status === 'running') {
      return NextResponse.json({ error: 'A campanha está enviando agora — aguarde terminar para adicionar contatos.' }, { status: 422 })
    }

    const res = await resolverAudiencia(admin, camp, { mode, base, filter, rows })
    if ('erro' in res) return NextResponse.json({ error: res.erro }, { status: 500 })
    const { recipients, removidosDistrato } = res

    // Quem já está na campanha (em qualquer status) não entra de novo.
    const jaNaCampanha = new Set<string>()
    for (let i = 0; i < 100; i++) {
      const { data, error } = await admin.from('chat_campaign_recipients')
        .select('wa_id').eq('campaign_id', id).range(i * 1000, i * 1000 + 999)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      for (const r of data || []) jaNaCampanha.add(String(r.wa_id))
      if (!data || data.length < 1000) break        // PostgREST corta em 1000: paginar
    }

    const novos = recipients.filter(r => !jaNaCampanha.has(r.wa_id))

    if (dryRun) {
      return NextResponse.json({
        ok: true, dryRun: true,
        novos: novos.length,
        jaEstavam: recipients.length - novos.length,
        resolvidos: recipients.length,
        jaNaCampanha: jaNaCampanha.size,
        removidosDistrato,
        amostra: novos.slice(0, 8).map(n => ({ wa_id: n.wa_id, name: n.name })),
      })
    }

    if (novos.length) {
      for (let i = 0; i < novos.length; i += 500) {
        const { error } = await admin.from('chat_campaign_recipients')
          .upsert(novos.slice(i, i + 500), { onConflict: 'campaign_id,wa_id', ignoreDuplicates: true })
        if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      }
    }

    const { count: total } = await admin.from('chat_campaign_recipients')
      .select('id', { count: 'exact', head: true }).eq('campaign_id', id)
    await admin.from('chat_campaigns')
      .update({ total: total || 0, updated_at: new Date().toISOString() }).eq('id', id)

    return NextResponse.json({
      ok: true, novos: novos.length,
      jaEstavam: recipients.length - novos.length,
      total: total || 0, removidosDistrato,
    })
  } catch (err) {
    console.error('[campaigns audience/add]', err)
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 })
  }
}
