import { NextRequest, NextResponse }            from 'next/server'
import { createServerClient }                   from '@supabase/ssr'
import { createClient as createAdminClient }    from '@supabase/supabase-js'
import { cookies }                              from 'next/headers'

// POST { emitido_id, conversationId } → encaminha o PDF do boleto na conversa.
// Checa a janela de 24h (última msg do cliente). Fechada → { windowClosed: true } (só avisa).

async function getCaller(): Promise<string | null> {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll() { return cookieStore.getAll() }, setAll() {} } }
  )
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: me } = await supabase.from('chat_attendants').select('id').eq('id', user.id).maybeSingle()
  return me ? user.id : null
}

const admin = createAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(req: NextRequest) {
  const userId = await getCaller()
  if (!userId) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const { emitido_id, conversationId } = await req.json()
  if (!emitido_id || !conversationId) {
    return NextResponse.json({ error: 'emitido_id e conversationId são obrigatórios' }, { status: 400 })
  }

  // Boleto + conversa + contato + inbox
  const { data: b } = await admin
    .from('boletos_emitidos')
    .select('pdf_path, linha_digitavel, vencimento')
    .eq('id', emitido_id).maybeSingle()
  if (!b?.pdf_path) return NextResponse.json({ error: 'Boleto sem PDF no banco' }, { status: 404 })

  const { data: conv } = await admin
    .from('chat_conversations')
    .select('id, inbox_id, contact:chat_contacts(wa_id)')
    .eq('id', conversationId).maybeSingle()
  if (!conv?.inbox_id) return NextResponse.json({ error: 'Conversa não encontrada' }, { status: 404 })
  const toWaId = (conv.contact as any)?.wa_id
  if (!toWaId) return NextResponse.json({ error: 'Contato sem WhatsApp' }, { status: 404 })

  // ── Janela de 24h: última mensagem recebida do cliente ──────────────────────
  const { data: lastIn } = await admin
    .from('chat_messages')
    .select('created_at')
    .eq('conversation_id', conversationId)
    .eq('direction', 'in')
    .order('created_at', { ascending: false })
    .limit(1).maybeSingle()
  const lastInMs = lastIn?.created_at ? new Date(lastIn.created_at).getTime() : 0
  const windowOpen = lastInMs > 0 && (Date.now() - lastInMs) < 24 * 60 * 60 * 1000
  if (!windowOpen) return NextResponse.json({ windowClosed: true })

  // Inbox creds
  const { data: inbox } = await admin
    .from('chat_inboxes').select('access_token, phone_number_id').eq('id', conv.inbox_id).maybeSingle()
  if (!inbox?.access_token || !inbox?.phone_number_id) {
    return NextResponse.json({ error: 'Inbox sem credenciais' }, { status: 500 })
  }

  // 1) Baixar o PDF (signed URL do bucket privado)
  const { data: signed } = await admin.storage.from('boletos').createSignedUrl(b.pdf_path, 120)
  if (!signed?.signedUrl) return NextResponse.json({ error: 'Falha ao ler o PDF' }, { status: 500 })
  const pdfResp = await fetch(signed.signedUrl)
  if (!pdfResp.ok) return NextResponse.json({ error: 'Falha ao baixar o PDF' }, { status: 500 })
  const pdfBytes = new Uint8Array(await pdfResp.arrayBuffer())

  // 2) Subir em chat-media (público → URL permanente p/ o WhatsApp e o histórico)
  const path = `chat/${conversationId}/boleto-${Date.now()}.pdf`
  const { error: upErr } = await admin.storage
    .from('chat-media').upload(path, pdfBytes, { contentType: 'application/pdf', upsert: true })
  if (upErr) return NextResponse.json({ error: 'Falha ao preparar o arquivo' }, { status: 500 })
  const { data: { publicUrl } } = admin.storage.from('chat-media').getPublicUrl(path)

  // 3) Enviar como documento via WhatsApp
  const vencBR = b.vencimento ? new Date(b.vencimento).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : ''
  const filename = `Boleto ${vencBR}.pdf`.replace(/[\/\\]/g, '-')
  const sendResp = await fetch(
    `https://graph.facebook.com/v20.0/${inbox.phone_number_id}/messages`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${inbox.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to: toWaId, type: 'document',
        document: { link: publicUrl, filename },
      }),
    }
  )
  if (!sendResp.ok) {
    const err = await sendResp.json().catch(() => ({}))
    // Erro 131047 = janela fechada (caso a checagem acima não pegue)
    if (err?.error?.code === 131047) return NextResponse.json({ windowClosed: true })
    return NextResponse.json({ error: err?.error?.message || 'Falha ao enviar' }, { status: 502 })
  }
  const waMessageId = (await sendResp.json()).messages?.[0]?.id ?? null

  // 4) Registrar no histórico + atualizar conversa
  await admin.from('chat_messages').insert({
    conversation_id: conversationId,
    wa_message_id:   waMessageId,
    direction:       'out',
    type:            'document',
    content:         null,
    media_url:       publicUrl,
    media_mime_type: 'application/pdf',
    media_filename:  filename,
    wa_status:       'sent',
    attendant_id:    userId,
    metadata:        { sent_by: 'central', kind: 'boleto_central' },
  })
  await admin.from('chat_conversations').update({
    last_message_at: new Date().toISOString(),
    last_message_preview: `[Documento] ${filename}`,
  }).eq('id', conversationId)

  return NextResponse.json({ ok: true, linha_digitavel: b.linha_digitavel || null })
}
