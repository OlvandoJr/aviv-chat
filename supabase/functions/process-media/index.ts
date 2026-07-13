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
- LOTEAMENTO JARDIM PAULO FREIRE SPE LTDA – CNPJ 61.024.834/0001-21 (também conhecido como: Jardim dos Ypes, Jardim dos Ipês)
- LOTEAMENTO JARDIM DAS PALMEIRAS SPE LTDA
`.trim()

// Lista de empreendimentos dinâmica (tabela sincronizada do Sienge) — fallback ao hardcoded
async function getEmpreendimentosTexto(): Promise<string> {
  const { data } = await supabase
    .from('sienge_empreendimentos')
    .select('name, company_name, cnpj, apelidos')
    .order('name')
  if (!data || !data.length) return EMPREENDIMENTOS
  return data
    .map(e => `- ${e.company_name || e.name}${e.cnpj ? ' – CNPJ ' + e.cnpj : ''}${e.apelidos ? ' (também conhecido como: ' + e.apelidos + ')' : ''}`)
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
    // URL ASSINADA p/ buscadores externos (OpenAI) — o bucket é privado.
    const { data: signed } = await supabase.storage.from('chat-media').createSignedUrl(filePath, 3600)
    const fetchUrl = signed?.signedUrl || publicUrl

    // 4. Atualizar mensagem com a URL canônica (renderizada na UI via proxy /api/media)
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
      try {
        const sub = await getSubagentForConv(convId, 'image')
        if (sub) await analyzeImage(messageId, convId, contactWaId, fetchUrl, sub)
        else console.log('Nenhum subagente de imagem configurado — pulando análise')
      } catch (analysisErr) {
        console.error('Image analysis error (continuing to responder):', analysisErr)
        await supabase.from('chat_messages').update({
          ai_analysis: { error: String(analysisErr), validated_at: new Date().toISOString() },
        }).eq('id', messageId).then(() => {}, () => {})
      }
      await supabase.functions.invoke('ai-responder', { body: { conversationId: convId, messageId } })

    } else if (msgType === 'document' && mimeType === 'application/pdf') {
      try {
        const sub = await getSubagentForConv(convId, 'document')
        if (sub) await analyzePdf(messageId, convId, contactWaId, mediaBuffer, sub)
        else console.log('Nenhum subagente de documento configurado — pulando análise')
      } catch (analysisErr) {
        console.error('PDF analysis error (continuing to responder):', analysisErr)
        await supabase.from('chat_messages').update({
          ai_analysis: { error: String(analysisErr), validated_at: new Date().toISOString() },
        }).eq('id', messageId).then(() => {}, () => {})
      }
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

  const loadSub = async (aid: string) => {
    const { data } = await supabase
      .from('chat_subagents')
      .select('*')
      .eq('agent_id', aid)
      .eq('trigger_type', triggerType)
      .eq('is_active', true)
      .order('sort_order')
      .limit(1)
      .maybeSingle()
    return data
  }

  let sub = await loadSub(agentId)

  // Fallback global: se o agente da conversa (ex.: Contato Inteligente) não tem
  // subagente para este tipo de mídia, usa o do agente default (Vivi) — a análise
  // de comprovante é capacidade compartilhada, sem precisar duplicar config.
  if (!sub) {
    const { data: def } = await supabase.from('chat_agents').select('id').eq('is_default', true).maybeSingle()
    if (def?.id && def.id !== agentId) sub = await loadSub(def.id)
  }
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

// Converte texto monetário ("R$ 1.234,56" / "1234.56") em número
function parseMoney(s: any): number {
  if (s == null) return 0
  const c = String(s).replace(/[^\d.,-]/g, '')
  if (!c) return 0
  if (c.includes(',')) return parseFloat(c.replace(/\./g, '').replace(',', '.')) || 0
  return parseFloat(c) || 0
}

// Normaliza vencimento "15/05/2026" | "2026-05-15" → "2026-05-15"
function normVenc(s: unknown): string {
  const t = String(s ?? '').trim()
  let m = t.match(/(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/)
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` }
  return ''
}

