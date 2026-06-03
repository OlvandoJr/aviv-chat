import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

// ── CORS — necessário porque esta função é chamada diretamente do browser ─────
const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  // Preflight CORS — o browser manda OPTIONS antes de qualquer POST cross-origin
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: corsHeaders })
  }

  // ── Autenticação do atendente ─────────────────────────────────────────────
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return json({ error: 'Unauthorized' }, 401)
  }

  const token = authHeader.replace('Bearer ', '')
  const { data: { user }, error: authError } = await supabase.auth.getUser(token)
  if (authError || !user) {
    return json({ error: 'Unauthorized' }, 401)
  }

  const { conversationId, text } = await req.json()
  if (!conversationId || !text?.trim()) {
    return json({ error: 'conversationId e text são obrigatórios' }, 400)
  }

  // ── Buscar conversa + contato + inbox ─────────────────────────────────────
  const { data: conv, error: convErr } = await supabase
    .from('chat_conversations')
    .select(`
      id,
      contact:chat_contacts(wa_id),
      inbox:chat_inboxes(phone_number_id, access_token)
    `)
    .eq('id', conversationId)
    .single()

  if (convErr || !conv) {
    return json({ error: 'Conversa não encontrada' }, 404)
  }

  const contact = conv.contact as any
  const inbox   = conv.inbox   as any

  if (!inbox?.phone_number_id || !inbox?.access_token) {
    console.error('Inbox sem credenciais para conversa', conversationId)
    return json({ error: 'Inbox sem credenciais configuradas' }, 422)
  }

  if (!contact?.wa_id) {
    return json({ error: 'Contato sem WhatsApp ID' }, 422)
  }

  // ── Buscar nome do atendente antes de enviar ─────────────────────────────
  // (precisa antes do fetch para ter o nome no prefixo)
  const { data: attendantPre } = await supabase
    .from('chat_attendants')
    .select('id, name')
    .eq('id', user.id)
    .maybeSingle()

  // Texto que o cliente recebe: "Nome:\nmensagem"
  const textToSend = attendantPre?.name
    ? `${attendantPre.name}:\n${text}`
    : text

  // ── Enviar pela Meta API ───────────────────────────────────────────────────
  const metaResp = await fetch(
    `https://graph.facebook.com/v20.0/${inbox.phone_number_id}/messages`,
    {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${inbox.access_token}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type:    'individual',
        to:                contact.wa_id,
        type:              'text',
        text:              { body: textToSend },
      }),
    }
  )

  if (!metaResp.ok) {
    const errBody = await metaResp.json().catch(() => ({}))
    const errCode = errBody?.error?.code

    // ── Janela de 24h fechada (131047) ────────────────────────────────────
    if (errCode === 131047) {
      // Inserir mensagem de sistema na conversa para notificar o atendente
      await supabase.from('chat_messages').insert({
        conversation_id: conversationId,
        direction:       'out',
        type:            'unknown',
        content:         'WINDOW_CLOSED',
        wa_status:       'failed',
        attendant_id:    attendantPre?.id || null,
        metadata:        { system_type: 'window_closed' },
      })
      await supabase.from('chat_conversations').update({
        last_message_at:      new Date().toISOString(),
        last_message_preview: '⚠️ Janela de conversa fechada',
      }).eq('id', conversationId)
      return json({ ok: false, windowClosed: true }, 200)
    }

    console.error('Meta API error:', metaResp.status, errBody)
    return json({ error: 'Erro ao enviar mensagem pelo WhatsApp', detail: errBody }, 502)
  }

  const metaData   = await metaResp.json()
  const waMessageId = metaData.messages?.[0]?.id || null

  // ── Salvar mensagem (texto original, sem prefixo — o badge já mostra o nome) ──
  const now = new Date().toISOString()
  const { data: msg, error: msgErr } = await supabase
    .from('chat_messages')
    .insert({
      conversation_id: conversationId,
      wa_message_id:   waMessageId,
      direction:       'out',
      type:            'text',
      content:         text,
      wa_status:       'sent',
      attendant_id:    attendantPre?.id || null,
    })
    .select('id, created_at')
    .single()

  if (msgErr) console.error('Insert message error:', JSON.stringify(msgErr))

  // ── Atualizar conversa ────────────────────────────────────────────────────
  await supabase
    .from('chat_conversations')
    .update({
      last_message_at:      now,
      last_message_preview: text.substring(0, 120),
      unread_count:         0,
    })
    .eq('id', conversationId)

  return json({ ok: true, message: msg, waMessageId })
})
