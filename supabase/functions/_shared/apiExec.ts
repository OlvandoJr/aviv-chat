// Motor de execução de uma integração HTTP configurada (chat_api_configs).
// Compartilhado entre `test-api-call` (teste manual) e `ai-responder` (tool api_call).
// Resolve {{variables.X}} (args do modelo), {{env.X}} (secrets) e {{contact.X}} (dados do contato).

export interface ApiConfigRow {
  method:         string
  url:            string
  headers?:       { key?: string; value?: string; enabled?: boolean }[]
  query_params?:  { key?: string; value?: string; enabled?: boolean }[]
  body_type?:     string          // 'none' | 'json' | 'urlencoded'
  body_template?: string
  auth_type?:     string          // 'none' | 'basic' | 'bearer' | 'api_key' | 'custom_header'
  auth_config?:   Record<string, string>
}

export interface ApiExecContext {
  variables?: Record<string, unknown>   // argumentos vindos do modelo (function args)
  contact?:   Record<string, unknown>   // dados do contato (cpf, email, customer_id, telefone, wa_id...)
}

export interface ApiExecResult {
  ok:           boolean
  status:       number
  body:         unknown
  resolved_url: string
  error?:       string
}

// {{env.X}} só resolve secrets das integrações. Sem isso, quem controla a URL/headers
// consegue exfiltrar QUALQUER variável do ambiente (SERVICE_ROLE_KEY, OPENAI_API_KEY...)
// mandando-a para um servidor próprio. Ao adicionar uma integração nova, inclua o prefixo aqui.
const ENV_PERMITIDAS = /^(SIENGE_|CV_)/

// A function roda com egress livre: sem isso, a URL pode apontar para a rede interna
// ou para o endpoint de metadata da cloud.
const HOSTS_BLOQUEADOS = [
  /^localhost$/i, /^127\./, /^0\./, /^10\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^\[?::1\]?$/,
  /\.internal$/i, /\.local$/i,
]

export async function executeApiConfig(cfg: ApiConfigRow, ctx: ApiExecContext = {}): Promise<ApiExecResult> {
  const vars    = ctx.variables || {}
  const contact = ctx.contact   || {}
  const envBloqueadas: string[] = []

  const resolve = (text: string): string => {
    if (!text) return ''
    return String(text)
      .replace(/\{\{\s*variables\.([^}]+)\s*\}\}/g, (_, k) => String(vars[k.trim()] ?? ''))
      .replace(/\{\{\s*contact\.([^}]+)\s*\}\}/g,   (_, k) => String(contact[k.trim()] ?? ''))
      .replace(/\{\{\s*env\.([^}]+)\s*\}\}/g,       (_, k) => {
        const nome = k.trim()
        if (!ENV_PERMITIDAS.test(nome)) { envBloqueadas.push(nome); return '' }
        return Deno.env.get(nome) ?? ''
      })
  }

  // ── Auth → headers/query extras ──────────────────────────────────────────────
  const authHeaders: Record<string, string> = {}
  const authQuery:   Record<string, string> = {}
  const ac = Object.fromEntries(
    Object.entries(cfg.auth_config || {}).map(([k, v]) => [k, resolve(String(v))]),
  )
  const authType = cfg.auth_type || 'none'
  if (authType === 'basic' && ac.username) {
    authHeaders['Authorization'] = `Basic ${btoa(`${ac.username}:${ac.password ?? ''}`)}`
  } else if (authType === 'bearer' && ac.token) {
    authHeaders['Authorization'] = `Bearer ${ac.token}`
  } else if (authType === 'api_key' && ac.key_name) {
    if (ac.location === 'query') authQuery[ac.key_name] = ac.key_value ?? ''
    else authHeaders[ac.key_name] = ac.key_value ?? ''
  } else if (authType === 'custom_header' && ac.header_name) {
    authHeaders[ac.header_name] = resolve(ac.header_value ?? '')
  }

  // ── URL + query ──────────────────────────────────────────────────────────────
  let urlObj: URL
  try {
    urlObj = new URL(resolve(cfg.url))
  } catch (e) {
    return { ok: false, status: 0, body: null, resolved_url: cfg.url, error: `URL inválida: ${String(e)}` }
  }
  for (const p of cfg.query_params || []) {
    if (p?.enabled !== false && p?.key) urlObj.searchParams.set(p.key, resolve(p.value || ''))
  }
  for (const [k, v] of Object.entries(authQuery)) urlObj.searchParams.set(k, v)

  // ── Headers ──────────────────────────────────────────────────────────────────
  const fetchHeaders: Record<string, string> = { ...authHeaders }
  for (const h of cfg.headers || []) {
    if (h?.enabled !== false && h?.key) fetchHeaders[h.key] = resolve(h.value || '')
  }

  // ── Body ─────────────────────────────────────────────────────────────────────
  const method   = (cfg.method || 'GET').toUpperCase()
  const bodyType = cfg.body_type || 'none'
  let fetchBody: BodyInit | undefined
  if (bodyType === 'json' && cfg.body_template) {
    fetchHeaders['Content-Type'] = 'application/json'
    fetchBody = resolve(cfg.body_template)
  } else if (bodyType === 'urlencoded' && cfg.body_template) {
    fetchHeaders['Content-Type'] = 'application/x-www-form-urlencoded'
    const params = new URLSearchParams()
    for (const line of resolve(cfg.body_template).split('\n')) {
      const [k, ...rest] = line.split('=')
      if (k.trim()) params.set(k.trim(), rest.join('=').trim())
    }
    fetchBody = params.toString()
  }

  // ── Guardas (avaliadas depois de todo o resolve, antes de qualquer egress) ────
  if (envBloqueadas.length) {
    return {
      ok: false, status: 0, body: null, resolved_url: urlObj.toString(),
      error: `Variável de ambiente não liberada para integrações: ${[...new Set(envBloqueadas)].join(', ')}`,
    }
  }
  if (!/^https?:$/.test(urlObj.protocol) || HOSTS_BLOQUEADOS.some((re) => re.test(urlObj.hostname))) {
    return {
      ok: false, status: 0, body: null, resolved_url: urlObj.toString(),
      error: `Destino não permitido: ${urlObj.protocol}//${urlObj.hostname}`,
    }
  }

  // ── Fetch ────────────────────────────────────────────────────────────────────
  let resp: Response
  try {
    resp = await fetch(urlObj.toString(), {
      method,
      headers: fetchHeaders,
      body: ['GET', 'HEAD', 'DELETE'].includes(method) ? undefined : fetchBody,
    })
  } catch (e) {
    return { ok: false, status: 0, body: null, resolved_url: urlObj.toString(), error: `Falha de rede: ${String(e)}` }
  }

  const raw = await resp.text()
  let body: unknown = raw
  try { body = JSON.parse(raw) } catch { /* mantém texto */ }

  return { ok: resp.ok, status: resp.status, body, resolved_url: urlObj.toString() }
}
