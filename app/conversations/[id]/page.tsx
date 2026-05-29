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

  // Buscar boleto Sienge do cliente
  const contact = conversation.contact as any
  const { data: boletos } = await supabase
    .from('sienge_boletos')
    .select('id, parcela_descricao, due_date, amount, status')
    .eq('customer_phone', contact?.wa_id || '')
    .order('due_date', { ascending: false })
    .limit(5)

  return (
    <>
      <ConversationList />
      <ChatWindow
        conversation={conversation as any}
        attendants={attendants || []}
        siengeBoletos={boletos || []}
      />
    </>
  )
}
