/**
 * Núcleo de envio de template WhatsApp para Edge Functions (Deno).
 * Espelha lib/whatsapp/* do lado Next. Usado por dispatch-campaign e cobranca-regua.
 */

const GRAPH = 'https://graph.facebook.com/v20.0'

export interface InboxCreds { phone_number_id: string; access_token: string }

export interface TemplateRow {
  id: string
  name: string
  language: string
  header_text: string | null
  header_var_count: number
  body_var_count: number
  body_text: string
}

export interface SendResult { ok: boolean; waMessageId: string | null; error?: unknown }

// ── Variáveis ────────────────────────────────────────────────────────────────
export type VarSource =
  | { type: 'static'; value: string }
  | { type: 'column'; value: string; format?: 'currency' | 'date' | 'text' }
export type VariableMapping = Record<string, VarSource>

export function formatValue(raw: unknown, format?: string): string {
  if (raw == null) return ''
  if (format === 'currency') {
    const n = typeof raw === 'number' ? raw : parseFloat(String(raw))
    if (isNaN(n)) return ''
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n)
  }
  if (format === 'date') {
    const d = new Date(raw as string)
    if (isNaN(d.getTime())) return String(raw)
    return d.toLocaleDateString('pt-BR', { timeZone: 'UTC' })
  }
  return String(raw)
}

export function resolveVariables(
  mapping: VariableMapping | null | undefined,
  row: Record<string, unknown>,
): string[] {
  if (!mapping) return []
  const nums = Object.keys(mapping).map(Number).filter((n) => !isNaN(n)).sort((a, b) => a - b)
  if (nums.length === 0) return []
  const max = nums[nums.length - 1]
  const out: string[] = []
  for (let i = 1; i <= max; i++) {
    const src = mapping[String(i)]
    if (!src) { out.push(''); continue }
    if (src.type === 'static') { out.push(src.value ?? ''); continue }
    out.push(formatValue(row?.[src.value], src.format))
  }
  return out
}

// ── Envio ────────────────────────────────────────────────────────────────────
export function buildTemplateComponents(tpl: TemplateRow, variables: string[]): unknown[] {
  const components: unknown[] = []
  if (tpl.header_var_count > 0 && tpl.header_text) {
    components.push({
      type: 'header',
      parameters: variables.slice(0, tpl.header_var_count).map((v) => ({ type: 'text', text: v })),
    })
  }
  if (tpl.body_var_count > 0) {
    components.push({
      type: 'body',
      parameters: variables.slice(tpl.header_var_count).map((v) => ({ type: 'text', text: v })),
    })
  }
  return components
}

function renderTemplateText(text: string, vars: string[]): string {
  let out = text || ''
  vars.forEach((v, i) => { out = out.replace(new RegExp(`\\{\\{${i + 1}\\}\\}`, 'g'), v) })
  return out
}

export interface SendTemplateArgs {
  // deno-lint-ignore no-explicit-any
  admin: any
  inbox: InboxCreds
  toWaId: string
  tpl: TemplateRow
  variables: string[]
  conversationId: string
  sentBy?: string
  attendantId?: string | null
  metaExtra?: Record<string, unknown>
}

export async function sendTemplateMessage(args: SendTemplateArgs): Promise<SendResult> {
  const { admin, inbox, toWaId, tpl, variables, conversationId } = args
  const components = buildTemplateComponents(tpl, variables)
  const payload = {
    messaging_product: 'whatsapp',
    to: toWaId,
    type: 'template',
    template: {
      name: tpl.name,
      language: { code: tpl.language },
      ...(components.length ? { components } : {}),
    },
  }

  let resp: Response
  try {
    resp = await fetch(`${GRAPH}/${inbox.phone_number_id}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${inbox.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (err) {
    return { ok: false, waMessageId: null, error: String(err) }
  }

  if (!resp.ok) {
    const error = await resp.json().catch(() => ({}))
    return { ok: false, waMessageId: null, error }
  }

  const data = await resp.json()
  const waMessageId = data.messages?.[0]?.id ?? null
  const now = new Date().toISOString()
  const rendered = renderTemplateText(tpl.body_text, variables)
  const content = args.sentBy ? `${args.sentBy}:\n${rendered}` : rendered

  await admin.from('chat_messages').insert({
    conversation_id: conversationId,
    wa_message_id: waMessageId,
    direction: 'out',
    type: 'template',
    content,
    wa_status: 'sent',
    attendant_id: args.attendantId ?? null,
    metadata: { template_id: tpl.id, template_name: tpl.name, variables, ...(args.metaExtra || {}) },
  })

  await admin.from('chat_conversations').update({
    last_message_at: now,
    last_message_preview: `[Template] ${tpl.name}`,
    status: 'open',
  }).eq('id', conversationId)

  return { ok: true, waMessageId }
}

// ── Início de conversa ───────────────────────────────────────────────────────
// Agente de cobrança (Vivi) — as threads abertas pelos disparos de cobrança ficam com ela,
// para o roteamento por origem funcionar mesmo com outro agente atendendo a entrada fria.
export const COBRANCA_AGENT_ID = 'ead82b93-84c8-49bf-98bb-53d395b49ba7'

export async function ensureConversation(
  // deno-lint-ignore no-explicit-any
  admin: any,
  inboxId: string,
  waId: string,
  name?: string,
  agentId: string | null = COBRANCA_AGENT_ID,
): Promise<{ conversationId: string; contactId: string } | null> {
  const { data: contact, error: cErr } = await admin
    .from('chat_contacts')
    .upsert({ wa_id: waId, ...(name ? { name } : {}) }, { onConflict: 'wa_id' })
    .select('id')
    .single()
  if (cErr || !contact) return null

  let { data: conv } = await admin
    .from('chat_conversations')
    .select('id')
    .eq('contact_id', contact.id)
    .eq('inbox_id', inboxId)
    .not('status', 'eq', 'archived')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!conv) {
    const { data: newConv } = await admin
      .from('chat_conversations')
      .insert({ inbox_id: inboxId, contact_id: contact.id, status: 'open', ...(agentId ? { agent_id: agentId } : {}) })
      .select('id')
      .single()
    conv = newConv
  } else if (agentId) {
    // Mantém a thread de cobrança com a Vivi (só preenche se ainda não tem agente)
    await admin.from('chat_conversations').update({ agent_id: agentId }).eq('id', conv.id).is('agent_id', null)
  }
  if (!conv) return null
  return { conversationId: conv.id, contactId: contact.id }
}

const SLEEP = (ms: number) => new Promise((r) => setTimeout(r, ms))
export { SLEEP }
