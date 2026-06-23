import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import ChatWindow from '@/components/chat/ChatWindow'

interface Props {
  params: Promise<{ id: string }>
}

export default async function ConversationPage({ params }: Props) {
  const { id }   = await params
  const supabase = await createClient()

  // Dependem só do id da rota → rodam em paralelo
  const [
    { data: conversation },
    { data: attendants },
    { data: initialMessages },
  ] = await Promise.all([
    supabase
      .from('chat_conversations')
      .select(`
        *,
        contact:chat_contacts(*),
        assignee:chat_attendants(id, name, avatar_url)
      `)
      .eq('id', id)
      .single(),
    supabase
      .from('chat_attendants')
      .select('id, name, avatar_url')
      .eq('is_active', true)
      .order('name'),
    supabase
      .from('chat_messages')
      .select('*, attendant:chat_attendants(id, name)')
      .eq('conversation_id', id)
      .order('created_at', { ascending: true })
      .limit(100),
  ])

  if (!conversation) notFound()

  const contact = conversation.contact as any

  // Mapa template_id → botões (p/ exibir no balão os botões que o cliente recebeu)
  const templateButtons: Record<string, { text: string; type: string }[]> = {}
  {
    const { data: tpls } = await supabase
      .from('chat_wa_templates').select('id, buttons').eq('inbox_id', conversation.inbox_id)
    for (const t of tpls || []) {
      const bs = Array.isArray(t.buttons) ? t.buttons : []
      if (bs.length) templateButtons[t.id] = bs.map((b: any) => ({ text: b.text, type: b.type }))
    }
  }

  // Resumo 360 da Central (precisa do contact_id da conversa)
  const { data: central } = await supabase
    .from('vw_central_clientes')
    .select('phone_norm, cpf, origem, ja_cobrado, total_cobrancas, ultima_cobranca, proximo_venc, boleto_vencido')
    .eq('contact_id', contact?.id || '')
    .maybeSingle()

  const phoneNorm = (central as any)?.phone_norm || ''

  // Boletos por phone_norm (mesma chave da Central — robusto a formatos de telefone)
  const [
    { data: boletos },
    { data: sglBoletos },
    { data: contactAttributes },
  ] = await Promise.all([
    supabase
      .from('sienge_boletos')
      .select('id, parcela_descricao, due_date, amount, status')
      .eq('phone_norm', phoneNorm)
      .order('due_date', { ascending: false })
      .limit(20),
    supabase
      .from('mensagens_cobranca')
      .select(
        'id, pessoanomecompleto, unidadeempreendimento, unidadequadraandar, ' +
        'unidadeloteapartamento, contasreceberparcela, contasrecebervencimento, ' +
        'contasrecebervalor, linkboleto, status, created_at'
      )
      .eq('phone_norm', phoneNorm)
      .order('created_at', { ascending: false })
      .limit(30),
    supabase
      .from('chat_contact_attributes')
      .select('*')
      .eq('contact_id', contact?.id || '')
      .order('captured_at', { ascending: false }),
  ])

  return (
    <ChatWindow
      key={id}
      conversation={conversation as any}
      attendants={attendants || []}
      siengeBoletos={boletos || []}
      sglBoletos={(sglBoletos || []) as any}
      contactAttributes={contactAttributes || []}
      central={central || null}
      initialMessages={(initialMessages || []) as any}
      templateButtons={templateButtons}
    />
  )
}
