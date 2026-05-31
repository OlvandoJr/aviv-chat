import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const body = await req.json()

    // Pode vir como apiConfigId (carregar do DB) ou config inline
    let config = body
    if (body.apiConfigId) {
      const { data } = await supabase
        .from('chat_api_configs')
        .select('*')
        .eq('id', body.apiConfigId)
        .single()
      if (!data) throw new Error('API config not found')
      config = {
        method:       data.method,
        url:          data.url,
        headers:      data.headers       || [],
        queryParams:  data.query_params  || [],
        bodyType:     data.body_type,
        body:         data.body_template || '',
        authType:     data.auth_type,
        authConfig:   data.auth_config   || {},
        testVariables: body.testVariables || {},
      }
    }

    const {
      method,
      url,
      headers:      rawHeaders      = [],
      queryParams:  rawQueryParams  = [],
      bodyType      = 'none',
      body:         rawBody         = '',
      authType      = 'none',
      authConfig    = {},
      testVariables = {},
    } = config

    // ── Resolver templates {{variables.X}}, {{env.X}} ────────────────────────
    function resolve(text: string): string {
      if (!text) return ''
      return text
        .replace(/\{\{variables\.([^}]+)\}\}/g, (_, k) => testVariables[k] ?? '')
        .replace(/\{\{env\.([^}]+)\}\}/g,       (_, k) => Deno.env.get(k) ?? '')
        .replace(/\{\{contact\.([^}]+)\}\}/g,   (_, k) => `[${k}]`)
    }

    // ── Autenticação → headers extras ────────────────────────────────────────
    const authHeaders: Record<string, string> = {}
    const authQueryParams: Record<string, string> = {}

    const ac = Object.fromEntries(
      Object.entries(authConfig as Record<string, string>).map(([k, v]) => [k, resolve(v)])
    )

    if (authType === 'basic' && ac.username) {
      authHeaders['Authorization'] = `Basic ${btoa(`${ac.username}:${ac.password ?? ''}`)}`
    } else if (authType === 'bearer' && ac.token) {
      authHeaders['Authorization'] = `Bearer ${ac.token}`
    } else if (authType === 'api_key' && ac.key_name) {
      if (ac.location === 'query') {
        authQueryParams[ac.key_name] = ac.key_value ?? ''
      } else {
        authHeaders[ac.key_name] = ac.key_value ?? ''
      }
    } else if (authType === 'custom_header' && ac.header_name) {
      authHeaders[ac.header_name] = resolve(ac.header_value ?? '')
    }

    // ── Montar URL com query params ───────────────────────────────────────────
    const resolvedUrl = resolve(url)
    const urlObj      = new URL(resolvedUrl)

    for (const p of rawQueryParams as any[]) {
      if (p.enabled && p.key) urlObj.searchParams.set(p.key, resolve(p.value))
    }
    for (const [k, v] of Object.entries(authQueryParams)) {
      urlObj.searchParams.set(k, v)
    }

    // ── Headers ───────────────────────────────────────────────────────────────
    const fetchHeaders: Record<string, string> = { ...authHeaders }
    for (const h of rawHeaders as any[]) {
      if (h.enabled && h.key) fetchHeaders[h.key] = resolve(h.value)
    }

    // ── Body ──────────────────────────────────────────────────────────────────
    let fetchBody: BodyInit | undefined
    if (bodyType === 'json' && rawBody) {
      fetchHeaders['Content-Type'] = 'application/json'
      fetchBody = resolve(rawBody)
    } else if (bodyType === 'urlencoded') {
      fetchHeaders['Content-Type'] = 'application/x-www-form-urlencoded'
      const lines = resolve(rawBody).split('\n')
      const params = new URLSearchParams()
      for (const line of lines) {
        const [k, ...rest] = line.split('=')
        if (k) params.set(k.trim(), rest.join('=').trim())
      }
      fetchBody = params.toString()
    }

    // ── Executar requisição ───────────────────────────────────────────────────
    const start = Date.now()
    let response: Response
    try {
      response = await fetch(urlObj.toString(), {
        method,
        headers: fetchHeaders,
        body:    ['GET', 'HEAD', 'DELETE'].includes(method) ? undefined : fetchBody,
      })
    } catch (fetchErr) {
      return new Response(JSON.stringify({
        ok:          false,
        error:       `Falha de rede: ${String(fetchErr)}`,
        duration_ms: Date.now() - start,
      }), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    const duration = Date.now() - start
    const rawText  = await response.text()

    let responseBody: any = rawText
    try { responseBody = JSON.parse(rawText) } catch { /* keep as text */ }

    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((v, k) => { responseHeaders[k] = v })

    return new Response(JSON.stringify({
      ok:              response.ok,
      status:          response.status,
      status_text:     response.statusText,
      duration_ms:     duration,
      headers:         responseHeaders,
      body:            responseBody,
      body_raw:        typeof responseBody !== 'string' ? undefined : rawText,
      resolved_url:    urlObj.toString(),
    }), {
      status:  200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('test-api-call error:', err)
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status:  500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})