// TRAVA determinística: o documento é PROVA DE PAGAMENTO efetivado (comprovante) e
// não uma cobrança (BOLETO)? Um boleto tem beneficiário/valor/vencimento/pagador
// iguais a um comprovante — o único jeito seguro de distinguir é exigir sinal de
// pagamento EFETIVADO. Confia primeiro na classificação do extrator
// (tipo_documento / pagamento_efetuado) e só cai na data de pagamento como fallback
// (boleto tem apenas vencimento). Baixo falso-positivo: PIX/TED/pagamento de boleto
// sempre trazem data/autenticação. Ver plano "Bloquear boleto como comprovante".
function isPaymentProof(d: any): boolean {
  const tipo = String(d?.tipo_documento || '').toLowerCase()
  if (tipo.startsWith('boleto') || tipo.startsWith('cobran')) return false
  if (d?.pagamento_efetuado === false) return false
  if (d?.pagamento_efetuado === true)  return true
  if (tipo === 'comprovante') return true
  // Prompt antigo / parse falho: exige data de pagamento válida (boleto só tem vencimento).
  return !!normVenc(d?.data_pagamento)
}

// Acha a parcela SGL (mensagens_cobranca) que o comprovante quita — casa por
// VENCIMENTO do comprovante, senão por VALOR mais próximo, senão a mais vencida.
// Se doUpdate, marca TODAS as linhas dessa parcela como comprovante_recebido
// (→ aparece "Comprovante" no painel/Central e sai da régua SGL).
async function markSglComprovante(waId: string, extracted: any, doUpdate: boolean): Promise<string> {
  const { data } = await supabase
    .from('mensagens_cobranca')
    .select('id, contasreceberparcela, contasrecebervalor, contasrecebervencimento, status')
    .eq('phone_norm', normalizePhone(waId))
    .order('contasrecebervencimento', { ascending: true })
  if (!data?.length) return ''

  const quitado = (st: any) => ['pago', 'comprovante_confirmado', 'comprovante_recebido', 'baixado'].includes(String(st || '').toLowerCase())
  const abertos = data.filter((r: any) => !quitado(r.status))
  const pool = abertos.length ? abertos : data

  // 1) casa pelo VENCIMENTO do comprovante
  let match: any = null
  const venc = normVenc(extracted?.vencimento)
  if (venc) match = pool.find((r: any) => normVenc(r.contasrecebervencimento) === venc)
  // 2) senão pelo VALOR mais próximo
  if (!match) {
    const alvo = parseMoney(extracted?.valor)
    if (alvo > 0) {
      let best: any = null, bestDiff = Infinity
      for (const r of pool) { const d = Math.abs(parseMoney(r.contasrecebervalor) - alvo); if (d < bestDiff) { best = r; bestDiff = d } }
      match = best
    }
  }
  // 3) senão a mais vencida em aberto
  if (!match) match = pool[0]
  if (!match) return ''

  if (doUpdate) {
    const parc = match.contasreceberparcela
    const patch = { status: 'comprovante_recebido', updated_at: new Date().toISOString() }
    if (parc) {
      await supabase.from('mensagens_cobranca').update(patch)
        .eq('phone_norm', normalizePhone(waId))
        .eq('contasreceberparcela', parc)
        .not('status', 'in', '("pago","comprovante_confirmado","baixado")')
    } else {
      await supabase.from('mensagens_cobranca').update(patch).eq('id', match.id)
    }
    console.log('SGL comprovante → parcela marcada:', parc || match.id, 'venc', match.contasrecebervencimento)
  }
  return String(match.id)
}

// Monta os placeholders disponíveis para as operações de escrita
function writeVars(waId: string, extracted: any, verdict: string, boleto: any, siengeStatus: any, extra: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = {
    contato: waId, telefone: waId, telefone_norm: normalizePhone(waId),
    cpf: extracted?.cpf_cnpj || '',
    verdict: verdict || '',
    boleto_id:          boleto?.id ? String(boleto.id) : '',
    receivable_bill_id: boleto?.receivable_bill_id ? String(boleto.receivable_bill_id) : '',
    installment_id:     boleto?.installment_id ? String(boleto.installment_id) : '',
    sienge_status: siengeStatus || '',
    now: new Date().toISOString(),
    hoje: new Date().toISOString().slice(0, 10),
  }
  for (const [k, v] of Object.entries(extracted || {})) base[k] = String(v ?? '')
  for (const [k, v] of Object.entries(extra)) base[k] = String(v ?? '')
  return base
}

