import { normalizeWaId } from './telefone'

/**
 * Garante contato + conversa — versão Next do `ensureConversation` das edge
 * functions (supabase/functions/_shared/whatsapp.ts).
 *
 * O arquivo já existia com uma cópia ANTIGA e errada (não normalizava o telefone
 * e não dizia se criou), e ninguém a importava. Reescrito para espelhar a versão
 * canônica: mesmo upsert por `wa_id`, mesma busca de conversa não-arquivada e os
 * mesmos updates NÃO destrutivos (agente/responsável só quando estão nulos —
 * nunca rouba um atendimento em andamento).
 *
 * Exige client com service role: a RLS de SELECT de chat_conversations é
 * restritiva e o autor poderia não ler de volta o que acabou de inserir.
 */
export async function ensureConversation(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  inboxId: string,
  waId: string,
  name?: string,
  agentId: string | null = null,
  assigneeId: string | null = null,
): Promise<{ conversationId: string; contactId: string; created: boolean } | null> {
  const wa = normalizeWaId(waId) || waId

  const { data: contact } = await admin
    .from('chat_contacts')
    .upsert({ wa_id: wa, ...(name ? { name } : {}) }, { onConflict: 'wa_id' })
    .select('id')
    .single()
  if (!contact?.id) return null

  const { data: existente } = await admin
    .from('chat_conversations')
    .select('id')
    .eq('contact_id', contact.id)
    .eq('inbox_id', inboxId)
    .not('status', 'eq', 'archived')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (existente?.id) {
    if (agentId) {
      await admin.from('chat_conversations')
        .update({ agent_id: agentId }).eq('id', existente.id).is('agent_id', null)
    }
    if (assigneeId) {
      await admin.from('chat_conversations')
        .update({ assignee_id: assigneeId }).eq('id', existente.id).is('assignee_id', null)
    }
    return { conversationId: existente.id, contactId: contact.id, created: false }
  }

  const { data: nova } = await admin
    .from('chat_conversations')
    .insert({
      inbox_id: inboxId,
      contact_id: contact.id,
      status: 'open',
      ...(agentId ? { agent_id: agentId } : {}),
      ...(assigneeId ? { assignee_id: assigneeId } : {}),
    })
    .select('id')
    .single()
  if (!nova?.id) return null

  return { conversationId: nova.id, contactId: contact.id, created: true }
}
