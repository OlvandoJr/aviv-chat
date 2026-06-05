/**
 * "Início de conversa": garante contato + conversa aberta para um número,
 * espelhando o upsert do whatsapp-webhook. Usado por disparos (campanha/régua)
 * a quem ainda não tem thread.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export interface EnsuredConversation {
  conversationId: string
  contactId: string
}

export async function ensureConversation(
  admin: SupabaseClient,
  inboxId: string,
  waId: string,
  name?: string,
): Promise<EnsuredConversation | null> {
  // Upsert do contato (só sobrescreve o nome se um nome foi fornecido)
  const { data: contact, error: cErr } = await admin
    .from('chat_contacts')
    .upsert({ wa_id: waId, ...(name ? { name } : {}) }, { onConflict: 'wa_id' })
    .select('id')
    .single()
  if (cErr || !contact) return null

  // Conversa aberta mais recente (não arquivada) para este contato+inbox
  let { data: conv } = await admin
    .from('chat_conversations')
    .select('id')
    .eq('contact_id', contact.id)
    .eq('inbox_id', inboxId)
    .not('status', 'eq', 'archived')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!conv) {
    const { data: newConv } = await admin
      .from('chat_conversations')
      .insert({ inbox_id: inboxId, contact_id: contact.id, status: 'open' })
      .select('id')
      .single()
    conv = newConv
  }
  if (!conv) return null

  return { conversationId: conv.id, contactId: contact.id }
}
