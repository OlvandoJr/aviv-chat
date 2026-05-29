import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

Deno.serve(async (req) => {
  // ── Verificação do webhook (GET da Meta) ─────────────────
  if (req.method === 'GET') {
    const url = new URL(req.url)
    const mode      = url.searchParams.get('hub.mode')
    const token     = url.searchParams.get('hub.verify_token')
    const challenge = url.searchParams.get('hub.challenge')

    const { data: inbox } = await supabase
      .from('chat_inboxes')
      .select('verify_token')
      .eq('verify_token', token)
      .single()

    if (mode === 'subscribe' && inbox) {
      return new Response(challenge, { status: 200 })
    }
    return new Response('Forbidden', { status: 403 })
  }

  // ── Recebimento de mensagem (POST da Meta) ───────────────
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  // Validar assinatura HMAC (opcional mas recomendado)
  const body = await req.text()
  let payload: any
  try {
    payload = JSON.parse(body)
  } catch {
    return new Response('Bad Request', { status: 400 })
  }

  // Responder IMEDIATAMENTE para a Meta (< 5 segundos)
  const responsePromise = new Response('OK', { status: 200 })

  // Processar em background
  ;(async () => {
    try {
      const entry   = payload.entry?.[0]
      const change  = entry?.changes?.[0]
      const value   = change?.value
      if (!value) return

      const phoneNumberId = value.metadata?.phone_number_id
      if (!phoneNumberId) return

      // Buscar inbox
      const { data: inbox } = await supabase
        .from('chat_inboxes')
        .select('id')
        .eq('phone_number_id', phoneNumberId)
        .single()
      if (!inbox) return

      // Processar status updates (mensagens entregues/lidas)
      const statuses = value.statuses || []
      for (const status of statuses) {
        await supabase
          .from('chat_messages')
          .update({ wa_status: status.status })
          .eq('wa_message_id', status.id)
      }

      // Processar mensagens recebidas
      const messages = value.messages || []
      for (const msg of messages) {
        await processMessage(msg, value, inbox.id)
      }
    } catch (err) {
      console.error('Webhook processing error:', err)
    }
  })()

  return responsePromise
})

async function processMessage(msg: any, value: any, inboxId: string) {
  const waId      = msg.from
  const msgType   = msg.type
  const msgId     = msg.id
  const timestamp = new Date(parseInt(msg.timestamp) * 1000).toISOString()

  // Upsert contato
  const contactName = value.contacts?.[0]?.profile?.name || waId
  const { data: contact, error: contactErr } = await supabase
    .from('chat_contacts')
    .upsert({ wa_id: waId, name: contactName }, { onConflict: 'wa_id' })
    .select('id')
    .single()
  if (contactErr || !contact) {
    console.error('Contact upsert error:', contactErr)
    return
  }

  // Buscar ou criar conversa aberta
  let { data: conversation } = await supabase
    .from('chat_conversations')
    .select('id')
    .eq('contact_id', contact.id)
    .eq('inbox_id', inboxId)
    .not('status', 'eq', 'archived')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (!conversation) {
    const { data: newConv } = await supabase
      .from('chat_conversations')
      .insert({
        inbox_id:   inboxId,
        contact_id: contact.id,
        status:     'open',
      })
      .select('id')
      .single()
    conversation = newConv
  }
  if (!conversation) return

  // Extrair conteúdo da mensagem
  let content: string | null = null
  let mediaId: string | null = null
  let mimeType: string | null = null
  let filename: string | null = null

  switch (msgType) {
    case 'text':
      content = msg.text?.body || null
      break
    case 'image':
      mediaId  = msg.image?.id || null
      mimeType = msg.image?.mime_type || null
      content  = msg.image?.caption || null
      break
    case 'audio':
      mediaId  = msg.audio?.id || null
      mimeType = msg.audio?.mime_type || null
      break
    case 'document':
      mediaId   = msg.document?.id || null
      mimeType  = msg.document?.mime_type || null
      filename  = msg.document?.filename || null
      content   = msg.document?.caption || null
      break
    case 'button':
      content = msg.button?.text || null
      break
    default:
      content = JSON.stringify(msg[msgType] || {})
  }

  const preview = content || `[${msgType}]`

  // Inserir mensagem
  const { data: message } = await supabase
    .from('chat_messages')
    .insert({
      conversation_id: conversation.id,
      wa_message_id:   msgId,
      direction:       'in',
      type:            msgType,
      content,
      media_mime_type: mimeType,
      media_filename:  filename,
      metadata:        mediaId ? { wa_media_id: mediaId } : null,
      created_at:      timestamp,
    })
    .select('id')
    .single()

  // Atualizar conversa
  await supabase
    .from('chat_conversations')
    .update({
      last_message_at:      timestamp,
      last_message_preview: preview,
      unread_count:         supabase.rpc('increment_unread', { conv_id: conversation.id }) as any,
      status:               'open',
    })
    .eq('id', conversation.id)

  // Atualizar unread_count direto
  await supabase.rpc('chat_increment_unread', { conv_id: conversation.id })

  // Disparar processamento de mídia em background
  if (mediaId && message) {
    await supabase.functions.invoke('process-media', {
      body: {
        messageId:   message.id,
        waMediaId:   mediaId,
        mimeType,
        msgType,
        convId:      conversation.id,
        contactWaId: waId,
      },
    })
  }
}
