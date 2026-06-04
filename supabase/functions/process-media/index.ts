import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const OPENAI_API_KEY      = Deno.env.get('OPENAI_API_KEY')!
const WA_ACCESS_TOKEN_ENV = Deno.env.get('WHATSAPP_ACCESS_TOKEN') || ''

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
- LOTEAMENTO JARDIM PAULO FREIRE SPE LTDA – CNPJ 61.024.834/0001-21
- LOTEAMENTO JARDIM DAS PALMEIRAS SPE LTDA
`.trim()

// Lista de empreendimentos dinâmica (tabela sincronizada do Sienge) — fallback ao hardcoded
async function getEmpreendimentosTexto(): Promise<string> {
  const { data } = await supabase
    .from('sienge_empreendimentos')
    .select('name, company_name, cnpj')
    .order('name')
  if (!data || !data.length) return EMPREENDIMENTOS
  return data
    .map(e => `- ${e.company_name || e.name}${e.cnpj ? ' – CNPJ ' + e.cnpj : ''}`)
    .join('\n')
}

// ── Handler principal ─────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  const { messageId, waMediaId, mimeType, msgType, convId, contactWaId, inboxId } = await req.json()

  // Resolver token correto: inbox-specific > env global
  let WA_ACCESS_TOKEN = WA_ACCESS_TOKEN_ENV
  if (inboxId) {
    const { data: inbox } = await supabase
      .from('chat_inboxes')
      .select('access_token')
      .eq('id', inboxId)
      .single()
    if (inbox?.access_token) WA_ACCESS_TOKEN = inbox.access_token
  }

  try {
    // 1. Obter URL de download da Meta
    const metaUrlResp = await fetch(
      `https://graph.facebook.com/v20.0/${waMediaId}`,
      { headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}` } }
    )
    if (!metaUrlResp.ok) throw new Error(`Falha ao obter URL da mídia: ${metaUrlResp.status}`)
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

    // 5. Processar por tipo (usando subagentes configuráveis)
    if (msgType === 'audio') {
      try {
        await transcribeAudio(messageId, mediaBuffer, mimeType)
        const sub = await getSubagentForConv(convId, 'audio')
        if (sub?.instructions?.trim()) await interpretAudio(messageId, sub)
      } catch (transcriptionErr) {
        console.error('Audio processing error (continuing):', transcriptionErr)
      }
      await supabase.functions.invoke('ai-responder', { body: { conversationId: convId, messageId } })

    } else if (msgType === 'image') {
      const sub = await getSubagentForConv(convId, 'image')
      if (sub) await analyzeImage(messageId, convId, contactWaId, publicUrl, sub)
      else console.log('Nenhum subagente de imagem configurado — pulando análise')
      await supabase.functions.invoke('ai-responder', { body: { conversationId: convId, messageId } })

    } else if (msgType === 'document' && mimeType === 'application/pdf') {
      const sub = await getSubagentForConv(convId, 'document')
      if (sub) await analyzePdf(messageId, convId, contactWaId, mediaBuffer, sub)
      else console.log('Nenhum subagente de documento configurado — pulando análise')
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
// SUBAGENTES — busca o subagente ativo do agente da conversa por tipo de gatilho
// ─────────────────────────────────────────────────────────────────────────────
async function getSubagentForConv(convId: string, triggerType: string): Promise<any | null> {
  const { data: conv } = await supabase
    .from('chat_conversations')
    .select('agent_id, inbox_id')
    .eq('id', convId)
    .maybeSingle()

  let agentId = conv?.agent_id as string | null
  if (!agentId && conv?.inbox_id) {
    const { data: rule } = await supabase
      .from('chat_agent_rules')
      .select('agent_id')
      .eq('rule_type', 'inbox')
      .eq('rule_value', conv.inbox_id)
      .maybeSingle()
    agentId = rule?.agent_id || null
  }
  if (!agentId) {
    const { data: def } = await supabase.from('chat_agents').select('id').eq('is_default', true).maybeSingle()
    agentId = def?.id || null
  }
  if (!agentId) return null

  const { data: sub } = await supabase
    .from('chat_subagents')
    .select('*')
    .eq('agent_id', agentId)
    .eq('trigger_type', triggerType)
    .eq('is_active', true)
    .order('sort_order')
    .limit(1)
    .maybeSingle()
  return sub
}

// Substitui QUALQUER placeholder {{chave}} do prompt pelos valores fornecidos
function fillPlaceholders(tpl: string, vars: Record<string, string>): string {
  let out = tpl || ''
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, 'g'), v ?? '')
  }
  // Empreendimentos é sempre disponível como default
  if (!('empreendimentos' in vars)) {
    out = out.replace(/\{\{\s*empreendimentos\s*\}\}/g, EMPREENDIMENTOS)
  }
  return out
}

// ── Fontes de dados do subagente — consultam tabelas e devolvem placeholders ──
async function runDatasources(subId: string, baseVars: Record<string, string>): Promise<Record<string, string>> {
  const { data: sources } = await supabase
    .from('chat_subagent_datasources')
    .select('*')
    .eq('subagent_id', subId)
    .order('sort_order')

  const out: Record<string, string> = {}
  for (const ds of sources || []) {
    try {
      // Resolver o valor do filtro (substituindo {{contato}}, {{cpf}}, etc)
      let filterVal = ds.filter_template || ''
      for (const [k, v] of Object.entries(baseVars)) {
        filterVal = filterVal.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, 'g'), v ?? '')
      }
      // Normalizar CPF/telefone (só dígitos) quando o filtro parecer numérico
      const looksNumeric = /^[\d.\-/()\s]+$/.test(filterVal)
      const cleanVal = looksNumeric ? filterVal.replace(/\D/g, '') : filterVal

      let q = supabase.from(ds.table_name).select(ds.columns || '*').limit(ds.max_rows || 5)
      if (ds.filter_column && cleanVal) q = q.eq(ds.filter_column, cleanVal)

      const { data: rows, error } = await q
      if (error) {
        out[ds.output_placeholder] = `${ds.name}: erro ao consultar (${error.message}).`
        continue
      }
      out[ds.output_placeholder] = formatRows(ds.name, rows || [])
    } catch (e) {
      out[ds.output_placeholder] = `${ds.name}: falha na consulta.`
    }
  }
  return out
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

function formatRows(name: string, rows: any[]): string {
  if (!rows.length) return `${name}: nenhum registro encontrado na base.`
  const lines = rows.map(r =>
    '- ' + Object.entries(r).map(([k, v]) => `${k}: ${v ?? '—'}`).join(', ')
  )
  return `${name} (${rows.length}):\n${lines.join('\n')}`
}

// Interpreta a transcrição de áudio usando o subagente de áudio
async function interpretAudio(messageId: string, sub: any) {
  const { data: msg } = await supabase
    .from('chat_messages').select('metadata').eq('id', messageId).maybeSingle()
  const transcricao = (msg?.metadata as any)?.transcription || ''
  if (!transcricao) return

  const dsVars = await runDatasources(sub.id, { transcricao })
  const prompt = fillPlaceholders(sub.instructions, { transcricao, ...dsVars })
    + (sub.output_format ? `\n\nFORMATO DE SAÍDA:\n${sub.output_format}` : '')

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: sub.model || 'gpt-4o-mini', max_tokens: 200, messages: [{ role: 'user', content: prompt }] }),
  })
  if (!resp.ok) return
  const interpretation = (await resp.json()).choices?.[0]?.message?.content?.trim() || ''
  if (interpretation) {
    await supabase.from('chat_messages')
      .update({ metadata: { ...(msg?.metadata as any), audio_interpretation: interpretation } })
      .eq('id', messageId)
  }
}

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
  sub:       any,
) {
  // ── Passo 1: extrair campos brutos da imagem (prompt do subagente) ────────
  console.log('Image step 1: extracting fields from', imageUrl)
  const extractResp = await fetch('https://api.openai.com/v1/chat/completions', {
    method:  'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:      sub.extraction_model || 'gpt-4o-mini',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: sub.extraction_prompt || '' },
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

  // Executar fontes de dados configuradas (injetam placeholders adicionais)
  const dsVars = await runDatasources(sub.id, {
    contato: waId, telefone: waId, telefone_norm: normalizePhone(waId), cpf: extractedData.cpf_cnpj || "",
  })

  const validationPrompt = fillPlaceholders(sub.instructions, {
    dados_extraidos: extractedSummary,
    contexto_sienge: siengeCtx,
    empreendimentos: await getEmpreendimentosTexto(),
    ...dsVars,   // fontes configuradas têm prioridade (podem sobrescrever contexto_sienge)
  }) + (sub.output_format ? `\n\nFORMATO DE SAÍDA:\n${sub.output_format}` : '')

  console.log('Image step 2: running validation prompt (subagente)')
  const verdictResp = await fetch('https://api.openai.com/v1/chat/completions', {
    method:  'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      model:      sub.model || 'gpt-4o-mini',
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
  sub:       any,
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
        model:      sub.extraction_model || 'gpt-4o-mini',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: sub.extraction_prompt || '' },
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

    const dsVars = await runDatasources(sub.id, {
      contato: waId, telefone: waId, telefone_norm: normalizePhone(waId), cpf: extractedData.cpf_cnpj || "",
    })

    const analysisPrompt = fillPlaceholders(sub.instructions, {
      contexto_sienge: siengeCtx,
      empreendimentos: await getEmpreendimentosTexto(),
      ...dsVars,
    }) + (sub.output_format ? `\n\nFORMATO DE SAÍDA:\n${sub.output_format}` : '')

    console.log('PDF step 2: analyzing with subagente model', sub.model)
    const analysisResp = await fetch('https://api.openai.com/v1/chat/completions', {
      method:  'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        model:      sub.model || 'gpt-4o',
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
  // WhatsApp envia 'audio/ogg; codecs=opus' — normalizar removendo parâmetros extras
  const baseMimeType = (mimeType || 'audio/ogg').split(';')[0].trim()
  const ext          = getExtension(baseMimeType) || 'ogg'

  console.log(`Whisper: mimeType="${mimeType}" → base="${baseMimeType}" ext="${ext}" size=${buffer.byteLength}`)

  const formData = new FormData()
  formData.append('file', new Blob([buffer], { type: baseMimeType }), `audio.${ext}`)
  formData.append('model', 'whisper-1')
  formData.append('language', 'pt')

  const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method:  'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body:    formData,
  })
  if (!resp.ok) {
    const errBody = await resp.text()
    console.error(`Whisper transcription failed: ${resp.status} — ${errBody}`)
    return
  }

  const { text } = await resp.json()
  console.log(`Whisper OK: "${text?.substring(0, 80)}"`)
  await supabase.from('chat_messages').update({ metadata: { transcription: text } }).eq('id', messageId)
}

// ── Utilitário: extensão por MIME type ────────────────────────────────────────
function getExtension(mimeType: string | null): string {
  if (!mimeType) return 'bin'
  // Normalizar: remover parâmetros como "; codecs=opus"
  const base = mimeType.split(';')[0].trim()
  const map: Record<string, string> = {
    'image/jpeg':       'jpg',
    'image/png':        'png',
    'image/webp':       'webp',
    'audio/ogg':        'ogg',
    'audio/mpeg':       'mp3',
    'audio/mp4':        'mp4',
    'audio/aac':        'aac',
    'audio/wav':        'wav',
    'audio/webm':       'webm',
    'application/pdf':  'pdf',
    'video/mp4':        'mp4',
    'video/webm':       'webm',
  }
  return map[base] || base.split('/')[1] || 'bin'
}
