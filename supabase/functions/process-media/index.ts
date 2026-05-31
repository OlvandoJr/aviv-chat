import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const OPENAI_API_KEY  = Deno.env.get('OPENAI_API_KEY')!
const WA_ACCESS_TOKEN = Deno.env.get('WHATSAPP_ACCESS_TOKEN')!

const SIENGE_BASE = 'https://api.sienge.com.br/avivconstrutora/public/api/v1'
const siengeAuth  = () =>
  `Basic ${btoa(`${Deno.env.get('SIENGE_USER')}:${Deno.env.get('SIENGE_PASSWORD')}`)}`

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
      // ── PDF: extrair → buscar boleto → validar → acionar bot ─────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// LOOKUP SIENGE — 3 estratégias em cascata:
//   1. Telefone na base local
//   2. CPF na base local
//   3. CPF → API Sienge (GET /customers → GET /receivable-bills)
// ─────────────────────────────────────────────────────────────────────────────
const BOLETO_SELECT =
  'id, receivable_bill_id, installment_id, customer_name, customer_cpf, due_date, amount, parcela_descricao'

async function getSiengeBoleto(waId: string, cpfCnpj?: string): Promise<any | null> {
  const baseQuery = () =>
    supabase
      .from('sienge_boletos')
      .select(BOLETO_SELECT)
      .not('status', 'in', '("pago","cancelado")')
      .order('due_date', { ascending: true })
      .limit(1)

  // 1. Por telefone
  const { data: byPhone } = await baseQuery().eq('customer_phone', waId).maybeSingle()
  if (byPhone) {
    console.log('Boleto found by phone:', byPhone.parcela_descricao)
    return byPhone
  }

  if (!cpfCnpj) return null

  const cpfDigits = cpfCnpj.replace(/\D/g, '')
  if (cpfDigits.length < 11) return null

  // 2. Por CPF na base local
  const { data: byCpf } = await baseQuery().eq('customer_cpf', cpfDigits).maybeSingle()
  if (byCpf) {
    console.log('Boleto found by CPF (local):', byCpf.parcela_descricao)
    // Atualizar telefone na base para próximas consultas por telefone
    if (byCpf.id) {
      await supabase.from('sienge_boletos')
        .update({ customer_phone: waId })
        .eq('id', byCpf.id)
        .catch(() => {})
    }
    return byCpf
  }

  // 3. Por CPF via API Sienge
  console.log('Boleto not in local DB, trying Sienge API by CPF:', cpfDigits)
  return await fetchBoletoFromSiengeAPI(cpfDigits, waId)
}

// ── Buscar cliente na API Sienge por CPF e retornar boleto em aberto ──────────
async function fetchBoletoFromSiengeAPI(cpfDigits: string, waId: string): Promise<any | null> {
  try {
    const auth = siengeAuth()

    // GET /v1/customers?cpf=XXXXXXXXXXX
    const custResp = await fetch(
      `${SIENGE_BASE}/customers?cpf=${cpfDigits}&onlyActive=false&limit=5`,
      { headers: { Authorization: auth } }
    )
    if (!custResp.ok) {
      console.warn('Sienge customers API error:', custResp.status)
      return null
    }
    const custData = await custResp.json()
    const customer = custData.results?.[0]
    if (!customer) {
      console.log('No Sienge customer found for CPF:', cpfDigits)
      return null
    }
    console.log('Found Sienge customer:', customer.id, customer.name)

    // GET /v1/accounts-receivable/receivable-bills?customerId=N&paidOff=false
    const billsResp = await fetch(
      `${SIENGE_BASE}/accounts-receivable/receivable-bills?customerId=${customer.id}&paidOff=false&limit=20`,
      { headers: { Authorization: auth } }
    )
    if (!billsResp.ok) {
      console.warn('Sienge receivable-bills API error:', billsResp.status)
      return null
    }
    const billsData  = await billsResp.json()
    const bills: any[] = billsData.results || []
    if (bills.length === 0) {
      console.log('No open bills found for customer:', customer.id)
      return null
    }

    // Percorrer títulos e encontrar a primeira parcela em aberto
    for (const bill of bills) {
      const instResp = await fetch(
        `${SIENGE_BASE}/accounts-receivable/receivable-bills/${bill.receivableBillId}/installments`,
        { headers: { Authorization: auth } }
      )
      if (!instResp.ok) continue
      const instData = await instResp.json()
      const openInst = (instData.results || []).find((i: any) => Number(i.balanceDue || 0) > 0)
      if (!openInst) continue

      // Salvar/atualizar na base local (upsert pelo constraint unique receivable_bill_id+installment_id)
      const boletoPayload = {
        receivable_bill_id: bill.receivableBillId,
        installment_id:     openInst.installmentId,
        customer_id:        customer.id,
        customer_name:      customer.name,
        customer_phone:     waId,
        customer_cpf:       cpfDigits,
        due_date:           openInst.dueDate,
        amount:             openInst.balanceDue,
        parcela_descricao:  `Parcela ${openInst.installmentId}`,
        status:             'em_aberto',
        updated_at:         new Date().toISOString(),
      }

      const { data: upserted } = await supabase
        .from('sienge_boletos')
        .upsert(boletoPayload, { onConflict: 'receivable_bill_id,installment_id' })
        .select(BOLETO_SELECT)
        .maybeSingle()

      if (upserted) {
        console.log('Boleto upserted from Sienge API:', upserted.parcela_descricao)
        return upserted
      }

      // Fallback: retornar objeto in-memory se o upsert falhar
      return { ...boletoPayload, id: null }
    }

    console.log('No open installments found for customer:', customer.id)
    return null
  } catch (err) {
    console.error('fetchBoletoFromSiengeAPI error:', err)
    return null
  }
}

