import { createClient } from '@/lib/supabase/server'
import { notFound }     from 'next/navigation'
import ClientDetail     from '../ClientDetail'

export const dynamic = 'force-dynamic'

export default async function ClientDetailPage({ params }: { params: Promise<{ phone: string }> }) {
  const { phone } = await params
  const supabase = await createClient()

  const { data: cliente } = await supabase
    .from('vw_central_clientes').select('*').eq('phone_norm', phone).maybeSingle()
  if (!cliente) notFound()

  const [{ data: boletosSienge }, { data: boletosSgl }, { data: reguaLog }] = await Promise.all([
    supabase.from('sienge_boletos')
      .select('customer_name, empreendimento, quadra, lote, parcela_descricao, due_date, amount, status, paid_at')
      .eq('phone_norm', phone).order('due_date', { ascending: false }).limit(40),
    supabase.from('mensagens_cobranca')
      .select('id, pessoanomecompleto, unidadeempreendimento, unidadequadraandar, unidadeloteapartamento, contasreceberparcela, contasrecebervencimento, contasrecebervalor, linkboleto, status, classificacao, app_dispatched_at, created_at')
      .eq('phone_norm', phone).order('created_at', { ascending: false }).limit(30),
    supabase.from('cobranca_regua_log')
      .select('offset_days, due_date, parcela, status, run_date, created_at')
      .eq('phone_norm', phone).order('run_date', { ascending: false }),
  ])

  // Conversas + mensagens (da conversa mais recente)
  let conversations: any[] = []
  let messages: any[] = []
  if (cliente.contact_id) {
    const { data: convs } = await supabase
      .from('chat_conversations')
      .select('id, status, last_message_at, sector, handled_by')
      .eq('contact_id', cliente.contact_id)
      .order('last_message_at', { ascending: false, nullsFirst: false })
    conversations = convs || []
    if (conversations[0]) {
      const { data: msgs } = await supabase
        .from('chat_messages')
        .select('id, direction, type, content, media_url, wa_status, created_at, attendant:chat_attendants(name)')
        .eq('conversation_id', conversations[0].id)
        .order('created_at', { ascending: true })
        .limit(150)
      messages = msgs || []
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <ClientDetail
        cliente={cliente}
        boletosSienge={boletosSienge || []}
        boletosSgl={boletosSgl || []}
        reguaLog={reguaLog || []}
        conversations={conversations}
        messages={messages}
      />
    </div>
  )
}
