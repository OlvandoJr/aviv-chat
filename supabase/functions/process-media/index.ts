import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const OPENAI_API_KEY     = Deno.env.get('OPENAI_API_KEY')!
const WA_ACCESS_TOKEN    = Deno.env.get('WHATSAPP_ACCESS_TOKEN')!

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  const { messageId, waMediaId, mimeType, msgType, convId, contactWaId } = await req.json()

  try {
    // 1. Obter URL de download da Meta
    const metaUrlResp = await fetch(
      `https://graph.facebook.com/v20.0/${waMediaId}`,
      { headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}` } }
    )
    if (!metaUrlResp.ok) throw new Error('Falha ao obter URL da mídia')
    const { url: mediaUrl } = await metaUrlResp.json()

    // 2. Baixar a mídia
    const mediaResp = await fetch(mediaUrl, {
      headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}` }
    })
    if (!mediaResp.ok) throw new Error('Falha ao baixar mídia')
    const mediaBuffer = await mediaResp.arrayBuffer()

    // 3. Fazer upload no Supabase Storage
    const ext      = getExtension(mimeType)
    const filePath = `chat/${convId}/${messageId}.${ext}`
    const { error: uploadErr } = await supabase.storage
      .from('chat-media')
      .upload(filePath, mediaBuffer, {
        contentType:  mimeType || 'application/octet-stream',
        upsert:       true,
      })
    if (uploadErr) throw uploadErr

    const { data: { publicUrl } } = supabase.storage
      .from('chat-media')
      .getPublicUrl(filePath)

    // 4. Atualizar mensagem com URL da mídia
    await supabase
      .from('chat_messages')
      .update({ media_url: publicUrl })
      .eq('id', messageId)

    // 5. Processar por tipo e invocar bot após conclusão
    if (msgType === 'audio') {
      await transcribeAudio(messageId, mediaBuffer, mimeType)
      // Invocar bot com transcrição já salva no banco
      await supabase.functions.invoke('ai-responder', {
        body: { conversationId: convId, messageId },
      })
    } else if (msgType === 'image' || msgType === 'document') {
      await analyzeComprovante(messageId, convId, contactWaId, publicUrl, mimeType, mediaBuffer)
      // Invocar bot com análise já salva no banco
      await supabase.functions.invoke('ai-responder', {
        body: { conversationId: convId, messageId },
      })
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('process-media error:', err)
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})

async function transcribeAudio(messageId: string, buffer: ArrayBuffer, mimeType: string) {
  const ext      = getExtension(mimeType) || 'ogg'
  const formData = new FormData()
  formData.append('file', new Blob([buffer], { type: mimeType }), `audio.${ext}`)
  formData.append('model', 'whisper-1')
  formData.append('language', 'pt')

  const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method:  'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body:    formData,
  })
  if (!resp.ok) return

  const { text } = await resp.json()
  await supabase
    .from('chat_messages')
    .update({ metadata: { transcription: text } })
    .eq('id', messageId)
}

async function analyzeComprovante(
  messageId: string,
  convId:    string,
  waId:      string,
  fileUrl:   string,
  mimeType:  string,
  buffer:    ArrayBuffer
) {
  // Verificar se cliente tem boleto Sienge ativo
  const { data: boleto } = await supabase
    .from('sienge_boletos')
    .select('id, receivable_bill_id, installment_id, customer_name, due_date, amount, parcela_descricao')
    .eq('customer_phone', waId)
    .not('status', 'in', '("pago","cancelado")')
    .order('due_date', { ascending: true })
    .limit(1)
    .single()

  // Analisar imagem com GPT-4o-mini
  let aiAnalysis: any = null

  if (mimeType?.startsWith('image/')) {
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)))
    const dataUrl = `data:${mimeType};base64,${base64}`

    const extractResp = await fetch('https://api.openai.com/v1/chat/completions', {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model:      'gpt-4o-mini',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Extraia do comprovante de pagamento: Beneficiário/favorecido, Valor documento, Data de vencimento, Data de pagamento, Pagador, CPF/CNPJ Pagador. Responda em JSON com as chaves: beneficiario, valor, vencimento, data_pagamento, pagador, cpf_cnpj.',
            },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'auto' } },
          ],
        }],
      }),
    })

    if (extractResp.ok) {
      const extractData = await extractResp.json()
      const rawText = extractData.choices?.[0]?.message?.content || '{}'
      try {
        const jsonMatch = rawText.match(/\{[\s\S]*\}/)
        aiAnalysis = jsonMatch ? JSON.parse(jsonMatch[0]) : { raw: rawText }
      } catch {
        aiAnalysis = { raw: rawText }
      }
    }
  }

  // Validar contra boleto Sienge se existir
  let siengeStatus: string | null = null
  if (boleto) {
    // Verificar no Sienge API se está pago
    const siengeResp = await fetch(
      `https://api.sienge.com.br/avivconstrutora/public/api/v1/accounts-receivable/receivable-bills/${boleto.receivable_bill_id}/installments`,
      {
        headers: {
          Authorization: `Basic ${btoa(`${Deno.env.get('SIENGE_USER')}:${Deno.env.get('SIENGE_PASSWORD')}`)}`,
        },
      }
    )

    if (siengeResp.ok) {
      const siengeData = await siengeResp.json()
      const installments = siengeData.results || []
      const inst = installments.find((i: any) => i.installmentId === parseInt(boleto.installment_id))
      const isPaid = inst ? Number(inst.balanceDue || 0) <= 0 : false

      siengeStatus = isPaid ? 'pago' : 'pendente'

      // Salvar comprovante Sienge
      await supabase.from('sienge_comprovantes').insert({
        boleto_id:           boleto.id,
        customer_phone:      waId,
        whatsapp_message_id: messageId,
        tipo:                mimeType?.startsWith('image/') ? 'image' : 'document',
        media_id:            fileUrl,
        status:              isPaid ? 'confirmado' : 'pendente',
      }).select().single()

      // Atualizar boleto
      const newStatus = isPaid ? 'pago' : 'comprovante_recebido'
      await supabase
        .from('sienge_boletos')
        .update({
          status:     newStatus,
          updated_at: new Date().toISOString(),
          ...(isPaid ? { paid_at: new Date().toISOString() } : {}),
        })
        .eq('id', boleto.id)
    }
  }

  // Salvar análise na mensagem
  const analysis = {
    ...aiAnalysis,
    sienge_boleto:  boleto ? { id: boleto.id, parcela: boleto.parcela_descricao, valor: boleto.amount, vencimento: boleto.due_date } : null,
    sienge_status:  siengeStatus,
    validated_at:   new Date().toISOString(),
  }

  await supabase
    .from('chat_messages')
    .update({ ai_analysis: analysis })
    .eq('id', messageId)
}

function getExtension(mimeType: string | null): string {
  if (!mimeType) return 'bin'
  const map: Record<string, string> = {
    'image/jpeg':       'jpg',
    'image/png':        'png',
    'image/webp':       'webp',
    'audio/ogg':        'ogg',
    'audio/mpeg':       'mp3',
    'audio/mp4':        'mp4',
    'application/pdf':  'pdf',
    'video/mp4':        'mp4',
  }
  return map[mimeType] || mimeType.split('/')[1] || 'bin'
}
