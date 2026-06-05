import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

const admin = createAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

/**
 * Dry-run: quem receberia HOJE para uma regra com { offsetDays, filter }.
 * alvo = hoje(BRT) - offsetDays. Funciona mesmo antes de salvar a regra.
 */
export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

    const { offsetDays = 0, filter = {} } = await req.json()

    const todayBrt = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }))
    todayBrt.setDate(todayBrt.getDate() - Number(offsetDays))
    const targetDue = todayBrt.toISOString().slice(0, 10)

    let q = admin.from('vw_cobranca_boletos')
      .select('customer_name, customer_phone, parcela, due_date, amount, empreendimento, source')
      .eq('due_date', targetDue)
    if (filter.source && filter.source !== 'both') q = q.eq('source', filter.source)
    if (filter.empreendimento) q = q.ilike('empreendimento', `%${filter.empreendimento}%`)

    const { data, error } = await q.limit(2000)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const rows = (data || []).filter(r => r.customer_phone)
    return NextResponse.json({
      ok: true,
      targetDue,
      total: rows.length,
      sample: rows.slice(0, 20),
    })
  } catch (err) {
    console.error('[regua preview]', err)
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 })
  }
}