// Resolve {{placeholders}} de um template (sem limpar dígitos)
function resolveTpl(tpl: string, vars: Record<string, string>): string {
  let out = String(tpl ?? '')
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, 'g'), v ?? '')
  }
  return out
}

// ── Operações de ESCRITA do subagente (insert/update/upsert) ──────────────────
// Rodam DEPOIS do veredito; valores via value_map { coluna: "valor_template" }.
async function runWriteOps(subId: string, baseVars: Record<string, string>): Promise<Record<string, string>> {
  const { data: ops } = await supabase
    .from('chat_subagent_datasources')
    .select('*')
    .eq('subagent_id', subId)
    .neq('operation', 'select')
    .order('sort_order')

  const out: Record<string, string> = {}
  for (const ds of ops || []) {
    const place = ds.output_placeholder || ds.name || 'op'
    try {
      const payload: Record<string, any> = {}
      for (const [col, valTpl] of Object.entries(ds.value_map || {})) {
        payload[col] = resolveTpl(String(valTpl), baseVars).trim()
      }
      const keyVal = ds.filter_column ? resolveTpl(ds.filter_template || '', baseVars).trim() : ''

      if (ds.operation === 'insert') {
        const { error } = await supabase.from(ds.table_name).insert(payload)
        out[place] = error ? `${ds.name}: erro (${error.message})` : `${ds.name}: criado.`
      } else if (ds.operation === 'update') {
        if (!ds.filter_column || !keyVal) { out[place] = `${ds.name}: sem chave — não atualizado.`; continue }
        const { error, count } = await supabase.from(ds.table_name).update(payload, { count: 'exact' }).eq(ds.filter_column, keyVal)
        out[place] = error ? `${ds.name}: erro (${error.message})` : `${ds.name}: atualizado (${count ?? '?'}).`
      } else if (ds.operation === 'upsert') {
        if (!ds.filter_column || !keyVal) { out[place] = `${ds.name}: sem chave — não gravado.`; continue }
        const { error } = await supabase.from(ds.table_name)
          .upsert({ ...payload, [ds.filter_column]: keyVal }, { onConflict: ds.filter_column })
        out[place] = error ? `${ds.name}: erro (${error.message})` : `${ds.name}: gravado.`
      }
    } catch (e) {
      out[place] = `${ds.name}: falha (${String(e)}).`
    }
  }
  return out
}

