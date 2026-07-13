/**
 * send-reminders — Edge Function
 *
 * Executada a cada hora via cron do Supabase (job send-reminders-hourly, "5 * * * *").
 *
 * Lógica:
 *  1. Dia anterior: busca pagamentos para amanhã com reminder_day_before_sent=false
 *  2. Mesmo dia (manhã): busca pagamentos para hoje com reminder_1h_before_sent=false
 *     (janela 7h–10h BRT = 10h–13h UTC)
 *
 * JANELA DE 24h DO WHATSAPP: mensagem livre só é aceita pela Meta se o cliente
 * mandou mensagem nas últimas 24h. Se a janela estiver ABERTA → texto normal;
 * FECHADA → template aprovado. Os nomes dos templates são configuráveis no
 * config da ferramenta payment_scheduler (Agendador):
 *   - reminder_template_same_day   (default: fup_pagamento)
 *       vars: 1=nome, 2=link boleto, 3=empreendimento, 4=andar/quadra,
 *             5=unidade/lote, 6=parcela, 7=vencimento, 8=valor
 *   - reminder_template_day_before (sem default — criar/aprovar na Meta)
 *       vars: 1=nome, 2=parcela, 3=valor, 4=data agendada (DD/MM/AAAA)
 * Sem template configurado/aprovado com a janela fechada, o lembrete fica
 * pendente e o cron tenta de novo na próxima hora.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { sendTemplateMessage, type TemplateRow } from '../_shared/whatsapp.ts'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

Deno.serve(async (_req) => {
  try {
    const now = new Date()
    const utcHour = now.getUTCHours()

    // Config da ferramenta do Agendador (nomes dos templates de lembrete)
    const cfg = await getSchedulerConfig()

    // ── 1. Lembrete do dia anterior ────────────────────────────────────────────
    const tomorrow = new Date(now)
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
    const tomorrowStr = tomorrow.toISOString().split('T')[0]

    const { data: dayBeforePayments, error: dayErr } = await supabase
      .from('chat_scheduled_payments')
      .select(`
        id, contact_name, contact_wa_id, boleto_parcela, boleto_valor, scheduled_date,
        conversation:chat_conversations!conversation_id(
          id, inbox_id,
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

      const sent = await sendReminder(payment, text, 'day_before', cfg)
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
          conversation:chat_conversations!conversation_id(
            id, inbox_id,
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

        const sent = await sendReminder(payment, text, 'same_day', cfg)
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
// Envio com detecção da janela de 24h: aberta → texto; fechada → template.
// ─────────────────────────────────────────────────────────────────────────────
async function sendReminder(
  payment: any,
  text: string,
  kind: 'day_before' | 'same_day',
  cfg: Record<string, any>,
): Promise<boolean> {
  const conv = payment.conversation as any
  if (!conv?.id) {
    console.warn(`payment ${payment.id} sem conversa vinculada, pulando`)
    return false
  }
  if (await isWindowOpen(conv.id)) {
    return await sendWhatsApp(payment, text)
  }
  return await sendReminderTemplate(payment, kind, cfg)
}

// Janela de 24h do WhatsApp: aberta se o cliente mandou mensagem há < 23h55
// (margem de 5min para não estourar no meio do envio).
async function isWindowOpen(conversationId: string): Promise<boolean> {
  const { data } = await supabase
    .from('chat_messages')
    .select('created_at')
    .eq('conversation_id', conversationId)
    .eq('direction', 'in')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!data?.created_at) return false
  const age = Date.now() - new Date(data.created_at).getTime()
  return age < (24 * 60 - 5) * 60 * 1000
}

// Config da primeira ferramenta payment_scheduler ativa (Agendador)
async function getSchedulerConfig(): Promise<Record<string, any>> {
  const { data } = await supabase
    .from('chat_agent_tools')
    .select('config')
    .eq('tool_type', 'payment_scheduler')
    .eq('is_active', true)
    .limit(1)
    .maybeSingle()
  return (data?.config as Record<string, any>) || {}
}

// ── Lembrete via TEMPLATE (janela fechada) ────────────────────────────────────
async function sendReminderTemplate(
  payment: any,
  kind: 'day_before' | 'same_day',
  cfg: Record<string, any>,
): Promise<boolean> {
  const conv  = payment.conversation as any
  const inbox = conv?.inbox as any
  const waId  = payment.contact_wa_id
  if (!waId || !conv?.inbox_id || !inbox?.phone_number_id || !inbox?.access_token) {
    console.warn(`payment ${payment.id} — sem credenciais/inbox para template, pulando`)
    return false
  }

  const tplName = kind === 'same_day'
    ? (cfg.reminder_template_same_day || 'fup_pagamento')
    : (cfg.reminder_template_day_before || '')
  if (!tplName) {
    console.warn(`payment ${payment.id} — janela fechada e sem template configurado para ${kind}; tento na próxima hora`)
    return false
  }

  const { data: tpl } = await supabase
    .from('chat_wa_templates')
    .select('id, name, language, header_text, header_var_count, body_var_count, body_text, header_type')
    .eq('inbox_id', conv.inbox_id)
    .eq('name', tplName)
    .eq('status', 'APPROVED')
    .limit(1)
    .maybeSingle()
  if (!tpl) {
    console.warn(`payment ${payment.id} — template "${tplName}" não aprovado na inbox; tento na próxima hora`)
    return false
  }

  const nome = payment.contact_name || 'Cliente'
  const dataBR = String(payment.scheduled_date || '').split('-').reverse().join('/')
  const valorBR = payment.boleto_valor
    ? new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(payment.boleto_valor))
    : ''

  let variables: string[]
  if (kind === 'day_before') {
    // 1=nome, 2=parcela, 3=valor, 4=data agendada
    variables = [nome, payment.boleto_parcela || '', valorBR, dataBR]
  } else {
    // fup_pagamento: 1=nome, 2=link, 3=empreendimento, 4=quadra, 5=lote,
    // 6=parcela, 7=vencimento, 8=valor — dados do boleto na base (mesma view da régua)
    const b = await getBoletoRow(waId, payment.boleto_parcela)
    const vencBR = b?.due_date ? String(b.due_date).slice(0, 10).split('-').reverse().join('/') : dataBR
    variables = [
      nome,
      b?.link_boleto || '',
      b?.empreendimento || '',
      b?.quadra || '',
      b?.lote || '',
      b?.parcela || payment.boleto_parcela || '',
      vencBR,
      (b?.amount != null)
        ? new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(b.amount))
        : valorBR,
    ]
  }

  const res = await sendTemplateMessage({
    admin: supabase,
    inbox: { phone_number_id: inbox.phone_number_id, access_token: inbox.access_token },
    toWaId: waId,
    tpl: tpl as TemplateRow,
    variables: variables.slice(0, (tpl.header_var_count || 0) + (tpl.body_var_count || 0)),
    conversationId: conv.id,
    metaExtra: { sent_by: 'reminder_bot', reminder_kind: kind, payment_id: payment.id },
  })
  if (!res.ok) {
    console.error(`Reminder template failed for payment ${payment.id}:`, JSON.stringify(res.error))
    return false
  }
  console.log(`Reminder TEMPLATE (${tplName}/${kind}) sent to ${waId} for payment ${payment.id}`)
  return true
}

// Boleto do cliente na mesma view que a régua usa (link curto + dados do imóvel).
// Prefere a linha cuja parcela bate com a do agendamento; senão a de vencimento
// mais próximo.
async function getBoletoRow(waId: string, parcela?: string | null): Promise<any | null> {
  const { data } = await supabase
    .from('vw_cobranca_boletos')
    .select('customer_name, empreendimento, quadra, lote, parcela, due_date, amount, link_boleto')
    .eq('phone_norm', normalizePhone(waId))
    .order('due_date', { ascending: true })
    .limit(10)
  if (!data?.length) return null
  if (parcela) {
    const match = data.find((r: any) => String(r.parcela || '') === String(parcela))
    if (match) return match
  }
  return data[0]
}

// Normaliza telefone BR → DDD + 8 últimos dígitos (espelha normalize_phone do SQL)
function normalizePhone(raw: string): string {
  let d = (raw || '').replace(/\D/g, '')
  if (!d) return ''
  if (d.startsWith('55') && d.length >= 12) d = d.slice(2)
  if (d.startsWith('0')) d = d.slice(1)
  if (d.length >= 11 && d[2] === '9') d = d.slice(0, 2) + d.slice(3)
  return d.slice(-10)
}

// ─────────────────────────────────────────────────────────────────────────────
// Enviar mensagem de TEXTO livre via Meta API (janela aberta)
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
