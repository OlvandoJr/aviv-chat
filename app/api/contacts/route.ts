import { NextRequest, NextResponse }            from 'next/server'
import { createClient }                         from '@/lib/supabase/server'
import { createClient as createAdminClient }    from '@supabase/supabase-js'
import { usuarioAtual, ehSupervisor }           from '@/lib/api/papel'
import { ensureConversation }                   from '@/lib/whatsapp/conversation'
import { normalizeWaId, phoneNorm, telefoneValido } from '@/lib/whatsapp/telefone'

const admin = createAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

/**
 * Cria (ou reencontra) um contato e a conversa dele numa caixa de entrada.
 *
 * Única porta de criação manual: até aqui todo contato nascia em edge function
 * (mensagem recebida, campanha, régua, SGL) e não havia como falar com um número
 * que nunca escreveu.
 *
 * Idempotente por natureza: `chat_contacts.wa_id` é UNIQUE global, então repetir
 * o mesmo telefone devolve a conversa existente em vez de duplicar — inclusive
 * quando o número é digitado em outro formato (o normalizador resolve).
 */
export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

    const eu = await usuarioAtual()
    if (!eu) return NextResponse.json({ error: 'Atendente não encontrado' }, { status: 403 })

    const { telefone, nome = null, inboxId } = await req.json()
    if (!telefone || !inboxId) {
      return NextResponse.json({ error: 'Telefone e caixa de entrada são obrigatórios.' }, { status: 400 })
    }
    if (!telefoneValido(telefone)) {
      return NextResponse.json({ error: 'Telefone inválido. Informe DDD + número.' }, { status: 400 })
    }

    // A caixa precisa ser uma que o usuário atende — senão ele criaria uma conversa
    // que a própria RLS esconderia dele em seguida.
    if (!ehSupervisor(eu.papel)) {
      const { data: vinculo } = await admin
        .from('chat_attendant_inboxes')
        .select('inbox_id').eq('attendant_id', eu.id).eq('inbox_id', inboxId).maybeSingle()
      if (!vinculo) {
        return NextResponse.json({ error: 'Você não atende esta caixa de entrada.' }, { status: 403 })
      }
    }

    const { data: inbox } = await admin
      .from('chat_inboxes').select('id, is_active').eq('id', inboxId).maybeSingle()
    if (!inbox?.is_active) {
      return NextResponse.json({ error: 'Caixa de entrada inválida ou inativa.' }, { status: 422 })
    }

    const conv = await ensureConversation(
      admin, inboxId, telefone, nome?.trim() || undefined,
      null,        // sem agente: quem criou vai conduzir
      eu.id,       // responsável = quem criou
    )
    if (!conv) return NextResponse.json({ error: 'Falha ao criar a conversa.' }, { status: 500 })

    // Conversa aberta à mão é atendimento humano: um atendente escolheu falar com
    // esta pessoa, então o bot não responde por ele quando o cliente retornar.
    if (conv.created) {
      await admin.from('chat_conversations')
        .update({ handled_by: 'human' }).eq('id', conv.conversationId)
    }

    return NextResponse.json({
      ok: true,
      conversationId: conv.conversationId,
      contactId:      conv.contactId,
      waId:           normalizeWaId(telefone),
      phoneNorm:      phoneNorm(telefone),
      jaExistia:      !conv.created,
    })
  } catch (err) {
    console.error('[contacts POST]', err)
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 })
  }
}
