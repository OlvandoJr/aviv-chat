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

    const { offsetDays = 0, onLoad = false, filter = {} } = await req.json()

    const todayBrt = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }))
    const dow = todayBrt.getDay()

    // Regra legal: sábado/domingo não dispara nada (posterga p/ segunda).
    if (dow === 0 || dow === 6) {
      return NextResponse.json({ ok: true, weekend: true, total: 0, targetDue: null, sample: [] })
    }

    // Alvos (mesma lógica do edge): hoje; na segunda inclui os alvos de sáb/dom.
    const targetDues: string[] = []
    for (const back of dow === 1 && !onLoad ? [2, 1, 0] : [0]) {
      const t = new Date(todayBrt)
      if (!onLoad) t.setDate(t.getDate() - back - Number(offsetDays))
      targetDues.push(t.toISOString().slice(0, 10))
    }
    const targetDue = targetDues[targetDues.length - 1]

    // onLoad: data efetiva de disparo da carga é hoje; offset: vencendo na(s) data(s)-alvo
    let q = admin.from('vw_cobranca_boletos')
      .select('customer_name, customer_phone, parcela, due_date, amount, empreendimento, source')
    q = onLoad ? q.eq('load_dispatch_date', targetDue) : q.in('due_date', targetDues)
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
