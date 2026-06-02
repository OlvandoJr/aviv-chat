import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

// ── Service-role client para storage e gravações sem RLS ─────────────────────
// SUPABASE_SERVICE_ROLE_KEY é server-only (.env.local) — nunca exposto ao browser
const adminSupabase = createAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(req: NextRequest) {
  try {
    // ── Autenticação via cookie de sessão ─────────────────────────────────
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Buscar nome do atendente para prefixar a legenda enviada ao cliente
    const { data: attendantRow } = await adminSupabase
      .from('chat_attendants')
      .select('name')
      .eq('id', user.id)
      .maybeSingle()
    const senderName = attendantRow?.name as string | null

    // ── Payload ───────────────────────────────────────────────────────────
    const formData       = await req.formData()
    const file           = formData.get('file') as File | null
    const conversationId = formData.get('conversationId') as string | null
    const caption        = formData.get('caption') as string | null

    if (!file || !conversationId) {
      return NextResponse.json({ error: 'Parâmetros obrigatórios: file, conversationId' }, { status: 400 })
    }

    // ── Buscar conversa → inbox → contato ─────────────────────────────────
    const { data: conv } = await adminSupabase
      .from('chat_conversations')
      .select('id, inbox:chat_inboxes(phone_number_id, access_token), contact:chat_contacts(wa_id)')
      .eq('id', conversationId)
      .single()

    if (!conv) return NextResponse.json({ error: 'Conversa não encontrada' }, { status: 404 })

    const inbox   = conv.inbox   as unknown as { phone_number_id: string; access_token: string } | null
    const contact = conv.contact as unknown as { wa_id: string } | null

    if (!inbox?.phone_number_id || !inbox?.access_token) {
      return NextResponse.json({ error: 'Inbox não configurada' }, { status: 404 })
    }
    if (!contact?.wa_id) {
      return NextResponse.json({ error: 'Contato sem número WhatsApp' }, { status: 404 })
    }

    const { phone_number_id, access_token } = inbox
    const waId = contact.wa_id

    // ── Tipo de mensagem pelo MIME ────────────────────────────────────────
    const mime = file.type || 'application/octet-stream'
    type WaMsgType = 'image' | 'video' | 'audio' | 'document'
    let msgType: WaMsgType
    if      (mime.startsWith('image/'))  msgType = 'image'
    else if (mime.startsWith('video/'))  msgType = 'video'
    else if (mime.startsWith('audio/'))  msgType = 'audio'
    else                                 msgType = 'document'

    const safeName = file.name || `file-${Date.now()}.${mime.split('/')[1] || 'bin'}`

    // ── 1. Upload do arquivo para a API de mídia do WhatsApp ──────────────
    const uploadForm = new FormData()
    uploadForm.append('file', file, safeName)
    uploadForm.append('type', mime)
    uploadForm.append('messaging_product', 'whatsapp')

    const uploadResp = await fetch(
      `https://graph.facebook.com/v20.0/${phone_number_id}/media`,
      {
        method:  'POST',
        headers: { Authorization: `Bearer ${access_token}` },
        body:    uploadForm,
      }
    )

    if (!uploadResp.ok) {
      const err = await uploadResp.json().catch(() => ({}))
      console.error('[send-media] WhatsApp upload error:', err)
      return NextResponse.json({ error: 'Falha ao enviar mídia ao WhatsApp', details: err }, { status: 502 })
    }

    const { id: mediaId } = await uploadResp.json()

    // ── 2. Enviar mensagem WhatsApp com o media_id ────────────────────────
    const msgPayload: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      to:                waId,
      type:              msgType,
    }

    // Caption com prefixo do nome do atendente (ex: "Olvando:\nLegenda aqui")
    const captionForWA = caption
      ? (senderName ? `${senderName}:\n${caption}` : caption)
      : undefined

    if      (msgType === 'image')    msgPayload.image    = { id: mediaId, ...(captionForWA ? { caption: captionForWA } : {}) }
    else if (msgType === 'video')    msgPayload.video    = { id: mediaId, ...(captionForWA ? { caption: captionForWA } : {}) }
    else if (msgType === 'audio')    msgPayload.audio    = { id: mediaId }
    else                             msgPayload.document = { id: mediaId, filename: safeName, ...(captionForWA ? { caption: captionForWA } : {}) }

    const sendResp = await fetch(
      `https://graph.facebook.com/v20.0/${phone_number_id}/messages`,
      {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(msgPayload),
      }
    )

    if (!sendResp.ok) {
      const err = await sendResp.json().catch(() => ({}))
      console.error('[send-media] WhatsApp send error:', err)
      return NextResponse.json({ error: 'Falha ao enviar mensagem WhatsApp', details: err }, { status: 502 })
    }

    const sendData    = await sendResp.json()
    const waMessageId = sendData.messages?.[0]?.id ?? null
    const now         = new Date().toISOString()

    // ── 3. Tentar fazer upload no Supabase Storage para preview in-chat ───
    let mediaUrl: string | null = null
    try {
      const ext         = safeName.split('.').pop() || 'bin'
      const storagePath = `${conversationId}/${Date.now()}.${ext}`
      const fileBytes   = await file.arrayBuffer()

      const { error: storageErr } = await adminSupabase.storage
        .from('chat-media')
        .upload(storagePath, fileBytes, { contentType: mime, upsert: false })

      if (!storageErr) {
        const { data: { publicUrl } } = adminSupabase.storage
          .from('chat-media')
          .getPublicUrl(storagePath)
        mediaUrl = publicUrl
      } else {
        console.warn('[send-media] storage skipped:', storageErr.message)
      }
    } catch (storageEx) {
      console.warn('[send-media] storage exception:', storageEx)
    }

    // ── 4. Gravar mensagem no banco ───────────────────────────────────────
    await adminSupabase.from('chat_messages').insert({
      conversation_id: conversationId,
      wa_message_id:   waMessageId,
      direction:       'out',
      type:            msgType,
      content:         caption || null,
      media_url:       mediaUrl,
      media_mime_type: mime,
      media_filename:  (msgType === 'document' || msgType === 'audio') ? safeName : null,
      wa_status:       'sent',
      attendant_id:    user.id,
    })

    await adminSupabase.from('chat_conversations').update({
      last_message_at:      now,
      last_message_preview: caption || `[${msgType}]`,
      status:               'open',
    }).eq('id', conversationId)

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[send-media] unhandled error:', err)
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 })
  }
}
