/**
 * Núcleo de envio de template WhatsApp (Meta Cloud API) — reutilizado por
 * /api/send-template (manual), campanhas e régua.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

const GRAPH = 'https://graph.facebook.com/v20.0'

export interface InboxCreds {
  phone_number_id: string
  access_token: string
}

export interface TemplateRow {
  id: string
  name: string
  language: string
  header_text: string | null
  header_var_count: number
  body_var_count: number
  body_text: string
}

export interface SendResult {
  ok: boolean
  waMessageId: string | null
  error?: any
}

/** Monta os components (header/body) com as variáveis na ordem posicional. */
export function buildTemplateComponents(tpl: TemplateRow, variables: string[]): any[] {
  const components: any[] = []
  if (tpl.header_var_count > 0 && tpl.header_text) {
    const headerVars = variables.slice(0, tpl.header_var_count)
    components.push({
      type: 'header',
      parameters: headerVars.map((v) => ({ type: 'text', text: v })),
    })
  }
  if (tpl.body_var_count > 0) {
    const bodyVars = variables.slice(tpl.header_var_count)
    components.push({
      type: 'body',
      parameters: bodyVars.map((v) => ({ type: 'text', text: v })),
    })
  }
  return components
}

function renderTemplateText(text: string, vars: string[]): string {
  let out = text || ''
  vars.forEach((v, i) => {
    out = out.replace(new RegExp(`\\{\\{${i + 1}\\}\\}`, 'g'), v)
  })
  return out
}

export interface SendTemplateArgs {
  admin: SupabaseClient
  inbox: InboxCreds
  toWaId: string
  tpl: TemplateRow
  variables: string[]
  conversationId: string
  /** prefixo no histórico (nome do atendente); omitir para disparos automáticos */
  sentBy?: string
  attendantId?: string | null
  /** chaves extras no metadata da mensagem (ex: campaign_id, regua_id) */
  metaExtra?: Record<string, any>
}

/**
 * Envia o template via Meta, grava em chat_messages (type='template') e
 * atualiza chat_conversations. Não lança — retorna { ok, waMessageId, error }.
 */
export async function sendTemplateMessage(args: SendTemplateArgs): Promise<SendResult> {
  const { admin, inbox, toWaId, tpl, variables, conversationId } = args

  const components = buildTemplateComponents(tpl, variables)
  const payload: any = {
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
      headers: {
        Authorization: `Bearer ${inbox.access_token}`,
        'Content-Type': 'application/json',
      },
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
    metadata: {
      template_id: tpl.id,
      template_name: tpl.name,
      variables,
      ...(args.metaExtra || {}),
    },
  })

  await admin
    .from('chat_conversations')
    .update({
      last_message_at: now,
      last_message_preview: `[Template] ${tpl.name}`,
      status: 'open',
    })
    .eq('id', conversationId)

  return { ok: true, waMessageId }
}
