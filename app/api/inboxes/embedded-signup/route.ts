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

    const { code, waba_id: wabaId, phone_number_id: phoneNumberId } = await req.json()
    if (!code || !wabaId || !phoneNumberId) {
      return NextResponse.json({
        error: 'Fluxo incompleto: a Meta não devolveu conta/número. Refaça o cadastro até a tela final.',
      }, { status: 400 })
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

    // 2. assina o app na WABA (é o que faz os webhooks desta conta chegarem a nós)
    const subResp = await fetch(`${GRAPH}/${wabaId}/subscribed_apps`, {
      method: 'POST', headers: { Authorization: `Bearer ${accessToken}` },
    })
    const subJson = await subResp.json().catch(() => ({}))
    const avisos: string[] = []
    if (!subResp.ok) avisos.push(`subscribed_apps: ${subJson?.error?.message || 'falhou'}`)

    // 3. registra o número na Cloud API. O PIN é o "two-step" do número — se ele já
    // tinha um PIN definido, a Meta recusa este e o registro fica manual.
    const pin = process.env.META_ES_PIN || String(Math.floor(100000 + Math.random() * 900000))
    const regResp = await fetch(`${GRAPH}/${phoneNumberId}/register`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
    })
    const regJson = await regResp.json().catch(() => ({}))
    if (!regResp.ok) avisos.push(`register: ${regJson?.error?.message || 'falhou'} (se o número já tem PIN de duas etapas, registre pelo painel da Meta)`)

    // Dados do número para nomear a caixa
    const infoResp = await fetch(
      `${GRAPH}/${phoneNumberId}?fields=display_phone_number,verified_name`,
      { headers: { Authorization: `Bearer ${accessToken}` } })
    const info = await infoResp.json().catch(() => ({}))

    // 4. cria a caixa
    const verifyToken = crypto.randomUUID().replace(/-/g, '')
    const { data: inbox, error } = await admin.from('chat_inboxes').insert({
      name:            info?.verified_name || info?.display_phone_number || 'WhatsApp (Cadastro Incorporado)',
      description:     'Criada pelo Cadastro Incorporado da Meta',
      phone_number:    String(info?.display_phone_number || '').replace(/\D/g, '') || null,
      phone_number_id: String(phoneNumberId),
      waba_id:         String(wabaId),
      access_token:    accessToken,
      verify_token:    verifyToken,
      is_active:       true,
    }).select('id').single()
    if (error || !inbox) {
      return NextResponse.json({ error: `Meta conectada, mas falhou ao salvar a caixa: ${error?.message}` }, { status: 500 })
    }

    return NextResponse.json({ ok: true, inboxId: inbox.id, pin: regResp.ok ? pin : null, avisos })
  } catch (err) {
    console.error('[embedded-signup]', err)
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 })
  }
}
