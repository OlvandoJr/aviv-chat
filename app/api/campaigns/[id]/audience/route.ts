import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { resolveVariables }          from '@/lib/whatsapp/vars'

const admin = createAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

/**
 * Resolve a audiência da campanha e (re)insere os recipients com as variáveis
 * já calculadas a partir do variable_mapping da campanha.
 *
 * Body:
 *  - { mode: 'view', filter: { source?, dueFrom?, dueTo?, empreendimento? } }
 *  - { mode: 'manual', rows: [{ wa_id, name?, ...colunas }] }
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

    const { id } = await ctx.params
    const { mode = 'view', filter = {}, rows = [] } = await req.json()

    const { data: camp } = await admin
      .from('chat_campaigns')
      .select('id, status, variable_mapping, deleted_at')
      .eq('id', id)
      .single()
    if (!camp || camp.deleted_at) return NextResponse.json({ error: 'Campanha não encontrada' }, { status: 404 })
    if (!['draft', 'scheduled', 'paused'].includes(camp.status)) {
      return NextResponse.json({ error: 'Só é possível editar audiência em rascunho/agendada/pausada' }, { status: 422 })
    }

    // ── Montar as linhas de origem ────────────────────────────────────────────
    let sourceRows: Record<string, any>[] = []

    if (mode === 'view') {
      let q = admin.from('vw_clientes_boletos')
        .select('phone_norm, source, customer_name, customer_phone, empreendimento, quadra, lote, parcela, due_date, amount, link_boleto')
      if (filter.source && filter.source !== 'both') q = q.eq('source', filter.source)
      if (filter.dueFrom)       q = q.gte('due_date', filter.dueFrom)
      if (filter.dueTo)         q = q.lte('due_date', filter.dueTo)
      if (filter.empreendimento) q = q.ilike('empreendimento', `%${filter.empreendimento}%`)
      const { data, error } = await q.limit(5000)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      sourceRows = (data || []).map(r => ({ ...r, wa_id: r.customer_phone, name: r.customer_name }))
    } else if (mode === 'manual') {
      sourceRows = (rows || []).map((r: any) => ({ ...r, wa_id: r.wa_id, name: r.name }))
    } else {
      return NextResponse.json({ error: 'mode inválido' }, { status: 400 })
    }

    // Mapa pdf_path por (phone_norm|venc) — usado quando a campanha enviar o boleto
    // de cada cliente (modo 'boleto'). Resolve por boletos_emitidos (fonte do PDF).
    const pdfByKey = new Map<string, string>()
    const phonesAud = [...new Set(sourceRows.map(r => r.phone_norm).filter(Boolean))]
    for (let i = 0; i < phonesAud.length; i += 200) {
      const chunk = phonesAud.slice(i, i + 200)
      const { data: bes } = await admin.from('boletos_emitidos')
        .select('phone_norm, vencimento, pdf_path').in('phone_norm', chunk)
      for (const b of bes || []) {
        if (b.pdf_path) pdfByKey.set(`${b.phone_norm}|${String(b.vencimento).slice(0, 10)}`, b.pdf_path)
      }
    }

    // Filtrar sem telefone e deduplicar por wa_id
    const seen = new Set<string>()
    const recipients = sourceRows
      .filter(r => r.wa_id && String(r.wa_id).replace(/\D/g, '').length >= 10)
      .filter(r => { const k = String(r.wa_id); if (seen.has(k)) return false; seen.add(k); return true })
      .map(r => ({
        campaign_id: id,
        wa_id:       String(r.wa_id).replace(/\D/g, ''),
        name:        r.name || null,
        variables:   resolveVariables(camp.variable_mapping as any, r),
        boleto_pdf_path: pdfByKey.get(`${r.phone_norm}|${String(r.due_date || '').slice(0, 10)}`) || null,
        status:      'pending' as const,
      }))

    // Substituir audiência: limpar pendentes anteriores e reinserir
    await admin.from('chat_campaign_recipients').delete().eq('campaign_id', id)
    if (recipients.length) {
      // inserir em lotes de 500
      for (let i = 0; i < recipients.length; i += 500) {
        const chunk = recipients.slice(i, i + 500)
        const { error } = await admin.from('chat_campaign_recipients')
          .upsert(chunk, { onConflict: 'campaign_id,wa_id', ignoreDuplicates: true })
        if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      }
    }

    await admin.from('chat_campaigns').update({
      total: recipients.length,
      sent: 0,
      failed: 0,
      audience: { mode, filter },
      updated_at: new Date().toISOString(),
    }).eq('id', id)

    return NextResponse.json({ ok: true, total: recipients.length })
  } catch (err) {
    console.error('[campaigns audience]', err)
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 })
  }
}
