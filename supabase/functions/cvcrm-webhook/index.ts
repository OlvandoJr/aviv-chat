/**
 * cvcrm-webhook — Edge Function
 *
 * Receptor do webhook do CV CRM para DISTRATO (Reserva → situação "Distrato").
 * O Sienge não tem webhook de contratos; o CV CRM tem — e, segundo o suporte,
 * todo distrato feito no Sienge aparece no CV em tempo real. Este endpoint
 * fecha a janela que restava (distrato registrado depois do sync das 08:30
 * ainda era cobrado às 09:00 do mesmo dia — caso Luiz Felipe, 12/08).
 *
 * Fluxo: CV avisa → registramos o evento → disparamos o sienge-sync-contratos
 * IMEDIATAMENTE (3 req de cota). Quem cancela cobrança continua sendo a rede
 * de segurança existente (cancelBills + views) — a fonte da verdade é o Sienge;
 * o CV é só o despertador. Se o sync não vir cancelamento (corrida rara), os
 * syncs diários de 03:30/08:30 cobrem.
 *
 * Auth: o CV não manda header customizável confiável — validamos por segredo na
 * query (?key=...), comparado com o secret CVCRM_WEBHOOK_KEY.
 *
 * Anti-rajada: o CV pode disparar vários gatilhos em sequência (muda situação,
 * mensagem, etc.). Se um sync já rodou nos últimos 5 minutos por causa deste
 * webhook, só registramos o evento (sem novo sync) — protege a cota de 100/dia.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)
const WEBHOOK_KEY = Deno.env.get('CVCRM_WEBHOOK_KEY') || ''

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  const url = new URL(req.url)
  if (!WEBHOOK_KEY || url.searchParams.get('key') !== WEBHOOK_KEY) {
    return json({ error: 'unauthorized' }, 401)
  }

  const payload = await req.json().catch(() => ({}))

  try {
    // Sync recente já disparado por este webhook? Então só registra.
    const cincoMinAtras = new Date(Date.now() - 5 * 60_000).toISOString()
    const { count: syncRecente } = await admin.from('sienge_webhook_events')
      .select('id', { count: 'exact', head: true })
      .eq('event', 'CVCRM_DISTRATO')
      .gte('created_at', cincoMinAtras)
      .ilike('note', '%sync disparado%')

    let note = 'registrado (sync recente já cobriu — anti-rajada)'
    let syncResult: unknown = null

    if (!syncRecente) {
      const resp = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/sienge-sync-contratos`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      })
      syncResult = await resp.json().catch(() => null)
      const r = syncResult as any
      note = resp.ok
        ? `sync disparado: ${r?.contratos_cancelados ?? '?'} contrato(s) cancelado(s), ` +
          `cobranças ${JSON.stringify(r?.cobrancas_canceladas ?? {})}`
        : `sync falhou: HTTP ${resp.status}`
    }

    await admin.from('sienge_webhook_events').insert({
      event: 'CVCRM_DISTRATO',
      receivable_bill_id: 0,
      installment_id: 0,
      payload,
      matched: 1,
      note,
      reconciled_at: new Date().toISOString(),
    })

    console.log('cvcrm-webhook:', note)
    return json({ ok: true, note, sync: syncResult })
  } catch (e) {
    console.error('cvcrm-webhook error:', e)
    return json({ ok: false, error: String(e) }, 500)
  }
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
