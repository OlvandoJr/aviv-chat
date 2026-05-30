import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const OPENAI_API_KEY  = Deno.env.get('OPENAI_API_KEY')!
const WA_ACCESS_TOKEN = Deno.env.get('WHATSAPP_ACCESS_TOKEN')!

// ── Empreendimentos cadastrados (referência para validação) ───────────────────
const EMPREENDIMENTOS = `
- LOTEAMENTO POR DO SOL SPE LTDA – CNPJ 57.214.290/0001-93
- LOTEAMENTO RESIDENCIAL AURORA SPE LTDA (apelido: AURORA)
- LOTEAMENTO RESIDENCIAL JARDIM TEXAS SPE LT – CNPJ 57.215.730/0001-27
- RESIDENCIAL VENEZA INVESTIMENTOS IMOBILIARIOS SPE LTDA – CNPJ 46.724.156/0001-16
- RESIDENCIAL VIDA NOVA MAUA DA SERRA – CNPJ 56.038.142/0001-00
- ROS CONSTRUTORA E INCORPORADORA LTDA – CNPJ 30.039.831/0001-38
- CONJUNTO HABITACIONAL AMADOR GONÇALVES
- JARDIM IMPERIAL SPE LTDA – CNPJ 62.143.390/0001-06
- FELIPE GIOVANINI ROSSETO – CPF 079.605.329-40
`.trim()

// ── Handler principal ─────────────────────────────────────────────────────────
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
      headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}` },
    })
    if (!mediaResp.ok) throw new Error('Falha ao baixar mídia')
    const mediaBuffer = await mediaResp.arrayBuffer()

    // 3. Fazer upload no Supabase Storage
    const ext      = getExtension(mimeType)
    const filePath = `chat/${convId}/${messageId}.${ext}`
    const { error: uploadErr } = await supabase.storage
      .from('chat-media')
      .upload(filePath, mediaBuffer, {
        contentType: mimeType || 'application/octet-stream',
        upsert:      true,
      })
    if (uploadErr) throw uploadErr

    const { data: { publicUrl } } = supabase.storage
      .from('chat-media')
      .getPublicUrl(filePath)

    // 4. Atualizar mensagem com URL da mídia
    await supabase.from('chat_messages').update({ media_url: publicUrl }).eq('id', messageId)

    // 5. Processar por tipo
    if (msgType === 'audio') {
      // ── Áudio: transcrever e acionar bot ──────────────────────────────────
      await transcribeAudio(messageId, mediaBuffer, mimeType)
      await supabase.functions.invoke('ai-responder', { body: { conversationId: convId, messageId } })

    } else if (msgType === 'image') {
      // ── Imagem: extrair campos → validar com veredicto → acionar bot ─────
      await analyzeImage(messageId, convId, contactWaId, publicUrl)
      await supabase.functions.invoke('ai-responder', { body: { conversationId: convId, messageId } })

    } else if (msgType === 'document' && mimeType === 'application/pdf') {
      // ── PDF: enviar para OpenAI → validar → acionar bot ──────────────────
      await analyzePdf(messageId, convId, contactWaId, mediaBuffer)
      await supabase.functions.invoke('ai-responder', { body: { conversationId: convId, messageId } })

    } else {
      // Outros arquivos: salvar e acionar bot sem análise
      await supabase.functions.invoke('ai-responder', { body: { conversationId: convId, messageId } })
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('process-media error:', err)
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
})

// ── Buscar boleto Sienge em aberto do cliente ─────────────────────────────────
async function getSiengeBoleto(waId: string) {
  const { data } = await supabase
    .from('sienge_boletos')
    .select('id, receivable_bill_id, installment_id, customer_name, due_date, amount, parcela_descricao')
    .eq('customer_phone', waId)
    .not('status', 'in', '("pago","cancelado")')
    .order('due_date', { ascending: true })
    .limit(1)
    .single()
  return data
}

// ── Formatar contexto Sienge para injeção no prompt ───────────────────────────
function buildSiengeContext(boleto: any): string {
  if (!boleto) return 'DADOS NA BASE: Nenhum boleto encontrado para este número de telefone.'
  const dueDate = new Date(boleto.due_date).toLocaleDateString('pt-BR')
  const amount  = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(boleto.amount)
  return [
    'DADOS DO BOLETO NA BASE (Sienge):',
    `- Pagador: ${boleto.customer_name || 'N/A'}`,
    `- Parcela: ${boleto.parcela_descricao || 'N/A'}`,
    `- Valor esperado: ${amount}`,
    `- Vencimento: ${dueDate}`,
  ].join('\n')
}

// ── Verificar status no Sienge API ────────────────────────────────────────────
async function checkSiengePayment(boleto: any): Promise<'pago' | 'pendente'> {
  try {
    const resp = await fetch(
      `https://api.sienge.com.br/avivconstrutora/public/api/v1/accounts-receivable/receivable-bills/${boleto.receivable_bill_id}/installments`,
      { headers: { Authorization: `Basic ${btoa(`${Deno.env.get('SIENGE_USER')}:${Deno.env.get('SIENGE_PASSWORD')}`)}` } }
    )
    if (!resp.ok) return 'pendente'
    const data = await resp.json()
    const installments = data.results || []
    const inst   = installments.find((i: any) => i.installmentId === parseInt(boleto.installment_id))
    const isPaid = inst ? Number(inst.balanceDue || 0) <= 0 : false
    return isPaid ? 'pago' : 'pendente'
  } catch {
    return 'pendente'
  }
}

