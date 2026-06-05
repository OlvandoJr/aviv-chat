import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { sendTemplateMessage }       from '@/lib/whatsapp/send'

const admin = createAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

    const { data: me } = await supabase
      .from('chat_attendants')
      .select('id, name')
      .eq('id', user.id)
      .single()

    const { conversationId, templateId, variables = [] } = await req.json()
    if (!conversationId || !templateId) {
      return NextResponse.json({ error: 'conversationId e templateId são obrigatórios' }, { status: 400 })
    }

    // Buscar template
    const { data: tpl } = await admin
      .from('chat_wa_templates')
      .select('*')
      .eq('id', templateId)
      .single()

    if (!tpl) return NextResponse.json({ error: 'Template não encontrado' }, { status: 404 })
    if (tpl.status !== 'APPROVED') {
      return NextResponse.json({ error: 'Template não aprovado pela Meta' }, { status: 422 })
    }

    // Buscar conversa → inbox → contato
    const { data: conv } = await admin
      .from('chat_conversations')
      .select('id, inbox:chat_inboxes(phone_number_id, access_token), contact:chat_contacts(wa_id)')
      .eq('id', conversationId)
      .single()

    if (!conv) return NextResponse.json({ error: 'Conversa não encontrada' }, { status: 404 })

    const inbox   = conv.inbox   as any
    const contact = conv.contact as any

    if (!inbox?.phone_number_id || !contact?.wa_id) {
      return NextResponse.json({ error: 'Inbox ou contato inválido' }, { status: 422 })
    }

    const result = await sendTemplateMessage({
      admin,
      inbox:          { phone_number_id: inbox.phone_number_id, access_token: inbox.access_token },
      toWaId:         contact.wa_id,
      tpl,
      variables,
      conversationId,
      sentBy:         me?.name,
      attendantId:    me?.id || null,
    })

    if (!result.ok) {
      console.error('[send-template] error:', result.error)
      return NextResponse.json({ error: 'Falha ao enviar template', details: result.error }, { status: 502 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[send-template] unhandled:', err)
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 })
  }
}
