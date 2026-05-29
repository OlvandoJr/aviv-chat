import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  // Verificar autenticação do atendente
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return new Response('Unauthorized', { status: 401 })
  }

  const token = authHeader.replace('Bearer ', '')
  const { data: { user }, error: authError } = await supabase.auth.getUser(token)
  if (authError || !user) {
    return new Response('Unauthorized', { status: 401 })
  }

  const { conversationId, text } = await req.json()
  if (!conversationId || !text?.trim()) {
    return new Response(JSON.stringify({ error: 'conversationId e text são obrigatórios' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Buscar conversa + contato + inbox
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
    return new Response(JSON.stringify({ error: 'Conversa não encontrada' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const contact = conv.contact as any
  const inbox   = conv.inbox   as any

  // Enviar mensagem pela Meta API
  const metaResponse = await fetch(
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
        text:              { body: text },
      }),
    }
  )

  if (!metaResponse.ok) {
    const err = await metaResponse.text()
    console.error('Meta API error:', err)
    return new Response(JSON.stringify({ error: 'Erro ao enviar mensagem', detail: err }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const metaData = await metaResponse.json()
  const waMessageId = metaData.messages?.[0]?.id

  // Buscar atendente
  const { data: attendant } = await supabase
    .from('chat_attendants')
    .select('id')
    .eq('id', user.id)
    .single()

  // Salvar mensagem no banco
  const now = new Date().toISOString()
  const { data: msg } = await supabase
    .from('chat_messages')
    .insert({
      conversation_id: conversationId,
      wa_message_id:   waMessageId,
      direction:       'out',
      type:            'text',
      content:         text,
      wa_status:       'sent',
      attendant_id:    attendant?.id || null,
    })
    .select('id, created_at')
    .single()

  // Atualizar conversa
  await supabase
    .from('chat_conversations')
    .update({
      last_message_at:      now,
      last_message_preview: text,
      unread_count:         0,
    })
    .eq('id', conversationId)

  return new Response(JSON.stringify({ ok: true, message: msg }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})