// ── Fontes de dados do subagente — consultam tabelas e devolvem placeholders ──
async function runDatasources(subId: string, baseVars: Record<string, string>): Promise<Record<string, string>> {
  const { data: sources } = await supabase
    .from('chat_subagent_datasources')
    .select('*')
    .eq('subagent_id', subId)
    .eq('operation', 'select')
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

// ── Boleto EMITIDO (banco) — fonte PRIMÁRIA de validação ──────────────────────
// Usa o valor REAL do boleto (com juros/multa), não o valor da parcela do Sienge.
// Assim o valor do comprovante bate com o do boleto e some a divergência falsa.
function mapEmitido(b: any) {
  return {
    id:                 null,                 // sem id local de sienge_boletos garantido
    emitido_id:         b.emitido_id,
    client_id:          b.client_id,
    receivable_bill_id: b.receivable_bill_id,
    installment_id:     b.installment_id,
    customer_name:      b.customer_name,
    customer_cpf:       b.customer_cpf,
    parcela_descricao:  b.parcela_descricao,
    amount:             b.amount,             // VALOR REAL DO BOLETO
    due_date:           b.due_date,
    _source:            'emitido',
  }
}

async function getBoletoEmitido(waId: string, cpfCnpj?: string, valorHint?: number): Promise<any | null> {
  const sel = 'emitido_id, client_id, customer_name, customer_cpf, parcela_descricao, due_date, amount, receivable_bill_id, installment_id'
  // Com N boletos por cliente (inclusive 2 no MESMO vencimento), escolhe o
  // candidato pelo VALOR do comprovante quando disponível; senão o mais antigo.
  const escolher = (rows: any[] | null): any | null => {
    if (!rows?.length) return null
    if (valorHint && valorHint > 0) {
      return [...rows].sort((a, b) =>
        Math.abs(Number(a.amount || 0) - valorHint) - Math.abs(Number(b.amount || 0) - valorHint)
        || String(a.due_date).localeCompare(String(b.due_date)))[0]
    }
    return rows[0]   // já vem ordenado por due_date asc
  }

  // 1. Por telefone
  const { data: byPhone } = await supabase
    .from('vw_boleto_chat').select(sel)
    .eq('phone_norm', normalizePhone(waId))
    .order('due_date', { ascending: true }).limit(10)
  const p = escolher(byPhone)
  if (p) { console.log('Boleto emitido por telefone:', p.parcela_descricao); return mapEmitido(p) }

  // 2. Por CPF (quando o comprovante traz CPF e há match Sienge na view)
  if (cpfCnpj) {
    const d = cpfCnpj.replace(/\D/g, '')
    if (d.length >= 11) {
      const { data: byCpf } = await supabase
        .from('vw_boleto_chat').select(sel)
        .eq('customer_cpf', d)
        .order('due_date', { ascending: true }).limit(10)
      const c = escolher(byCpf)
      if (c) { console.log('Boleto emitido por CPF:', c.parcela_descricao); return mapEmitido(c) }
    }
  }
  return null
}

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
  const origem  = boleto._source === 'sgl' ? 'SGL' : 'Sienge'
  const dueDate = boleto.due_date ? new Date(boleto.due_date).toLocaleDateString('pt-BR') : 'N/A'
  const amount  = (boleto.amount != null)
    ? new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(boleto.amount)
    : 'N/A'
  const origemLabel = boleto._source === 'emitido' ? 'Banco (boleto emitido)' : origem
  return [
    `DADOS DO BOLETO NA BASE (${origemLabel}):`,
    `- Pagador: ${boleto.customer_name || 'N/A'}`,
    `- CPF/CNPJ cadastrado: ${boleto.customer_cpf || 'N/A'}`,
    `- Parcela: ${boleto.parcela_descricao || 'N/A'}`,
    `- Valor esperado: ${amount}`,
    `- Vencimento: ${dueDate}`,
    '',
    'REGRAS DE CONFERÊNCIA:',
    '- VALOR: compare o valor do comprovante com o "Valor esperado". Só é OK quando for EXATAMENTE igual. Qualquer diferença — para MAIOR ou para MENOR — é divergência de valor (não trate acréscimo como OK). Nunca invente valores.',
    '- VENCIMENTO: NÃO use a data de vencimento no veredito e NUNCA invente datas — a data de pagamento costuma diferir do vencimento.',
    '- PAGADOR: aceite nome PARCIAL/CONTIDO e ignore acentos/maiúsculas (ex.: "MARIA DA SILVA SANTOS" casa com "MARIA DA SILVA"). Terceiro pagando (nome diferente) é comum e NÃO invalida o pagamento — registre, mas não trate como divergência grave.',
  ].join('\n')
}

