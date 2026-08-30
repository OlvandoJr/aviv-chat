import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@/lib/supabase/server'
import { usuarioAtual }              from '@/lib/api/papel'
import { createClient as createAdminClient } from '@supabase/supabase-js'

const admin = createAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const GRAPH = 'https://graph.facebook.com/v20.0'

/**
 * Conclui o Cadastro Incorporado (Embedded Signup) da Meta.
 *
 * Recebe { code, waba_id, phone_number_id } do fluxo no navegador e faz o lado
 * servidor do protocolo oficial:
 *   1. troca o `code` por um business token (exige META_APP_SECRET — NUNCA no browser);
 *   2. assina o nosso app na WABA (subscribed_apps) para os webhooks chegarem;
 *   3. registra o número na Cloud API (register, com PIN);
 *   4. cria a linha em chat_inboxes já com credenciais e verify_token.
 *
 * Restrito a admin: criar caixa é ato de configuração da plataforma (mesmo gate
 * da tela /inboxes).
 */
export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
    const eu = await usuarioAtual()
    if (eu?.papel !== 'admin') {
      return NextResponse.json({ error: 'Apenas administradores criam caixas de entrada.' }, { status: 403 })
    }

    const appId     = process.env.NEXT_PUBLIC_META_APP_ID
    const appSecret = process.env.META_APP_SECRET
    if (!appId || !appSecret) {
      return NextResponse.json({ error: 'META_APP_SECRET/NEXT_PUBLIC_META_APP_ID não configurados no servidor.' }, { status: 500 })
    }

    const { code, waba_id: wabaIdIn, phone_number_id: phoneNumberIdIn, evento = 'finish' } = await req.json()
    const coex = evento === 'finish_coexistence'
    // waba_id e phone_number_id chegam por postMessage NO MODO POP-UP. No modo
    // redirecionamento não há postMessage — os dois são descobertos a partir do
    // próprio token (debug_token → granular_scopes), logo abaixo.
    if (!code) {
      return NextResponse.json({ error: 'Fluxo incompleto: a Meta não devolveu o código.' }, { status: 400 })
    }

    // 1. code → business token
    const tokenResp = await fetch(
      `${GRAPH}/oauth/access_token?client_id=${appId}&client_secret=${appSecret}&code=${encodeURIComponent(code)}`)
    const tokenJson = await tokenResp.json().catch(() => ({}))
    const accessToken: string | undefined = tokenJson?.access_token
    if (!accessToken) {
      return NextResponse.json({
        error: `Meta recusou a troca do código: ${tokenJson?.error?.message || 'sem detalhes'}`,
      }, { status: 502 })
    }

    // Descoberta da WABA quando ela não veio na sessão (modo redirecionamento):
    // o token do Embedded Signup carrega os ativos concedidos em granular_scopes.
    let wabaId: string = String(wabaIdIn || '')
    if (!wabaId) {
      const dbgResp = await fetch(
        `${GRAPH}/debug_token?input_token=${encodeURIComponent(accessToken)}&access_token=${appId}|${appSecret}`)
      const dbg = await dbgResp.json().catch(() => ({}))
      const escopos: { scope?: string; target_ids?: string[] }[] = dbg?.data?.granular_scopes || []
      const alvo = escopos.find(e => e.scope === 'whatsapp_business_management')
        || escopos.find(e => e.scope === 'whatsapp_business_messaging')
      wabaId = String(alvo?.target_ids?.[0] || '')
      if (!wabaId) {
        return NextResponse.json({
          error: 'Não foi possível identificar a conta do WhatsApp Business concedida. Refaça o cadastro escolhendo a conta até o fim.',
        }, { status: 502 })
      }
    }

    let phoneNumberId: string = String(phoneNumberIdIn || '')
    if (!phoneNumberId) {
      const numsResp = await fetch(`${GRAPH}/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name`,
        { headers: { Authorization: `Bearer ${accessToken}` } })
      const nums = await numsResp.json().catch(() => ({}))
      phoneNumberId = String(nums?.data?.[0]?.id || '')
      if (!phoneNumberId) {
        return NextResponse.json({ error: 'A WABA conectada não tem número de telefone visível.' }, { status: 502 })
      }
    }

    // 2. assina o app na WABA (é o que faz os webhooks desta conta chegarem a nós)
    const subResp = await fetch(`${GRAPH}/${wabaId}/subscribed_apps`, {
      method: 'POST', headers: { Authorization: `Bearer ${accessToken}` },
    })
    const subJson = await subResp.json().catch(() => ({}))
    const avisos: string[] = []
    if (!subResp.ok) avisos.push(`subscribed_apps: ${subJson?.error?.message || 'falhou'}`)

    // 3. registro na Cloud API — SÓ no fluxo padrão. Na coexistência o número já
    // está registrado pelo app do celular; chamar /register dá erro. Em vez disso,
    // confirmamos o estado esperado (is_on_biz_app + CLOUD_API).
    let pin: string | null = null
    let registrou = false
    if (!coex) {
      pin = process.env.META_ES_PIN || String(Math.floor(100000 + Math.random() * 900000))
      const regResp = await fetch(`${GRAPH}/${phoneNumberId}/register`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
      })
      const regJson = await regResp.json().catch(() => ({}))
      registrou = regResp.ok
      if (!regResp.ok) avisos.push(`register: ${regJson?.error?.message || 'falhou'} (se o número já tem PIN de duas etapas, registre pelo painel da Meta)`)
    } else {
      const stResp = await fetch(`${GRAPH}/${phoneNumberId}?fields=is_on_biz_app,platform_type`,
        { headers: { Authorization: `Bearer ${accessToken}` } })
      const st = await stResp.json().catch(() => ({}))
      if (st?.is_on_biz_app !== true || String(st?.platform_type || '').toUpperCase() !== 'CLOUD_API') {
        avisos.push(`estado inesperado do número: is_on_biz_app=${st?.is_on_biz_app}, platform_type=${st?.platform_type}`)
      }
    }

    // Dados do número para nomear a caixa
    const infoResp = await fetch(
      `${GRAPH}/${phoneNumberId}?fields=display_phone_number,verified_name`,
      { headers: { Authorization: `Bearer ${accessToken}` } })
    const info = await infoResp.json().catch(() => ({}))

    // 4. cria a caixa
    const verifyToken = crypto.randomUUID().replace(/-/g, '')
    const { data: inbox, error } = await admin.from('chat_inboxes').insert({
      name:            info?.verified_name || info?.display_phone_number || 'WhatsApp (Cadastro Incorporado)',
      description:     coex ? 'Coexistência — número segue no app do celular' : 'Criada pelo Cadastro Incorporado da Meta',
      phone_number:    String(info?.display_phone_number || '').replace(/\D/g, '') || null,
      phone_number_id: String(phoneNumberId),
      waba_id:         String(wabaId),
      access_token:    accessToken,
      verify_token:    verifyToken,
      is_active:       true,
      connection_mode:   coex ? 'coexistence' : 'cloud_api',
      connection_status: 'connected',
      ...(coex ? { history_share: 'pending', sync_progress: 0 } : {}),
    }).select('id').single()
    if (error || !inbox) {
      return NextResponse.json({ error: `Meta conectada, mas falhou ao salvar a caixa: ${error?.message}` }, { status: 500 })
    }

    // 5. Coexistência: sincronização em DUAS chamadas, nesta ordem, dentro da
    // janela de 24h. REGRA CRÍTICA: cada sync_type só pode ser chamado UMA vez
    // por conexão (repetir exige offboard) — o guard atômico na coluna do
    // request_id impede o segundo disparo; falha de rede devolve a coluna a NULL
    // para permitir nova tentativa (a chamada que falhou não contou na Meta).
    if (coex) {
      const sincronizar = async (syncType: 'smb_app_state_sync' | 'history', col: string) => {
        const { data: claim } = await admin.from('chat_inboxes')
          .update({ [col]: 'aguardando', sync_requested_at: new Date().toISOString() })
          .eq('id', inbox.id).is(col, null).select('id').maybeSingle()
        if (!claim) return                     // já disparado nesta conexão — nunca repetir
        const r = await fetch(`${GRAPH}/${phoneNumberId}/smb_app_data`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', sync_type: syncType }),
        })
        const j = await r.json().catch(() => ({}))
        if (r.ok && j?.request_id) {
          await admin.from('chat_inboxes').update({ [col]: String(j.request_id) }).eq('id', inbox.id)
        } else {
          await admin.from('chat_inboxes').update({ [col]: null }).eq('id', inbox.id)
          avisos.push(`sync ${syncType}: ${j?.error?.message || 'falhou'} — refaça em até 24h pela tela da caixa`)
        }
      }
      await sincronizar('smb_app_state_sync', 'contacts_sync_request_id')
      await sincronizar('history', 'history_sync_request_id')
    }

    return NextResponse.json({ ok: true, inboxId: inbox.id, pin: registrou ? pin : null, coexistencia: coex, avisos })
  } catch (err) {
    console.error('[embedded-signup]', err)
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 })
  }
}