// ── Atualizar boleto e registrar comprovante ──────────────────────────────────
async function updateBoletoDB(boleto: any, siengeStatus: 'pago' | 'pendente', messageId: string, waId: string, tipo: 'image' | 'document') {
  await supabase.from('sienge_comprovantes').insert({
    boleto_id:           boleto.id,
    customer_phone:      waId,
    whatsapp_message_id: messageId,
    tipo,
    media_id:            messageId,
    status:              siengeStatus === 'pago' ? 'confirmado' : 'pendente',
  }).catch(() => {})

  await supabase.from('sienge_boletos').update({
    status:     siengeStatus === 'pago' ? 'pago' : 'comprovante_recebido',
    updated_at: new Date().toISOString(),
    ...(siengeStatus === 'pago' ? { paid_at: new Date().toISOString() } : {}),
  }).eq('id', boleto.id)
}

// ─────────────────────────────────────────────────────────────────────────────
// IMAGEM: Passo 1 (extração) + Passo 2 (validação com veredicto)
// Espelha os nós "Analyze image1" e "Message a model 1" do n8n
// ─────────────────────────────────────────────────────────────────────────────
async function analyzeImage(
  messageId: string,
  convId:    string,
  waId:      string,
  imageUrl:  string,
) {
  // ── Passo 1: extrair campos brutos da imagem (= "Analyze image1") ─────────
  console.log('Image step 1: extracting fields from', imageUrl)
  const extractResp = await fetch('https://api.openai.com/v1/chat/completions', {
    method:  'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:      'gpt-4o-mini',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Extraia da imagem as informações:\nBeneficiário/favorecido:\nValor documento:\nVencimento:\nPagador:\nCPF Pagador:\n\nResponda em JSON com as chaves: beneficiario, valor, vencimento, data_pagamento, pagador, cpf_cnpj. Se não for um comprovante de pagamento, responda: {"nao_comprovante": true}',
          },
          { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } },
        ],
      }],
    }),
  })

  let extractedData: any = {}
  if (extractResp.ok) {
    const raw = (await extractResp.json()).choices?.[0]?.message?.content || '{}'
    console.log('Image extraction raw:', raw)
    try {
      const match = raw.match(/\{[\s\S]*\}/)
      extractedData = match ? JSON.parse(match[0]) : { raw }
    } catch {
      extractedData = { raw }
    }
  } else {
    console.error('Image extraction failed:', extractResp.status, await extractResp.text())
  }

  // Não é comprovante: salvar e sair sem análise de boleto
  if (extractedData.nao_comprovante) {
    await supabase.from('chat_messages').update({
      ai_analysis: { nao_comprovante: true, validated_at: new Date().toISOString() },
    }).eq('id', messageId)
    return
  }

  // ── Buscar boleto Sienge + verificar pagamento ────────────────────────────
  const boleto = await getSiengeBoleto(waId)
  let siengeStatus: 'pago' | 'pendente' | null = null
  if (boleto) {
    siengeStatus = await checkSiengePayment(boleto)
    await updateBoletoDB(boleto, siengeStatus, messageId, waId, 'image')
  }

  // ── Passo 2: validação completa com veredicto (= "Message a model 1") ─────
  const siengeCtx      = buildSiengeContext(boleto)
  const extractedSummary = `Dados extraídos da imagem:\n${Object.entries(extractedData).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`

  const validationPrompt = `# Papel
Você é um agente especialista em validar comprovantes de pagamento recebidos em imagem.

# Objetivo
Analisar o comprovante enviado e verificar: nome do pagador, data de vencimento, unidade/empreendimento, valor pago e banco emissor.

# Dados disponíveis
${extractedSummary}

${siengeCtx}

# Empreendimentos cadastrados
${EMPREENDIMENTOS}

# Procedimento
1. Compare os dados extraídos da imagem com os dados da base (Sienge).
2. Valide se o CNPJ/CPF e o nome do beneficiário conferem com os empreendimentos cadastrados.

# Regras de classificação
- **100% válido**: CNPJ/CPF/linha digitável confere + pagador e vencimento iguais à base. Pequenas diferenças de formatação, abreviações ou acentos não invalidam.
- **80% válido**: dados muito parecidos, pequenas divergências não comprometem a identificação.
- **50% válido**: divergências relevantes mas há indícios de relação. Recomende validação humana.
- **Negado**: CNPJ inválido, beneficiário não encontrado, dados insuficientes ou inconsistência crítica. Recomende validação humana.

Regras:
- Se 50% ou Negado → finalize com "Recomenda-se validação humana."
- Se 80% ou 100% → finalize com "Sem necessidade de validação humana."
- Cite o principal motivo (CNPJ, nome, valor, vencimento ou ausência de dados).

# Formato obrigatório (texto corrido, nunca JSON)
Comprovante com [100% válido / 80% válido / 50% válido / negado]. [Motivo principal em uma ou duas frases]. [Necessidade ou não de validação humana].`

  console.log('Image step 2: running validation prompt')
  const verdictResp = await fetch('https://api.openai.com/v1/chat/completions', {
    method:  'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      model:      'gpt-4o-mini',
      max_tokens: 350,
      messages:   [{ role: 'user', content: validationPrompt }],
    }),
  })

  let verdict = ''
  if (verdictResp.ok) {
    verdict = (await verdictResp.json()).choices?.[0]?.message?.content?.trim() || ''
    console.log('Image verdict:', verdict)
  } else {
    console.error('Image validation failed:', verdictResp.status, await verdictResp.text())
  }

  // ── Salvar análise completa ───────────────────────────────────────────────
  await supabase.from('chat_messages').update({
    ai_analysis: {
      ...extractedData,
      verdict,
      sienge_boleto: boleto ? {
        id: boleto.id, parcela: boleto.parcela_descricao,
        valor: boleto.amount, vencimento: boleto.due_date,
      } : null,
      sienge_status: siengeStatus,
      validated_at:  new Date().toISOString(),
    },
  }).eq('id', messageId)
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF: upload para OpenAI Files API → análise completa em um passo
// Espelha os nós "Download PDF → Extrator → Message a model" do n8n
// ─────────────────────────────────────────────────────────────────────────────
async function analyzePdf(
  messageId: string,
  convId:    string,
  waId:      string,
  buffer:    ArrayBuffer,
) {
  // ── Buscar boleto Sienge + verificar pagamento ────────────────────────────
  const boleto = await getSiengeBoleto(waId)
  let siengeStatus: 'pago' | 'pendente' | null = null
  if (boleto) {
    siengeStatus = await checkSiengePayment(boleto)
    await updateBoletoDB(boleto, siengeStatus, messageId, waId, 'document')
  }

  // ── Upload do PDF para a OpenAI Files API ─────────────────────────────────
  console.log('PDF step 1: uploading to OpenAI Files API')
  const pdfForm = new FormData()
  pdfForm.append('file', new Blob([buffer], { type: 'application/pdf' }), 'comprovante.pdf')
  pdfForm.append('purpose', 'user_data')

  const uploadResp = await fetch('https://api.openai.com/v1/files', {
    method:  'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body:    pdfForm,
  })

  if (!uploadResp.ok) {
    const errText = await uploadResp.text()
    console.error('PDF upload failed:', uploadResp.status, errText)
    await supabase.from('chat_messages').update({
      ai_analysis: {
        error:         'PDF upload failed',
        sienge_boleto: boleto ? { id: boleto.id, parcela: boleto.parcela_descricao, valor: boleto.amount, vencimento: boleto.due_date } : null,
        sienge_status: siengeStatus,
        validated_at:  new Date().toISOString(),
      },
    }).eq('id', messageId)
    return
  }

  const { id: fileId } = await uploadResp.json()
  console.log('PDF uploaded, fileId:', fileId)

  // ── Análise completa com GPT-4o (extração + validação em um passo) ────────
  const siengeCtx = buildSiengeContext(boleto)

  const analysisPrompt = `OVERRIDE: SAÍDA APENAS EM TEXTO SIMPLES (NUNCA JSON).

Você recebe um PDF de comprovante de pagamento.

Analise os seguintes pontos:
- CNPJ, CPF, linha digitável ou código de barras
- Nome do pagador
- Nome do beneficiário
- Valor
- Data de vencimento
- Data de pagamento (quando existir)
- Presença ou ausência de dados importantes
- Consistência geral do documento

${siengeCtx}

Empreendimentos de referência:
${EMPREENDIMENTOS}

Classifique em uma das opções:
- 100% válido: CNPJ/CPF/linha digitável confere + pagador e vencimento iguais à base.
- 80% válido: dados muito parecidos, pequenas divergências não comprometem a identificação.
- 50% válido: divergências relevantes mas há indícios de relação. Recomende validação humana.
- Negado: CNPJ inválido, beneficiário não encontrado, dados insuficientes. Recomende validação humana.

Regras:
- Se 50% ou Negado → finalize com "Recomenda-se validação humana."
- Se 80% ou 100% → finalize com "Sem necessidade de validação humana."

Formato de saída obrigatório (texto corrido, 3 linhas):
1) Comprovante [100% válido / 80% válido / 50% válido / negado].
2) [Motivo: CNPJ, nome, valor, vencimento, beneficiário ou ausência de dados].
3) [Recomendação de validação humana ou não].

Responda SOMENTE nesse formato. Nunca use JSON, lista ou tópicos.`

  let verdict = ''
  try {
    console.log('PDF step 2: analyzing with GPT-4o')
    const analysisResp = await fetch('https://api.openai.com/v1/chat/completions', {
      method:  'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        model:      'gpt-4o',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: analysisPrompt },
            { type: 'file', file: { file_id: fileId } },
          ],
        }],
      }),
    })

    if (analysisResp.ok) {
      verdict = (await analysisResp.json()).choices?.[0]?.message?.content?.trim() || ''
      console.log('PDF verdict:', verdict)
    } else {
      console.error('PDF analysis failed:', analysisResp.status, await analysisResp.text())
    }
  } finally {
    // Limpar arquivo do OpenAI (não acumula custo de armazenamento)
    await fetch(`https://api.openai.com/v1/files/${fileId}`, {
      method:  'DELETE',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    }).catch((e) => console.warn('File delete failed:', e))
  }

  // ── Salvar análise ────────────────────────────────────────────────────────
  await supabase.from('chat_messages').update({
    ai_analysis: {
      verdict,
      sienge_boleto: boleto ? {
        id: boleto.id, parcela: boleto.parcela_descricao,
        valor: boleto.amount, vencimento: boleto.due_date,
      } : null,
      sienge_status: siengeStatus,
      validated_at:  new Date().toISOString(),
    },
  }).eq('id', messageId)
}

// ── Transcrição de áudio com Whisper ──────────────────────────────────────────
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
  if (!resp.ok) {
    console.error('Whisper transcription failed:', resp.status)
    return
  }

  const { text } = await resp.json()
  await supabase.from('chat_messages').update({ metadata: { transcription: text } }).eq('id', messageId)
}

// ── Utilitário: extensão por MIME type ────────────────────────────────────────
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