// ── Formatar contexto Sienge para injeção no prompt ───────────────────────────
function buildSiengeContext(boleto: any): string {
  if (!boleto) return 'DADOS NA BASE: Nenhum boleto encontrado para este cliente.'
  const dueDate = new Date(boleto.due_date).toLocaleDateString('pt-BR')
  const amount  = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(boleto.amount)
  return [
    'DADOS DO BOLETO NA BASE (Sienge):',
    `- Pagador: ${boleto.customer_name || 'N/A'}`,
    `- CPF/CNPJ cadastrado: ${boleto.customer_cpf || 'N/A'}`,
    `- Parcela: ${boleto.parcela_descricao || 'N/A'}`,
    `- Valor esperado: ${amount}`,
    `- Vencimento: ${dueDate}`,
  ].join('\n')
}

// ── Verificar status no Sienge API ────────────────────────────────────────────
async function checkSiengePayment(boleto: any): Promise<'pago' | 'pendente'> {
  try {
    const resp = await fetch(
      `${SIENGE_BASE}/accounts-receivable/receivable-bills/${boleto.receivable_bill_id}/installments`,
      { headers: { Authorization: siengeAuth() } }
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
async function updateBoletoDB(
  boleto:       any,
  siengeStatus: 'pago' | 'pendente',
  messageId:    string,
  waId:         string,
  tipo:         'image' | 'document',
) {
  // Só insere na tabela de comprovantes e atualiza o boleto se tiver ID local
  if (boleto.id) {
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
  } else {
    console.warn('updateBoletoDB: boleto has no local ID, skipping DB update')
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// IMAGEM: Passo 1 (extração JSON) + Passo 2 (validação com veredicto)
// ─────────────────────────────────────────────────────────────────────────────
async function analyzeImage(
  messageId: string,
  convId:    string,
  waId:      string,
  imageUrl:  string,
) {
  // ── Passo 1: extrair campos brutos da imagem ──────────────────────────────
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

  // Não é comprovante — salvar e sair
  if (extractedData.nao_comprovante) {
    await supabase.from('chat_messages').update({
      ai_analysis: { nao_comprovante: true, validated_at: new Date().toISOString() },
    }).eq('id', messageId)
    return
  }

  // ── Buscar boleto com CPF extraído como fallback ───────────────────────────
  const boleto = await getSiengeBoleto(waId, extractedData.cpf_cnpj)
  let siengeStatus: 'pago' | 'pendente' | null = null
  if (boleto) {
    siengeStatus = await checkSiengePayment(boleto)
    await updateBoletoDB(boleto, siengeStatus, messageId, waId, 'image')
  }

  // ── Passo 2: validação completa com veredicto ─────────────────────────────
  const siengeCtx        = buildSiengeContext(boleto)
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
// PDF: Passo 1 (extração JSON via Files API) → boleto lookup → Passo 2 (veredicto)
// ─────────────────────────────────────────────────────────────────────────────
async function analyzePdf(
  messageId: string,
  convId:    string,
  waId:      string,
  buffer:    ArrayBuffer,
) {
  // ── Upload do PDF para a OpenAI Files API ─────────────────────────────────
  console.log('PDF: uploading to OpenAI Files API')
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
      ai_analysis: { error: 'PDF upload failed', validated_at: new Date().toISOString() },
    }).eq('id', messageId)
    return
  }

  const { id: fileId } = await uploadResp.json()
  console.log('PDF uploaded, fileId:', fileId)

  let verdict      = ''
  let extractedData: any = {}

  try {
    // ── Passo 1: extrair campos estruturados (espelha image step 1) ────────
    console.log('PDF step 1: extracting structured fields')
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
              text: 'Extraia do documento as informações:\nBeneficiário/favorecido:\nValor documento:\nVencimento:\nPagador:\nCPF/CNPJ Pagador:\n\nResponda em JSON com as chaves: beneficiario, valor, vencimento, data_pagamento, pagador, cpf_cnpj. Se não for um comprovante de pagamento, responda: {"nao_comprovante": true}',
            },
            { type: 'file', file: { file_id: fileId } },
          ],
        }],
      }),
    })

    if (extractResp.ok) {
      const raw = (await extractResp.json()).choices?.[0]?.message?.content || '{}'
      console.log('PDF extraction raw:', raw)
      try {
        const match = raw.match(/\{[\s\S]*\}/)
        extractedData = match ? JSON.parse(match[0]) : { raw }
      } catch {
        extractedData = { raw }
      }
    } else {
      console.error('PDF extraction failed:', extractResp.status, await extractResp.text())
    }

    // Não é comprovante — salvar e sair
    if (extractedData.nao_comprovante) {
      await supabase.from('chat_messages').update({
        ai_analysis: { nao_comprovante: true, validated_at: new Date().toISOString() },
      }).eq('id', messageId)
      return
    }

    // ── Buscar boleto com CPF extraído como fallback ─────────────────────
    const boleto = await getSiengeBoleto(waId, extractedData.cpf_cnpj)
    let siengeStatus: 'pago' | 'pendente' | null = null
    if (boleto) {
      siengeStatus = await checkSiengePayment(boleto)
      await updateBoletoDB(boleto, siengeStatus, messageId, waId, 'document')
    }

    // ── Passo 2: validação completa com veredicto (GPT-4o lê o PDF) ─────
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

    // ── Salvar análise ────────────────────────────────────────────────────
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

  } finally {
    // Limpar arquivo do OpenAI (não acumula custo de armazenamento)
    await fetch(`https://api.openai.com/v1/files/${fileId}`, {
      method:  'DELETE',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    }).catch((e) => console.warn('File delete failed:', e))
  }
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
