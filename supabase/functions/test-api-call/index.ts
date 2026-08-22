import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { executeApiConfig, type ApiConfigRow } from '../_shared/apiExec.ts'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

/**
 * Esta função executa uma requisição HTTP arbitrária resolvendo {{env.*}} — ou seja,
 * com as credenciais do Sienge/CV CRM em mãos. `verify_jwt` sozinho NÃO protege: a
 * anon key é um JWT válido e é pública (vai no bundle do frontend). Sem a checagem
 * abaixo, qualquer um poderia usá-la como proxy autenticado.
 *
 * Só passam usuários logados (role=authenticated) e chamadas internas (service_role).
 */
const ROLES_PERMITIDAS = new Set(['authenticated', 'service_role'])

function roleDoChamador(req: Request): string | null {
  const m = (req.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i)
  if (!m) return null
  const partes = m[1].split('.')
  if (partes.length !== 3) return null
  try {
    const b64 = partes[1].replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)))
    return typeof payload?.role === 'string' ? payload.role : null
  } catch {
    return null
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const role = roleDoChamador(req)
  if (!role || !ROLES_PERMITIDAS.has(role)) {
    console.warn('test-api-call: chamada recusada, role =', role)
    return new Response(
      JSON.stringify({ ok: false, error: 'Não autorizado: requer sessão de usuário logado.' }),
      { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } },
    )
  }

  try {
    const body = await req.json()

    // Pode vir como apiConfigId (carregar do DB) ou config inline (nomes do builder)
    let row: ApiConfigRow
    if (body.apiConfigId) {
      const { data } = await supabase.from('chat_api_configs').select('*').eq('id', body.apiConfigId).single()
      if (!data) throw new Error('API config not found')
      row = {
        method:        data.method,
        url:           data.url,
        headers:       data.headers       || [],
        query_params:  data.query_params  || [],
        body_type:     data.body_type,
        body_template: data.body_template || '',
        auth_type:     data.auth_type,
        auth_config:   data.auth_config   || {},
      }
    } else {
      row = {
        method:        body.method,
        url:           body.url,
        headers:       body.headers      || [],
        query_params:  body.queryParams  || [],
        body_type:     body.bodyType      || 'none',
        body_template: body.body          || '',
        auth_type:     body.authType      || 'none',
        auth_config:   body.authConfig    || {},
      }
    }

    const start = Date.now()
    const result = await executeApiConfig(row, { variables: body.testVariables || {} })
    const duration = Date.now() - start

    if (result.error) {
      return new Response(JSON.stringify({ ok: false, error: result.error, duration_ms: duration }),
        { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    return new Response(JSON.stringify({
      ok:           result.ok,
      status:       result.status,
      duration_ms:  duration,
      body:         result.body,
      resolved_url: result.resolved_url,
    }), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } })
  } catch (err) {
    console.error('test-api-call error:', err)
    return new Response(JSON.stringify({ ok: false, error: String(err) }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }
})
