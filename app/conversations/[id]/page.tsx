import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import ConversationList from '@/components/conversations/ConversationList'
import ChatWindow from '@/components/chat/ChatWindow'

interface Props {
  params: Promise<{ id: string }>
}

export default async function ConversationPage({ params }: Props) {
  const { id }   = await params
  const supabase = await createClient()

  const { data: conversation } = await supabase
    .from('chat_conversations')
    .select(`
      *,
      contact:chat_contacts(*),
      assignee:chat_attendants(id, name, avatar_url)
    `)
    .eq('id', id)
    .single()

  if (!conversation) notFound()

  // Zerar unread
  await supabase
    .from('chat_conversations')
    .update({ unread_count: 0 })
    .eq('id', id)

  // Buscar atendentes para atribuição
  const { data: attendants } = await supabase
    .from('chat_attendants')
    .select('id, name, avatar_url')
    .eq('is_active', true)
    .order('name')

  const contact = conversation.contact as any
  const waId    = contact?.wa_id || ''

  // Buscar dados em paralelo: boletos Sienge, boletos SGL, atributos capturados
  const [
    { data: boletos },
    { data: sglBoletos },
    { data: contactAttributes },
    { data: central },
  ] = await Promise.all([
    supabase
      .from('sienge_boletos')
      .select('id, parcela_descricao, due_date, amount, status')
      .eq('customer_phone', waId)
      .order('due_date', { ascending: false })
      .limit(5),
    supabase
      .from('mensagens_cobranca')
      .select(
        'id, pessoanomecompleto, unidadeempreendimento, unidadequadraandar, ' +
        'unidadeloteapartamento, contasreceberparcela, contasrecebervencimento, ' +
        'contasrecebervalor, linkboleto, status, created_at'
      )
      .eq('phone', waId)
      .order('created_at', { ascending: false })
      .limit(5),
    supabase
      .from('chat_contact_attributes')
      .select('*')
      .eq('contact_id', contact?.id || '')
      .order('captured_at', { ascending: false }),
    supabase
      .from('vw_central_clientes')
      .select('origem')
      .eq('contact_id', contact?.id || '')
      .maybeSingle(),
  ])

  return (
    <>
      <ConversationList />
      <ChatWindow
        conversation={conversation as any}
        attendants={attendants || []}
        siengeBoletos={boletos || []}
        sglBoletos={(sglBoletos || []) as any}
        contactAttributes={contactAttributes || []}
        origem={(central as any)?.origem || null}
      />
    </>
  )
}
