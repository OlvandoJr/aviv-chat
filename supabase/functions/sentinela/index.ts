/**
 * sentinela — Edge Function (cron diário, 07:00 BRT)
 *
 * Confere os invariantes do sistema e grava uma linha por check em
 * sentinela_log. NÃO consome a API do Sienge (só banco) e NÃO envia mensagem
 * a ninguém — registro passivo, consultado pelo painel/SQL.
 *
 * Cada check nasce de um incidente real de agosto/2026 — o comentário de cada
 * um diz qual. A regra de ouro: quebra silenciosa tem de virar linha ok=false
 * NA MANHÃ SEGUINTE, não reclamação de cliente dias depois.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

type Check = { invariante: string; ok: boolean; valor: number; limite: number; detalhe: string }

async function contar(builder: any): Promise<number> {
  const { count } = await builder
  return count || 0
}

Deno.serve(async () => {
  const checks: Check[] = []
  const ontem = new Date(Date.now() - 24 * 3600e3).toISOString()

  try {
    // 1. Baixas que chegaram nas últimas 24h e não casaram (encalhe de 01-06/08:
    //    500+ eventos morreram sem ninguém ver por 6 dias).
    // Exclui os "ignorado" (parcelas que não são nossas — entrada, títulos de
    // terceiros): o filtro de relevância marca assim de propósito e não é
    // problema. Primeira execução da sentinela alarmou com 13 desses.
    const naoCasadas24h = await contar(admin.from('sienge_webhook_events')
      .select('id', { count: 'exact', head: true })
      .eq('event', 'RECEIPT_PROCESSED').eq('matched', 0).gte('created_at', ontem)
      .not('note', 'ilike', 'ignorado%'))
    checks.push({ invariante: 'baixas_nao_casadas_24h', ok: naoCasadas24h <= 10, valor: naoCasadas24h, limite: 10,
      detalhe: 'RECEIPT_PROCESSED das últimas 24h com matched=0, excluindo os "ignorado" (o reconcile ainda vai tentar; >10 = investigar o matcher)' })

    // 2. Baixas DESISTIDAS (5 tentativas) — nunca deveria crescer.
    const desistidas = await contar(admin.from('sienge_webhook_events')
      .select('id', { count: 'exact', head: true })
      .eq('event', 'RECEIPT_PROCESSED').eq('matched', 0).gte('attempts', 5))
    checks.push({ invariante: 'baixas_desistidas_total', ok: desistidas === 0, valor: desistidas, limite: 0,
      detalhe: 'eventos com 5 tentativas esgotadas — cada um é um pagamento possivelmente não refletido' })

    // 3. Boleto ABERTO cuja parcela consta PAGA (o dano do encalhe: cliente pago
    //    sendo cobrado). Tem de ser SEMPRE zero.
    const { data: abertosPagos } = await admin.rpc('sentinela_abertos_com_parcela_paga')
    const nAbertosPagos = Number(abertosPagos ?? -1)
    checks.push({ invariante: 'abertos_com_parcela_paga', ok: nAbertosPagos === 0, valor: nAbertosPagos, limite: 0,
      detalhe: 'boletos_emitidos aberto com sienge_boletos pago na mesma parcela — cliente pago em cobrança' })

    // 4. Distratado ainda cobrável (rede das migrations 068/069 furada?).
    const { data: distratados } = await admin.rpc('sentinela_distratado_cobravel')
    const nDistratados = Number(distratados ?? -1)
    checks.push({ invariante: 'distratado_cobravel', ok: nDistratados === 0, valor: nDistratados, limite: 0,
      detalhe: 'cliente sem nenhum contrato ativo presente na vw_cobranca_boletos' })

    // 5. Webhook de contrato mudo (a grafia errada ficou 2 MESES sem ninguém
    //    notar: zero eventos = webhook morto, o fluxo normal tem dezenas/dia).
    const tresDias = new Date(Date.now() - 72 * 3600e3).toISOString()
    const contratos72h = await contar(admin.from('sienge_webhook_events')
      .select('id', { count: 'exact', head: true })
      .ilike('event', 'sales_contract%').gte('created_at', tresDias))
    checks.push({ invariante: 'webhook_contratos_vivo', ok: contratos72h > 0, valor: contratos72h, limite: 1,
      detalhe: 'eventos sales_contract_* nas últimas 72h — zero = assinatura/endpoint mortos' })

    // 6. Comprovante processado sem veredito (pipeline de análise quebrado —
    //    a regressão de prompt de 17-20/08 teria aparecido aqui).
    const { data: semVerdict } = await admin.from('chat_messages')
      .select('id').in('type', ['image', 'document'])
      .gte('created_at', ontem)
      .not('ai_analysis', 'is', null)
      .is('ai_analysis->verdict', null)
      .filter('ai_analysis->>nao_comprovante', 'not.eq', 'true')
      .filter('ai_analysis->>parcela_ja_paga', 'not.eq', 'true')
      .limit(20)
    const nSemVerdict = semVerdict?.length || 0
    checks.push({ invariante: 'comprovante_sem_veredito_24h', ok: nSemVerdict === 0, valor: nSemVerdict, limite: 0,
      detalhe: 'mídias analisadas como comprovante mas sem verdict — análise caiu no meio' })

    // 7. Taxa de "50% válido" nas últimas 24h (regressão de leitura: quando o
    //    prompt quebrou, quase todo comprovante virou 50%/manual).
    const { data: vered } = await admin.from('chat_messages')
      .select('ai_analysis').in('type', ['image', 'document'])
      .gte('created_at', ontem).not('ai_analysis->verdict', 'is', null).limit(100)
    const vs = (vered || []).map((m: any) => String(m.ai_analysis?.verdict || ''))
    const n50 = vs.filter((v) => v.includes('50%')).length
    const taxaOk = vs.length < 4 || n50 / vs.length <= 0.5
    checks.push({ invariante: 'taxa_50pct_24h', ok: taxaOk, valor: vs.length ? Math.round(100 * n50 / vs.length) : 0, limite: 50,
      detalhe: `${n50} de ${vs.length} vereditos em 50% — acima de 50% com 4+ casos cheira a regressão de leitura` })

    // 8. Cota do Sienge: chamadas [api] hoje (100/dia no plano Free; >80 = o
    //    resto do dia falha para o cliente).
    const inicioDia = new Date(); inicioDia.setUTCHours(0, 0, 0, 0)
    const gastoApi = await contar(admin.from('sienge_webhook_events')
      .select('id', { count: 'exact', head: true })
      .ilike('note', '%[api]%')
      .or(`reconciled_at.gte.${inicioDia.toISOString()},last_attempt_at.gte.${inicioDia.toISOString()},created_at.gte.${inicioDia.toISOString()}`))
    checks.push({ invariante: 'cota_sienge_api_hoje', ok: gastoApi <= 80, valor: gastoApi, limite: 80,
      detalhe: 'chamadas [api] registradas hoje — teto do plano Free é 100/dia' })
    // 9. Caixa de coexistência desconectada (celular fechado ~14 dias é a razão
    //    mais comum). Desconectada, ela PARA de espelhar — atendente fica cego.
    const desconectadas = await contar(admin.from('chat_inboxes')
      .select('id', { count: 'exact', head: true })
      .eq('connection_mode', 'coexistence').eq('connection_status', 'disconnected'))
    checks.push({ invariante: 'coexistencia_desconectada', ok: desconectadas === 0, valor: desconectadas, limite: 0,
      detalhe: 'caixas em coexistência com connection_status=disconnected — reconectar no app do celular' })
  } catch (e) {
    checks.push({ invariante: 'sentinela_executou', ok: false, valor: 0, limite: 1, detalhe: `erro: ${String(e).slice(0, 200)}` })
  }

  const { error } = await admin.from('sentinela_log').insert(
    checks.map((c) => ({ invariante: c.invariante, ok: c.ok, valor: c.valor, limite: c.limite, detalhe: c.detalhe })))
  if (error) console.error('sentinela: falha ao gravar', error)

  const falhas = checks.filter((c) => !c.ok)
  console.log(`sentinela: ${checks.length} checks, ${falhas.length} falha(s)`,
    falhas.map((f) => `${f.invariante}=${f.valor}`).join(', ') || '(tudo ok)')
  return new Response(JSON.stringify({ ok: true, checks: checks.length, falhas: falhas.map((f) => f.invariante) }),
    { headers: { 'Content-Type': 'application/json' } })
})
