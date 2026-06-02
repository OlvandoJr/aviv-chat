/**
 * send-reminders — Edge Function
 *
 * Deve ser executada a cada hora via cron do Supabase:
 *   Schedule: 0 * * * *
 *
 * Lógica:
 *  1. Dia anterior: busca pagamentos para amanhã com reminder_day_before_sent=false
 *  2. Mesmo dia (manhã): busca pagamentos para hoje com reminder_1h_before_sent=false
 *     (janela 7h–10h BRT = 10h–13h UTC)
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

Deno.serve(async (_req) => {
  try {
    const now = new Date()
    const utcHour = now.getUTCHours()

    // ── 1. Lembrete do dia anterior ────────────────────────────────────────────
    const tomorrow = new Date(now)
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
    const tomorrowStr = tomorrow.toISOString().split('T')[0]

    const { data: dayBeforePayments, error: dayErr } = await supabase
      .from('chat_scheduled_payments')
      .select(`
        id, contact_name, contact_wa_id, boleto_parcela, boleto_valor, scheduled_date,
        conversation:chat_conversations(
          id,
          inbox:chat_inboxes(phone_number_id, access_token)
        )
      `)
      .eq('scheduled_date', tomorrowStr)
      .eq('reminder_day_before_sent', false)
      .eq('status', 'agendado')

    if (dayErr) console.error('day_before query error:', dayErr)

    let dayBeforeSent = 0
    for (const payment of dayBeforePayments || []) {
      const valorStr = payment.boleto_valor
        ? ` de R$ ${Number(payment.boleto_valor).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
        : ''
      const parcelaStr = payment.boleto_parcela ? ` (${payment.boleto_parcela})` : ''
      const nome = payment.contact_name ? `${payment.contact_name}` : 'Olá'

      const text =
        `${nome}! 😊 Lembramos que seu pagamento${parcelaStr}${valorStr} está agendado para *amanhã*.\n\n` +
        `Certifique-se de que haverá saldo disponível. Em caso de dúvidas, estamos aqui para ajudar!`

      const sent = await sendWhatsApp(payment, text)
      if (sent) {
        await supabase
          .from('chat_scheduled_payments')
          .update({ reminder_day_before_sent: true, status: 'lembrado_dia' })
          .eq('id', payment.id)
        dayBeforeSent++
      }
    }

    // ── 2. Lembrete no mesmo dia (7h–10h BRT = 10h–13h UTC) ───────────────────
    let sameDaySent = 0
    if (utcHour >= 10 && utcHour < 13) {
      const todayStr = now.toISOString().split('T')[0]

      const { data: sameDayPayments, error: sameErr } = await supabase
        .from('chat_scheduled_payments')
        .select(`
          id, contact_name, contact_wa_id, boleto_parcela, boleto_valor, scheduled_date,
          conversation:chat_conversations(
            id,
            inbox:chat_inboxes(phone_number_id, access_token)
          )
        `)
        .eq('scheduled_date', todayStr)
        .eq('reminder_1h_before_sent', false)
        .in('status', ['agendado', 'lembrado_dia'])

      if (sameErr) console.error('same_day query error:', sameErr)

      for (const payment of sameDayPayments || []) {
        const valorStr = payment.boleto_valor
          ? ` de R$ ${Number(payment.boleto_valor).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
          : ''
        const parcelaStr = payment.boleto_parcela ? ` (${payment.boleto_parcela})` : ''
        const nome = payment.contact_name ? `${payment.contact_name}` : 'Olá'

        const text =
          `${nome}! 📅 Hoje é o dia do seu pagamento agendado${parcelaStr}${valorStr}.\n\n` +
          `Se precisar de ajuda ou quiser reagendar, é só nos avisar. 😊`

        const sent = await sendWhatsApp(payment, text)
        if (sent) {
          await supabase
            .from('chat_scheduled_payments')
            .update({ reminder_1h_before_sent: true, status: 'lembrado_hora' })
            .eq('id', payment.id)
          sameDaySent++
        }
      }
    }

    const result = {
      ok: true,
      utcHour,
      tomorrowStr,
      dayBeforeChecked: (dayBeforePayments || []).length,
      dayBeforeSent,
      sameDaySent,
    }
    console.log('send-reminders result:', JSON.stringify(result))

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('send-reminders error:', err)
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Enviar mensagem WhatsApp diretamente via Meta API
// ─────────────────────────────────────────────────────────────────────────────
async function sendWhatsApp(payment: any, text: string): Promise<boolean> {
  const waId = payment.contact_wa_id
  if (!waId) {
    console.warn(`payment ${payment.id} sem contact_wa_id, pulando`)
    return false
  }

  // Buscar credenciais da inbox via conversa
  const conv = payment.conversation as any
  const inbox = conv?.inbox as any

  if (!inbox?.phone_number_id || !inbox?.access_token) {
    console.warn(`payment ${payment.id} — inbox sem credenciais, pulando`)
    return false
  }

  try {
    const resp = await fetch(
      `https://graph.facebook.com/v20.0/${inbox.phone_number_id}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${inbox.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to:   waId,
          type: 'text',
          text: { body: text },
        }),
      }
    )

    if (!resp.ok) {
      console.error(`WhatsApp send failed for payment ${payment.id}:`, resp.status, await resp.text())
      return false
    }

    const data    = await resp.json()
    const msgId   = data.messages?.[0]?.id

    // Salvar mensagem no histórico da conversa
    if (conv?.id && msgId) {
      await supabase.from('chat_messages').insert({
        conversation_id: conv.id,
        wa_message_id:   msgId,
        direction:       'out',
        type:            'text',
        content:         text,
        metadata:        { sent_by: 'reminder_bot' },
      })
      await supabase
        .from('chat_conversations')
        .update({
          last_message_at:      new Date().toISOString(),
          last_message_preview: text.substring(0, 120),
        })
        .eq('id', conv.id)
    }

    console.log(`Reminder sent to ${waId} for payment ${payment.id} (msg: ${msgId})`)
    return true
  } catch (err) {
    console.error(`sendWhatsApp error for payment ${payment.id}:`, err)
    return false
  }
}
