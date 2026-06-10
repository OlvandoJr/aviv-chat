/**
 * auto-return-bot — Edge Function (cron horário)
 *
 * Resolve o caso "humano assumiu e abandonou": quando um atendente pega a conversa
 * (handled_by='human') mas deixa o CLIENTE esperando (última mensagem é dele) por mais
 * de TIMEOUT_H horas, a conversa volta para o Agente IA e o bot responde/re-escala na hora.
 *
 * Gatilho preciso (não atropela atendente ativo):
 *   - handled_by = 'human' E status = 'open'
 *   - a ÚLTIMA mensagem da conversa é 'in' (cliente esperando)
 *   - a espera está entre TIMEOUT_H e MAX_H horas
 *
 * O teto MAX_H (< 24h) existe porque, fora da janela de 24h da Meta, o bot não
 * consegue responder em texto livre — devolver seria inútil. Conversas mais antigas
 * que isso são caso de re-engajamento por template (feature à parte), não daqui.
 *
 * Não mexe em 'pending_human' (escalonamento proposital). Sem loop: ao virar 'bot'
 * (ou re-escalar para 'pending_human'), deixa de ser elegível.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

const TIMEOUT_H = 4    // mínimo de espera p/ devolver
const MAX_H     = 22   // teto: dentro da janela de 24h da Meta (margem p/ o envio)

Deno.serve(async () => {
  try {
    const cutoff = new Date(Date.now() - TIMEOUT_H * 60 * 60 * 1000).toISOString()  // mais velho que isto
    const floor  = new Date(Date.now() - MAX_H     * 60 * 60 * 1000).toISOString()  // mais novo que isto

    const { data: convs } = await supabase
      .from('chat_conversations')
      .select('id')
      .eq('handled_by', 'human')
      .eq('status', 'open')
      .limit(500)

    let returned = 0
    const ids: string[] = []

    for (const c of convs || []) {
      const { data: last } = await supabase
        .from('chat_messages')
        .select('direction, created_at')
        .eq('conversation_id', c.id)
        .order('created_at', { ascending: false })
        .limit(1).maybeSingle()

      // cliente esperando entre TIMEOUT_H e MAX_H (dentro da janela da Meta)?
      if (last && last.direction === 'in' && last.created_at < cutoff && last.created_at > floor) {
        await supabase.from('chat_conversations').update({ handled_by: 'bot' }).eq('id', c.id)
        // bot relê o histórico e responde / re-escala (vira pending_human se for caso de humano)
        await supabase.functions.invoke('ai-responder', { body: { conversationId: c.id } })
        returned++
        ids.push(c.id)
      }
    }

    const result = { ok: true, checked: convs?.length || 0, returned, ids }
    console.log('auto-return-bot:', JSON.stringify(result))
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    console.error('auto-return-bot error:', err)
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
})
