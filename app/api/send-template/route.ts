import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

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

    // Montar componentes com variáveis
    const components: any[] = []

    if (tpl.header_var_count > 0 && tpl.header_text) {
      const headerVars = variables.slice(0, tpl.header_var_count)
      components.push({
        type:       'header',
        parameters: headerVars.map((v: string) => ({ type: 'text', text: v })),
      })
    }

    if (tpl.body_var_count > 0) {
      const bodyVars = variables.slice(tpl.header_var_count)
      components.push({
        type:       'body',
        parameters: bodyVars.map((v: string) => ({ type: 'text', text: v })),
      })
    }

    // Payload WhatsApp
    const payload: any = {
      messaging_product: 'whatsapp',
      to:                contact.wa_id,
      type:              'template',
      template: {
        name:     tpl.name,
        language: { code: tpl.language },
        ...(components.length ? { components } : {}),
      },
    }

    const sendResp = await fetch(
      `https://graph.facebook.com/v20.0/${inbox.phone_number_id}/messages`,
      {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${inbox.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }
    )

    if (!sendResp.ok) {
      const err = await sendResp.json().catch(() => ({}))
      console.error('[send-template] error:', err)
      return NextResponse.json({ error: 'Falha ao enviar template', details: err }, { status: 502 })
    }

    const sendData    = await sendResp.json()
    const waMessageId = sendData.messages?.[0]?.id ?? null
    const now         = new Date().toISOString()

    // Renderizar texto do template com variáveis (para preview no banco)
    let rendered = tpl.body_text
    const allVars: string[] = variables
    allVars.forEach((v: string, i: number) => {
      rendered = rendered.replace(new RegExp(`\\{\\{${i + 1}\\}\\}`, 'g'), v)
    })
    // Prefixar com nome do atendente para o histórico
    const content = me?.name ? `${me.name}:\n${rendered}` : rendered

    await admin.from('chat_messages').insert({
      conversation_id: conversationId,
      wa_message_id:   waMessageId,
      direction:       'out',
      type:            'template',
      content,
      wa_status:       'sent',
      attendant_id:    me?.id || null,
      metadata:        { template_id: templateId, template_name: tpl.name, variables },
    })

    await admin.from('chat_conversations').update({
      last_message_at:      now,
      last_message_preview: `[Template] ${tpl.name}`,
      status:               'open',
    }).eq('id', conversationId)

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[send-template] unhandled:', err)
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 })
  }
}