// ── Boleto unificado (Sienge + SGL) via view — fonte única para validação ─────
// Resolve o caso de clientes legados do SGL (sem isto, o comprovante deles cai
// em validação manual por "falta de dados na base").
async function getBoletoUnificado(waId: string): Promise<any | null> {
  const { data } = await supabase
    .from('vw_clientes_boletos')
    .select('source, customer_name, parcela, due_date, amount, empreendimento, receivable_bill_id, installment_id')
    .eq('phone_norm', normalizePhone(waId))
    .maybeSingle()
  if (!data) return null
  return {
    customer_name:     data.customer_name,
    customer_cpf:      null,
    parcela_descricao: data.parcela,
    amount:            data.amount,
    due_date:          data.due_date,
    empreendimento:    data.empreendimento,
    _source:           data.source,
  }
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
  siengeStatus: 'pago' | 'pendente' | null,
  messageId:    string,
  waId:         string,
  tipo:         'image' | 'document',
) {
  const patch: Record<string, any> = {
    status:     siengeStatus === 'pago' ? 'pago' : 'comprovante_recebido',
    updated_at: new Date().toISOString(),
    ...(siengeStatus === 'pago' ? { paid_at: new Date().toISOString() } : {}),
  }

  // 1. Boleto EMITIDO (banco): marca o status em boletos_emitidos pela chave emitido.
  if (boleto.emitido_id) {
    await supabase.from('boletos_emitidos').update(patch).eq('id', boleto.emitido_id)
  }

  // 2. Comprovante registrado só quando há ID local do boleto Sienge.
  if (boleto.id) {
    try {
      await supabase.from('sienge_comprovantes').insert({
        boleto_id:           boleto.id,
        customer_phone:      waId,
        whatsapp_message_id: messageId,
        tipo,
        media_id:            messageId,
        status:              siengeStatus === 'pago' ? 'confirmado' : 'pendente',
      })
    } catch (_) { /* best-effort */ }
    await supabase.from('sienge_boletos').update(patch).eq('id', boleto.id)
  } else if (boleto.receivable_bill_id && boleto.installment_id) {
    // Fallback (boleto veio da view emitida/unificada, sem id local): casa pela chave do Sienge.
    await supabase.from('sienge_boletos').update(patch)
      .eq('receivable_bill_id', boleto.receivable_bill_id)
      .eq('installment_id', boleto.installment_id)
  } else if (!boleto.emitido_id) {
    console.warn('updateBoletoDB: sem id, emitido_id nem receivable_bill_id/installment_id — pulando')
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

  // Não é comprovante (ou é um BOLETO/cobrança, não prova de pagamento) — salvar e
  // sair ANTES de qualquer baixa. Bloqueia o caso do cliente mandar o boleto e o bot
  // dar baixa indevida. O bot pede o comprovante (doc_kind='boleto' → hint no ai-responder).
  if (extractedData.nao_comprovante || !isPaymentProof(extractedData)) {
    const isBoleto = !extractedData.nao_comprovante
    await supabase.from('chat_messages').update({
      ai_analysis: {
        ...extractedData,
        nao_comprovante: true,
        doc_kind:        isBoleto ? 'boleto' : 'outro',
        validated_at:    new Date().toISOString(),
      },
    }).eq('id', messageId)
    return
  }

  // ── Buscar boleto: Sienge (com check de pagamento) → unificado (SGL) ───────
  // Fonte PRIMÁRIA: boleto EMITIDO (valor real → sem divergência). Não consulta o
  // Sienge (preserva cota): o "pago" vem do webhook. Sienge/SGL só como fallback.
  let boleto = await getBoletoEmitido(waId, extractedData.cpf_cnpj, parseMoney(extractedData?.valor))
  let siengeStatus: 'pago' | 'pendente' | null = null
  if (!boleto) {
    boleto = await getSiengeBoleto(waId, extractedData.cpf_cnpj)
    if (boleto) siengeStatus = await checkSiengePayment(boleto)
    else boleto = await getBoletoUnificado(waId)   // cliente legado SGL / fallback por telefone
  }
  // Marca o boleto (comprovante_recebido/pago) em boletos_emitidos e/ou sienge_boletos
  if (boleto) await updateBoletoDB(boleto, siengeStatus, messageId, waId, 'image')

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

  verdict = valueGuardVerdict(verdict, extractedData.valor, boleto, extractedData)

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

  // Sinaliza a conversa para VALIDAÇÃO DE COMPROVANTE quando o veredito não foi
  // "100% válido" (e não está pago). Mostra a tag + alimenta o filtro na lista.
  const needsHuman = siengeStatus !== 'pago' && receiptNeedsHuman(verdict)
  await supabase.from('chat_conversations').update({ receipt_validation: needsHuman }).eq('id', convId)

  // ── Operações de escrita configuradas (ex.: atualizar status do boleto) ─────
  const sglMsgId = await markSglComprovante(waId, extractedData, !boleto || boleto._source === 'sgl')
  await runWriteOps(sub.id, writeVars(waId, extractedData, verdict, boleto, siengeStatus, { sgl_msg_id: sglMsgId }))
}

// Decide se o comprovante precisa de VALIDAÇÃO HUMANA a partir do veredito.
// Alinhado ao limiar do bot (≥80% = válido → confirma baixa, sem tag). O veredito
// tem o formato "Comprovante X% válido…" — lemos a porcentagem. Sem % explícita,
// só dispensa humano se o texto disser claramente "válido" (e não "inválido"/"não é
// comprovante").
function receiptNeedsHuman(verdict: string): boolean {
  const v = String(verdict || '')
  const m = v.match(/(\d{1,3})\s*%/)
  if (m) return Number(m[1]) < 80
  const dizValido   = /\bv[aá]lid[oa]\b/i.test(v)
  const dizProblema = /\binv[aá]lid|n[ãa]o\s+(?:é|e)\s+comprovante|parcial/i.test(v)
  return !dizValido || dizProblema
}

// Trava determinística: se o VALOR do comprovante confere com o boleto casado na
// base (igual ou maior — acréscimos/juros são normais), o pagamento É válido.
// Sobrepõe vereditos do LLM que rebaixam por divergências inventadas (ex.: data de
// vencimento alucinada). Só atua quando há boleto casado (beneficiário/cliente já
// identificado pelo lookup). Assim comprovantes que batem não viram pendência falsa.
function valueGuardVerdict(verdict: string, valorComprov: any, boleto: any, extractedData?: any): string {
  // Defesa em profundidade: nunca promover a 100% se o documento não for prova de
  // pagamento (ex.: boleto). O gate acima já barra antes, mas isto protege caso o
  // fluxo seja alterado/contornado por config futura.
  if (extractedData && !isPaymentProof(extractedData)) return verdict
  if (!boleto || boleto.amount == null) return verdict
  const c = parseMoney(valorComprov)
  const b = Number(boleto.amount) || 0
  if (c <= 0 || b <= 0) return verdict
  // Regra do negócio: valor EXATAMENTE igual = ok (100% nesse critério, com o
  // boleto/beneficiário já casado na base → válido). Qualquer diferença (para
  // MAIOR ou para MENOR) = divergência de valor → no máximo 50% (validação humana).
  if (Math.abs(c - b) <= 0.01) {
    return 'Comprovante 100% válido: valor pago igual ao boleto da base e beneficiário identificado. Sem necessidade de validação humana.'
  }
  return 'Comprovante 50% válido: valor pago diferente do esperado na base (para maior ou menor). Recomenda-se validação humana.'
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
    if (extractedData.nao_comprovante || !isPaymentProof(extractedData)) {
      const isBoleto = !extractedData.nao_comprovante
      await supabase.from('chat_messages').update({
        ai_analysis: {
          ...extractedData,
          nao_comprovante: true,
          doc_kind:        isBoleto ? 'boleto' : 'outro',
          validated_at:    new Date().toISOString(),
        },
      }).eq('id', messageId)
      return
    }

    // ── Buscar boleto: Sienge (com check de pagamento) → unificado (SGL) ──
    // Fonte PRIMÁRIA: boleto EMITIDO (valor real → sem divergência). Sienge/SGL só fallback.
    let boleto = await getBoletoEmitido(waId, extractedData.cpf_cnpj, parseMoney(extractedData?.valor))
    let siengeStatus: 'pago' | 'pendente' | null = null
    if (!boleto) {
      boleto = await getSiengeBoleto(waId, extractedData.cpf_cnpj)
      if (boleto) siengeStatus = await checkSiengePayment(boleto)
      else boleto = await getBoletoUnificado(waId)   // cliente legado SGL / fallback por telefone
    }
    // Marca o boleto (comprovante_recebido/pago) em boletos_emitidos e/ou sienge_boletos
    if (boleto) await updateBoletoDB(boleto, siengeStatus, messageId, waId, 'document')

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

    verdict = valueGuardVerdict(verdict, extractedData.valor, boleto, extractedData)

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

    // Sinaliza VALIDAÇÃO DE COMPROVANTE (veredito não "100% válido" e não pago).
    const needsHuman = siengeStatus !== 'pago' && receiptNeedsHuman(verdict)
    await supabase.from('chat_conversations').update({ receipt_validation: needsHuman }).eq('id', convId)

    // ── Operações de escrita configuradas (ex.: atualizar status do boleto) ───
    const sglMsgId = await markSglComprovante(waId, extractedData, !boleto || boleto._source === 'sgl')
    await runWriteOps(sub.id, writeVars(waId, extractedData, verdict, boleto, siengeStatus, { sgl_msg_id: sglMsgId }))

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

  // Timeout para não travar a função (e estourar 504) se o Whisper pendurar.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 25000)
  let resp: Response
  try {
    resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method:  'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body:    formData,
      signal:  controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
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
