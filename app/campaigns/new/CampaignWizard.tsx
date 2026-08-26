'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { ArrowLeft, Megaphone, Users, Send, Plus, Trash2 } from 'lucide-react'
import { AVAILABLE_COLUMNS, COLUMN_LABEL } from '@/lib/whatsapp/vars'
import MappedPreview from '@/components/whatsapp/MappedPreview'
import { cn } from '@/lib/utils'
import { parseDelimited, fromMatrix, detectarColunas } from '@/lib/whatsapp/planilha'

interface Tpl {
  id: string; name: string; inbox_id: string; language: string
  header_type: string | null; header_text: string | null; body_text: string; footer_text?: string | null
  header_var_count: number; body_var_count: number
}
interface Props {
  inboxes: { id: string; name: string }[]
  templates: Tpl[]
  campaign?: any
  attendants?: { id: string; name: string; role: string }[]
  memberships?: { attendant_id: string; inbox_id: string }[]
  agents?: { id: string; name: string; avatar_emoji: string | null; is_default: boolean }[]
  disparos?: any[]
}

function varNums(text: string): number[] {
  const s = new Set<number>()
  for (const m of (text || '').matchAll(/\{\{(\d+)\}\}/g)) s.add(parseInt(m[1]))
  return [...s].sort((a, b) => a - b)
}
function defaultFormat(col: string): 'currency' | 'date' | undefined {
  if (col === 'amount') return 'currency'
  if (col === 'due_date') return 'date'
  return undefined
}

export default function CampaignWizard({ inboxes, templates, campaign, attendants = [], memberships = [], agents = [], disparos: disparosIniciais = [] }: Props) {
  const router = useRouter()
  const supabase = createClient()
  const isEdit = !!campaign

  const toLocalInput = (iso: string | null) => iso ? new Date(iso).toISOString().slice(0, 16) : ''

  const [name, setName]       = useState(campaign?.name || '')
  const [inboxId, setInboxId] = useState(campaign?.inbox_id || inboxes[0]?.id || '')
  const [templateId, setTemplateId] = useState(campaign?.template_id || '')
  const [mapping, setMapping] = useState<Record<string, { type: 'static' | 'column'; value: string; format?: string }>>(campaign?.variable_mapping || {})
  const [filter, setFilter]   = useState<{ source: string; dueFrom: string; dueTo: string; empreendimento: string; nome: string; telefone: string }>(
    { source: campaign?.audience?.filter?.source || 'both', dueFrom: campaign?.audience?.filter?.dueFrom || '',
      dueTo: campaign?.audience?.filter?.dueTo || '', empreendimento: campaign?.audience?.filter?.empreendimento || '',
      nome: campaign?.audience?.filter?.nome || '', telefone: campaign?.audience?.filter?.telefone || '' })
  const [scheduledAt, setScheduledAt] = useState(toLocalInput(campaign?.scheduled_at || null))
  const [headerMediaPath, setHeaderMediaPath]         = useState<string | null>(campaign?.header_media_path || null)
  const [headerMediaFilename, setHeaderMediaFilename] = useState<string | null>(campaign?.header_media_filename || null)
  const [headerMediaMode, setHeaderMediaMode]         = useState<'upload' | 'boleto'>(campaign?.header_media_mode === 'boleto' ? 'boleto' : 'upload')
  const [uploading, setUploading] = useState(false)

  const [busy, setBusy]   = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draftId, setDraftId] = useState<string | null>(campaign?.id || null)
  const [audienceTotal, setAudienceTotal] = useState<number | null>(null)
  // Distratado não recebe campanha por padrão (mesma regra das réguas). O toggle
  // existe para reconquista/pesquisa com ex-cliente — escolha explícita.
  const [incluirDistratados, setIncluirDistratados] = useState<boolean>(!!campaign?.incluir_distratados)
  const [removidosDistrato, setRemovidosDistrato]   = useState<number>(0)
  // IA da campanha: liga/desliga (nasce ligada) + agente especialista opcional.
  const [botAtivo, setBotAtivo] = useState<boolean>(campaign ? campaign.bot_ativo !== false : true)
  const [agentId, setAgentId]   = useState<string>(campaign?.agent_id || '')
  // Quem acompanha: atendentes liberados a VER esta campanha (e reenviar falhas).
  // Admin/gerente já veem todas, então a lista oferece só os demais.
  const [visivelPara, setVisivelPara] = useState<string[]>(campaign?.visivel_para || [])
  // Disparos ADICIONAIS (modelo da régua): cada um com data/hora, template e
  // mapeamento próprios. O envio principal da campanha continua o de sempre.
  const [disparos, setDisparos] = useState<any[]>(
    (disparosIniciais || []).map((d: any) => ({
      id: d.id, scheduledAt: toLocalInput(d.scheduled_at), templateId: d.template_id,
      mapping: d.variable_mapping || {}, status: d.status, sent: d.sent, failed: d.failed,
    })))

  const inboxTemplates = templates.filter(t => t.inbox_id === inboxId)
  const tpl = templates.find(t => t.id === templateId) || null

  // ── Audiência: "Selecionar da base" (boletos em aberto | qualquer cliente)
  //    OU "Carregar audiência" (planilha CSV/XLSX ou colar dados) ──────────────
  const aud0 = campaign?.audience || {}
  const [audMode, setAudMode]   = useState<'base' | 'upload'>(aud0.mode === 'manual' ? 'upload' : 'base')
  const [baseKind, setBaseKind] = useState<'boletos' | 'clientes'>(aud0.base === 'clientes' ? 'clientes' : 'boletos')
  const [cfilter, setCfilter]   = useState<{ origem: string; empreendimento: string; contrato: string; nome: string; telefone: string }>({
    origem: aud0.base === 'clientes' ? (aud0.filter?.origem || 'todos') : 'todos',
    empreendimento: aud0.base === 'clientes' ? (aud0.filter?.empreendimento || '') : '',
    contrato: aud0.base === 'clientes' ? (aud0.filter?.contrato || '') : '',
    nome: aud0.base === 'clientes' ? (aud0.filter?.nome || '') : '',
    telefone: aud0.base === 'clientes' ? (aud0.filter?.telefone || '') : '',
  })
  const [sheet, setSheet]         = useState<{ headers: string[]; rows: Record<string, string>[]; fileName: string } | null>(null)
  const [phoneCol, setPhoneCol]   = useState('')
  const [nameCol, setNameCol]     = useState('')
  const [manualText, setManualText] = useState('')
  const [parseErr, setParseErr]   = useState<string | null>(null)

  function adotarPlanilha(parsed: { headers: string[]; rows: Record<string, string>[] } | null, fileName: string) {
    if (!parsed) { setParseErr('Não consegui ler os dados — a 1ª linha deve ter os cabeçalhos e as demais os contatos.'); return }
    setSheet({ ...parsed, fileName })
    setParseErr(null); setAudienceTotal(null)
    const det = detectarColunas(parsed.headers)
    setPhoneCol(det.telefone); setNameCol(det.nome)
  }

  async function handleSheetFile(f: File) {
    setParseErr(null)
    try {
      if (/\.(xlsx|xls)$/i.test(f.name)) {
        const XLSX = await import('xlsx')
        const wb = XLSX.read(await f.arrayBuffer())
        const ws = wb.Sheets[wb.SheetNames[0]]
        const matrix: string[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' }) as any
        adotarPlanilha(fromMatrix(matrix), f.name)
      } else {
        adotarPlanilha(parseDelimited(await f.text()), f.name)
      }
    } catch (e) {
      setParseErr('Falha ao ler o arquivo: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  // Colunas disponíveis para o de→para das variáveis, conforme a audiência
  const columnOptions: { value: string; label: string }[] =
    audMode === 'upload'
      ? (sheet?.headers || []).map(h => ({ value: h, label: h }))
      : baseKind === 'clientes'
        ? [
            { value: 'customer_name',  label: 'Nome do cliente' },
            { value: 'empreendimento', label: 'Empreendimento' },
            { value: 'cpf',            label: 'CPF' },
            { value: 'email',          label: 'E-mail' },
          ]
        : AVAILABLE_COLUMNS.map(c => ({ value: c, label: COLUMN_LABEL[c] }))

  // Proprietário dos disparos (OBRIGATÓRIO): as conversas da campanha nascem
  // atribuídas a ele — só ele (e admin/gerente) as vê. Opções: atendentes
  // vinculados à caixa selecionada + admins/gerentes (veem tudo).
  const [ownerId, setOwnerId] = useState<string>(campaign?.owner_id || '')
  const naoSupervisores = attendants.filter(a => a.role !== 'admin' && a.role !== 'manager')
  const inboxOwners = attendants.filter(a =>
    a.role === 'admin' || a.role === 'manager' ||
    memberships.some(m => m.attendant_id === a.id && m.inbox_id === inboxId))

  // Template com header de mídia (DOCUMENT/IMAGE/VIDEO) → exige anexar o arquivo.
  const mediaType = (tpl?.header_type || '').toUpperCase()
  const isMediaTemplate = mediaType === 'DOCUMENT' || mediaType === 'IMAGE' || mediaType === 'VIDEO'
  const mediaLabel = mediaType === 'IMAGE' ? 'imagem' : mediaType === 'VIDEO' ? 'vídeo' : 'documento'
  const mediaAccept = mediaType === 'IMAGE' ? 'image/*' : mediaType === 'VIDEO' ? 'video/*' : '.pdf,application/pdf'

  async function uploadMedia(file: File) {
    setError(null); setUploading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const fd = new FormData(); fd.append('file', file)
      const r = await fetch('/api/campaigns/media', { method: 'POST', headers: { Authorization: `Bearer ${session?.access_token}` }, body: fd })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || 'Falha no upload')
      setHeaderMediaPath(j.path); setHeaderMediaFilename(j.filename)
    } catch (e: any) { setError(e.message) } finally { setUploading(false) }
  }

  const allVars = useMemo(() => {
    if (!tpl) return [] as number[]
    const h = tpl.header_type === 'TEXT' && tpl.header_text ? varNums(tpl.header_text) : []
    const b = varNums(tpl.body_text)
    return [...new Set([...h, ...b])].sort((a, b) => a - b)
  }, [tpl])

  function setVar(n: number, patch: Partial<{ type: 'static' | 'column'; value: string; format?: string }>) {
    setMapping(m => {
      const prev = m[n] || { type: 'column' as const, value: '' }
      return { ...m, [n]: { ...prev, ...patch } }
    })
  }

  const mappingReady = allVars.every(n => mapping[n]?.value)

  async function authHeader() {
    const { data: { session } } = await supabase.auth.getSession()
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` }
  }

  // Configuração da campanha como está NA TELA. Usada ao salvar E ao iniciar/agendar:
  // o que o usuário vê é o que vai para o banco.
  function configPayload() {
    const cleanMapping: any = {}
    for (const n of allVars) {
      const m = mapping[n]
      cleanMapping[String(n)] = m.type === 'static'
        ? { type: 'static', value: m.value }
        : { type: 'column', value: m.value, ...(m.format ? { format: m.format } : {}) }
    }
    const usaUpload = isMediaTemplate && headerMediaMode === 'upload'
    return {
      name, inboxId, templateId, ownerId, variableMapping: cleanMapping,
      scheduledAt: scheduledAt || null,
      headerMediaMode: isMediaTemplate ? headerMediaMode : 'upload',
      headerMediaPath: usaUpload ? headerMediaPath : null,
      headerMediaFilename: usaUpload ? headerMediaFilename : null,
      incluirDistratados, botAtivo, agentId: botAtivo ? (agentId || null) : null,
      visivelPara,
    }
  }

  // Cria rascunho (se preciso) + resolve audiência → mostra total
  async function calcAudience() {
    setError(null)
    if (!name || !inboxId || !templateId) { setError('Preencha nome, inbox e template.'); return }
    if (!ownerId) { setError('Selecione o proprietário dos disparos.'); return }
    if (!mappingReady) { setError('Mapeie todas as variáveis do template.'); return }
    if (audMode === 'upload') {
      if (!sheet || sheet.rows.length === 0) { setError('Carregue a planilha (ou cole os dados) da audiência.'); return }
      if (!phoneCol) { setError('Indique qual coluna da planilha é o TELEFONE.'); return }
    }
    if (isMediaTemplate && headerMediaMode === 'upload' && !headerMediaPath) { setError(`Anexe o ${mediaLabel} do template antes de continuar.`); return }
    setBusy(true)
    try {
      const headers = await authHeader()
      let id = draftId
      const payload = configPayload()
      if (!id) {
        const r = await fetch('/api/campaigns', { method: 'POST', headers, body: JSON.stringify(payload) })
        const j = await r.json()
        if (!r.ok) throw new Error(j.error || 'Falha ao criar campanha')
        id = j.id; setDraftId(id)
      } else {
        // Persiste alterações de configuração (nome/inbox/template/mapping/agendamento)
        const r = await fetch(`/api/campaigns/${id}`, { method: 'PATCH', headers, body: JSON.stringify(payload) })
        const j = await r.json()
        if (!r.ok) throw new Error(j.error || 'Falha ao salvar a campanha')
      }
      // Disparos adicionais: gravados junto da configuração, com o id já garantido.
      if (disparos.length) {
        const rd = await fetch(`/api/campaigns/${id}/disparos`, {
          method: 'PUT', headers,
          body: JSON.stringify({ disparos: disparos.map(d => ({ id: d.id, scheduledAt: d.scheduledAt, templateId: d.templateId, mapping: d.mapping })) }),
        })
        const jd = await rd.json()
        if (!rd.ok) throw new Error(jd.error || 'Falha ao salvar os disparos')
        setDisparos((jd.disparos || []).map((d: any) => ({
          id: d.id, scheduledAt: toLocalInput(d.scheduled_at), templateId: d.template_id,
          mapping: d.variable_mapping || {}, status: d.status, sent: d.sent, failed: d.failed,
        })))
      }

      const audiencePayload = audMode === 'upload'
        ? { mode: 'manual', rows: sheet!.rows.map(r => ({ ...r, wa_id: r[phoneCol], ...(nameCol ? { name: r[nameCol] } : {}) })) }
        : baseKind === 'clientes'
          ? { mode: 'view', base: 'clientes', filter: cfilter }
          : { mode: 'view', base: 'boletos', filter }
      const ra = await fetch(`/api/campaigns/${id}/audience`, {
        method: 'POST', headers,
        body: JSON.stringify(audiencePayload),
      })
      const ja = await ra.json()
      if (!ra.ok) throw new Error(ja.error || 'Falha ao calcular audiência')
      setAudienceTotal(ja.total)
      setRemovidosDistrato(Number(ja.removidosDistrato) || 0)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  async function start() {
    if (!draftId) return
    setBusy(true); setError(null)
    try {
      const headers = await authHeader()
      // Regrava a configuração ANTES de disparar. Sem isso, qualquer ajuste feito
      // depois do "Salvar e calcular audiência" — inclusive desligar a IA — era
      // perdido em silêncio e a campanha saía com a configuração antiga.
      const rc = await fetch(`/api/campaigns/${draftId}`, {
        method: 'PATCH', headers, body: JSON.stringify(configPayload()),
      })
      const jc = await rc.json()
      if (!rc.ok) throw new Error(jc.error || 'Falha ao salvar a configuração antes de iniciar')

      const r = await fetch(`/api/campaigns/${draftId}/start`, { method: 'POST', headers })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || 'Falha ao iniciar')
      router.push(`/campaigns/${draftId}`)
    } catch (e: any) {
      setError(e.message); setBusy(false)
    }
  }

  return (
    <>
      <button onClick={() => router.push('/campaigns')} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4">
        <ArrowLeft className="w-4 h-4" /> Campanhas
      </button>
      <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2 mb-6">
        <Megaphone className="w-5 h-5 text-emerald-600" /> {isEdit ? 'Editar campanha' : 'Nova campanha'}
      </h1>

      <div className="space-y-6">
        {/* 1. Básico */}
        <section className="bg-white border border-gray-100 rounded-xl p-5 space-y-4">
          <div>
            <label className="text-xs font-medium text-gray-600 mb-1 block">Nome da campanha</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Ex: Cobrança junho/2026"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">Caixa de entrada</label>
              <select value={inboxId} onChange={e => {
                  const ib = e.target.value
                  setInboxId(ib); setTemplateId('')
                  // Dono precisa pertencer à nova caixa (ou ser admin/gerente)
                  const okOwner = attendants.some(a => a.id === ownerId && (a.role !== 'agent' || memberships.some(m => m.attendant_id === a.id && m.inbox_id === ib)))
                  if (!okOwner) setOwnerId('')
                }}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white">
                {inboxes.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">Template aprovado</label>
              <select value={templateId} onChange={e => { setTemplateId(e.target.value); setMapping({}); setAudienceTotal(null); setHeaderMediaPath(null); setHeaderMediaFilename(null) }}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white">
                <option value="">Selecione…</option>
                {inboxTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          </div>

          {/* Proprietário dos disparos — as conversas da campanha nascem atribuídas
              a ele (só ele + admin/gerente as veem). Opções: vinculados à caixa. */}
          <div>
            <label className="text-xs font-medium text-gray-600 mb-1 block">Proprietário dos disparos *</label>
            <select value={ownerId} onChange={e => setOwnerId(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white">
              <option value="">Selecione o responsável…</option>
              {inboxOwners.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <p className="text-[11px] text-gray-400 mt-1">
              As conversas disparadas ficam atribuídas a este usuário — apenas ele (e administradores/gerentes) as verá.
            </p>
          </div>

          {/* Atendimento por IA — interruptor (nasce ligado) + agente especialista opcional.
              Desligado: o bot fica mudo e as respostas dos leads caem na fila humana. */}
          <div className="border border-gray-200 rounded-lg p-3 bg-gray-50/60 space-y-2">
            <label className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer">
              <input type="checkbox" className="mt-0.5" checked={botAtivo}
                onChange={e => setBotAtivo(e.target.checked)} />
              <span className="font-medium">IA responde esta campanha</span>
            </label>
            <p className="text-[11px] text-gray-400 leading-relaxed">
              Ligado: o agente de IA responde automaticamente às respostas dos leads desta campanha
              por até 7 dias (o especialista abaixo ou, sem seleção, o agente padrão) e assume a
              conversa mesmo que estivesse em atendimento humano. Desligado: o bot fica mudo e as
              respostas caem na fila de atendimento humano.
            </p>
            <div className={botAtivo ? '' : 'opacity-40 pointer-events-none'}>
              <label className="text-xs font-medium text-gray-600 mb-1 block">Agente especialista (opcional)</label>
              <select value={agentId} onChange={e => setAgentId(e.target.value)} disabled={!botAtivo}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white">
                <option value="">— Agente padrão —</option>
                {agents.map(a => (
                  <option key={a.id} value={a.id}>
                    {a.avatar_emoji ? `${a.avatar_emoji} ` : ''}{a.name}{a.is_default ? ' (padrão)' : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Quem acompanha — a aba Campanhas é de admin/gerente; liberar aqui dá a um
              atendente acesso a ESTA campanha (ver progresso e reenviar falhas). */}
          {naoSupervisores.length > 0 && (
            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">Quem pode acompanhar esta campanha</label>
              <div className="flex flex-wrap gap-2">
                {naoSupervisores.map(a => {
                  const on = visivelPara.includes(a.id)
                  return (
                    <button key={a.id} type="button"
                      onClick={() => setVisivelPara(on ? visivelPara.filter(i => i !== a.id) : [...visivelPara, a.id])}
                      className={cn('text-xs px-2.5 py-1 rounded-full border transition-colors',
                        on ? 'bg-emerald-50 border-emerald-300 text-emerald-700' : 'border-gray-200 text-gray-500 hover:border-gray-300')}>
                      {on ? '✓ ' : ''}{a.name}
                    </button>
                  )
                })}
              </div>
              <p className="text-[11px] text-gray-400 mt-1">
                Quem for marcado vê esta campanha (progresso, quem recebeu e as falhas) e pode
                reenviar quem falhou. Editar e disparar continua com administradores e gerentes,
                que enxergam todas as campanhas.
              </p>
            </div>
          )}

          {/* Mídia do template (header DOCUMENT/IMAGE/VIDEO): mesmo arquivo p/ todos OU boleto de cada cliente */}
          {isMediaTemplate && (
            <div className="border border-gray-200 rounded-lg p-3 bg-gray-50/60 space-y-2">
              <p className="text-xs font-medium text-gray-700">Este template envia {mediaLabel} no cabeçalho. O que enviar?</p>
              <div className="flex flex-col gap-1.5">
                <label className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer">
                  <input type="radio" name="mediaMode" className="mt-0.5" checked={headerMediaMode === 'upload'}
                    onChange={() => setHeaderMediaMode('upload')} />
                  <span>Mesmo {mediaLabel} para todos <span className="text-gray-400">(anexar um arquivo)</span></span>
                </label>
                <label className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer">
                  <input type="radio" name="mediaMode" className="mt-0.5" checked={headerMediaMode === 'boleto'}
                    onChange={() => setHeaderMediaMode('boleto')} />
                  <span>Boleto de cada cliente <span className="text-gray-400">(o PDF do boleto de cada destinatário)</span></span>
                </label>
              </div>

              {headerMediaMode === 'upload' ? (
                <div>
                  <label className="text-xs font-medium text-gray-700 block mb-1">Anexar {mediaLabel} <span className="text-red-500">*</span></label>
                  {headerMediaPath ? (
                    <div className="flex items-center justify-between gap-2 bg-white border border-gray-200 rounded-lg px-3 py-2">
                      <span className="text-sm text-gray-700 truncate">📎 {headerMediaFilename || 'arquivo anexado'}</span>
                      <button type="button" onClick={() => { setHeaderMediaPath(null); setHeaderMediaFilename(null) }}
                        className="text-xs text-red-500 hover:text-red-600 shrink-0">remover</button>
                    </div>
                  ) : (
                    <input type="file" accept={mediaAccept} disabled={uploading}
                      onChange={e => { const f = e.target.files?.[0]; if (f) uploadMedia(f) }}
                      className="block w-full text-sm text-gray-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-emerald-50 file:text-emerald-700 hover:file:bg-emerald-100" />
                  )}
                  {uploading && <p className="text-[11px] text-gray-400 mt-1">Enviando…</p>}
                </div>
              ) : (
                <p className="text-[11px] text-gray-500">Cada destinatário recebe o PDF do próprio boleto. Quem não tiver boleto com PDF é pulado no envio.</p>
              )}
            </div>
          )}

          {tpl && (
            <MappedPreview headerText={tpl.header_text} bodyText={tpl.body_text} footerText={tpl.footer_text} mapping={mapping} />
          )}
        </section>

        {/* 2. Variáveis (de→para: coluna da audiência → variável do template) */}
        {tpl && allVars.length > 0 && (
          <section className="bg-white border border-gray-100 rounded-xl p-5 space-y-3">
            <h2 className="text-sm font-semibold text-gray-800">Mapeamento de variáveis</h2>
            {audMode === 'upload' && (
              <p className="text-[11px] text-gray-400 -mt-2">
                As opções de coluna vêm da sua planilha{sheet ? ` (${sheet.fileName})` : ' — carregue-a na seção Audiência abaixo'}.
              </p>
            )}
            {allVars.map(n => {
              const m = mapping[n] || { type: 'column', value: '' }
              return (
                <div key={n} className="flex items-center gap-2">
                  <span className="text-xs font-mono text-gray-500 w-10">{`{{${n}}}`}</span>
                  <select value={m.type} onChange={e => setVar(n, { type: e.target.value as any, value: '' })}
                    className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm bg-white">
                    <option value="column">Coluna</option>
                    <option value="static">Texto fixo</option>
                  </select>
                  {m.type === 'column' ? (
                    <select value={m.value} onChange={e => setVar(n, { value: e.target.value, format: defaultFormat(e.target.value) })}
                      className="flex-1 border border-gray-200 rounded-lg px-2 py-1.5 text-sm bg-white">
                      <option value="">Escolha a coluna…</option>
                      {columnOptions.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                    </select>
                  ) : (
                    <input value={m.value} onChange={e => setVar(n, { value: e.target.value })} placeholder="Valor fixo"
                      className="flex-1 border border-gray-200 rounded-lg px-2 py-1.5 text-sm" />
                  )}
                </div>
              )
            })}
          </section>
        )}

        {/* Disparos adicionais — mesmo modelo da régua de cobrança */}
        {tpl && (
          <section className="bg-white border border-gray-100 rounded-xl p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
                  <Send className="w-4 h-4 text-gray-500" /> Disparos adicionais
                </h2>
                <p className="text-[11px] text-gray-400 mt-0.5">
                  Toques extras para a MESMA audiência, cada um com data, template e variáveis próprios.
                  O envio principal continua sendo o de cima.
                </p>
              </div>
              <button type="button"
                onClick={() => setDisparos(d => [...d, { scheduledAt: '', templateId: '', mapping: {} }])}
                className="flex items-center gap-1 text-xs font-medium text-emerald-700 hover:text-emerald-800">
                <Plus className="w-3.5 h-3.5" /> Adicionar disparo
              </button>
            </div>

            {disparos.length === 0 ? (
              <p className="text-xs text-gray-400">Nenhum disparo adicional.</p>
            ) : disparos.map((d, idx) => {
              const dtpl = templates.find(t => t.id === d.templateId) || null
              const dvars = dtpl ? [...new Set([...varNums(dtpl.header_text || ''), ...varNums(dtpl.body_text || '')])].sort((a, b) => a - b) : []
              const enviado = d.status && d.status !== 'scheduled'
              return (
                <div key={d.id || idx} className="border border-gray-200 rounded-xl p-4 space-y-3 bg-gray-50/50">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-gray-700">
                      Disparo {idx + 1}
                      {enviado && (
                        <span className="ml-2 font-normal text-gray-400">
                          · já {d.status === 'done' ? 'concluído' : 'em envio'} ({d.sent || 0} enviados) — não editável
                        </span>
                      )}
                    </span>
                    {!enviado && (
                      <button type="button" onClick={() => setDisparos(list => list.filter((_, i) => i !== idx))}
                        className="text-gray-400 hover:text-red-500"><Trash2 className="w-3.5 h-3.5" /></button>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[11px] text-gray-500 mb-1 block">Data e hora</label>
                      <input type="datetime-local" value={d.scheduledAt} disabled={enviado}
                        onChange={e => setDisparos(l => l.map((x, i) => i === idx ? { ...x, scheduledAt: e.target.value } : x))}
                        className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm disabled:bg-gray-100" />
                    </div>
                    <div>
                      <label className="text-[11px] text-gray-500 mb-1 block">Template</label>
                      <select value={d.templateId} disabled={enviado}
                        onChange={e => setDisparos(l => l.map((x, i) => i === idx ? { ...x, templateId: e.target.value, mapping: {} } : x))}
                        className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm bg-white disabled:bg-gray-100">
                        <option value="">Selecione…</option>
                        {inboxTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                    </div>
                  </div>

                  {dvars.length > 0 && (
                    <div className="space-y-2">
                      {dvars.map(n => {
                        const m = d.mapping[n] || { type: 'column', value: '' }
                        const setDVar = (patch: any) => setDisparos(l => l.map((x, i) =>
                          i === idx ? { ...x, mapping: { ...x.mapping, [n]: { ...m, ...patch } } } : x))
                        return (
                          <div key={n} className="flex items-center gap-2">
                            <span className="text-xs font-mono text-gray-500 w-9">{`{{${n}}}`}</span>
                            <select value={m.type} disabled={enviado} onChange={e => setDVar({ type: e.target.value, value: '' })}
                              className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm bg-white disabled:bg-gray-100">
                              <option value="column">Coluna</option>
                              <option value="static">Texto fixo</option>
                            </select>
                            {m.type === 'column' ? (
                              <select value={m.value} disabled={enviado}
                                onChange={e => setDVar({ value: e.target.value, format: defaultFormat(e.target.value) })}
                                className="flex-1 border border-gray-200 rounded-lg px-2 py-1.5 text-sm bg-white disabled:bg-gray-100">
                                <option value="">Escolha a coluna…</option>
                                {columnOptions.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                              </select>
                            ) : (
                              <input value={m.value} disabled={enviado} onChange={e => setDVar({ value: e.target.value })}
                                placeholder="Valor fixo"
                                className="flex-1 border border-gray-200 rounded-lg px-2 py-1.5 text-sm disabled:bg-gray-100" />
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {dtpl && (
                    <MappedPreview headerText={dtpl.header_text} bodyText={dtpl.body_text}
                      footerText={dtpl.footer_text} mapping={d.mapping} />
                  )}
                </div>
              )
            })}
          </section>
        )}

        {/* 3. Audiência */}
        {tpl && (
          <section className="bg-white border border-gray-100 rounded-xl p-5 space-y-4">
            <h2 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
              <Users className="w-4 h-4 text-gray-500" /> Audiência
            </h2>

            {/* Como montar a audiência */}
            <div className="flex flex-col gap-1.5">
              <label className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer">
                <input type="radio" name="audMode" className="mt-0.5" checked={audMode === 'base'}
                  onChange={() => { setAudMode('base'); setAudienceTotal(null) }} />
                <span>Selecionar da base <span className="text-gray-400">(clientes do sistema, por filtro)</span></span>
              </label>
              <label className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer">
                <input type="radio" name="audMode" className="mt-0.5" checked={audMode === 'upload'}
                  onChange={() => { setAudMode('upload'); setAudienceTotal(null) }} />
                <span>Carregar audiência <span className="text-gray-400">(planilha CSV/XLSX ou colar dados)</span></span>
              </label>
            </div>

            {audMode === 'base' ? (
              <div className="space-y-4">
                <div className="flex items-center gap-4 text-sm">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="radio" name="baseKind" checked={baseKind === 'boletos'}
                      onChange={() => { setBaseKind('boletos'); setAudienceTotal(null) }} />
                    <span>Boletos em aberto</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="radio" name="baseKind" checked={baseKind === 'clientes'}
                      onChange={() => { setBaseKind('clientes'); setAudienceTotal(null) }} />
                    <span>Qualquer cliente <span className="text-gray-400">(Central, por filtro)</span></span>
                  </label>
                </div>

                {baseKind === 'boletos' ? (
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">Origem</label>
                      <select value={filter.source} onChange={e => { setFilter(f => ({ ...f, source: e.target.value })); setAudienceTotal(null) }}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white">
                        <option value="both">Sienge + SGL</option>
                        <option value="sienge">Somente Sienge</option>
                        <option value="sgl">Somente SGL</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">Empreendimento (contém)</label>
                      <input value={filter.empreendimento} onChange={e => { setFilter(f => ({ ...f, empreendimento: e.target.value })); setAudienceTotal(null) }}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="opcional" />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">Vencimento de</label>
                      <input type="date" value={filter.dueFrom} onChange={e => { setFilter(f => ({ ...f, dueFrom: e.target.value })); setAudienceTotal(null) }}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">Vencimento até</label>
                      <input type="date" value={filter.dueTo} onChange={e => { setFilter(f => ({ ...f, dueTo: e.target.value })); setAudienceTotal(null) }}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">Nome (contém)</label>
                      <input value={filter.nome} onChange={e => { setFilter(f => ({ ...f, nome: e.target.value })); setAudienceTotal(null) }}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="opcional" />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">Telefone (contém)</label>
                      <input value={filter.telefone} onChange={e => { setFilter(f => ({ ...f, telefone: e.target.value })); setAudienceTotal(null) }}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="DDD + número, pode ser parcial" />
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">Origem</label>
                      <select value={cfilter.origem} onChange={e => { setCfilter(f => ({ ...f, origem: e.target.value })); setAudienceTotal(null) }}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white">
                        <option value="todos">Todas</option>
                        <option value="sienge">Sienge</option>
                        <option value="sgl">SGL</option>
                        <option value="ambos">Ambos</option>
                        <option value="contato">Só contato</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">Empreendimento (contém)</label>
                      <input value={cfilter.empreendimento} onChange={e => { setCfilter(f => ({ ...f, empreendimento: e.target.value })); setAudienceTotal(null) }}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="opcional" />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">Situação do contrato (contém)</label>
                      <input value={cfilter.contrato} onChange={e => { setCfilter(f => ({ ...f, contrato: e.target.value })); setAudienceTotal(null) }}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="ex.: Emitido, Cancelado" />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">Nome (contém)</label>
                      <input value={cfilter.nome} onChange={e => { setCfilter(f => ({ ...f, nome: e.target.value })); setAudienceTotal(null) }}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="opcional" />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">Telefone (contém)</label>
                      <input value={cfilter.telefone} onChange={e => { setCfilter(f => ({ ...f, telefone: e.target.value })); setAudienceTotal(null) }}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="DDD + número, pode ser parcial" />
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Arquivo (.csv ou .xlsx — 1ª linha = cabeçalhos)</label>
                    <input type="file" accept=".csv,.xlsx,.xls,text/csv"
                      onChange={e => { const f = e.target.files?.[0]; if (f) handleSheetFile(f) }}
                      className="block w-full text-sm text-gray-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-emerald-50 file:text-emerald-700 hover:file:bg-emerald-100" />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">…ou cole os dados (separados por ; , ou TAB)</label>
                    <textarea value={manualText} rows={3}
                      onChange={e => setManualText(e.target.value)}
                      onBlur={() => { if (manualText.trim()) adotarPlanilha(parseDelimited(manualText), 'dados colados') }}
                      placeholder={'telefone;nome;valor\n5543999990000;Maria;R$ 100,00'}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs font-mono resize-y" />
                  </div>
                </div>

                {parseErr && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{parseErr}</p>}

                {sheet && (
                  <div className="rounded-lg border border-gray-200 bg-gray-50/60 p-3 space-y-3">
                    <p className="text-xs text-gray-700">
                      📄 <strong>{sheet.fileName}</strong> — {sheet.rows.length} contato(s), colunas:{' '}
                      {sheet.headers.map(h => <code key={h} className="bg-white border border-gray-200 rounded px-1 mx-0.5">{h}</code>)}
                    </p>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="text-xs text-gray-500 mb-1 block">Coluna do TELEFONE *</label>
                        <select value={phoneCol} onChange={e => { setPhoneCol(e.target.value); setAudienceTotal(null) }}
                          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white">
                          <option value="">Selecione…</option>
                          {sheet.headers.map(h => <option key={h} value={h}>{h}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="text-xs text-gray-500 mb-1 block">Coluna do NOME (opcional)</label>
                        <select value={nameCol} onChange={e => setNameCol(e.target.value)}
                          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white">
                          <option value="">—</option>
                          {sheet.headers.map(h => <option key={h} value={h}>{h}</option>)}
                        </select>
                      </div>
                    </div>
                    <p className="text-[11px] text-gray-400">
                      Use as colunas da planilha no <strong>Mapeamento de variáveis</strong> acima (de→para) para preencher o template.
                    </p>
                  </div>
                )}
              </div>
            )}

            <div>
              <label className="text-xs text-gray-500 mb-1 block">Agendar para (opcional)</label>
              <input type="datetime-local" value={scheduledAt} onChange={e => setScheduledAt(e.target.value)}
                className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            </div>
            <button onClick={calcAudience} disabled={busy}
              className="text-sm font-medium px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 disabled:opacity-50">
              {busy ? 'Salvando…' : isEdit ? 'Salvar e calcular audiência' : 'Calcular audiência'}
            </button>
            <label className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer">
              <input type="checkbox" className="mt-0.5" checked={incluirDistratados}
                onChange={e => { setIncluirDistratados(e.target.checked); setAudienceTotal(null) }} />
              <span>
                Incluir clientes distratados
                <span className="block text-xs text-gray-500">
                  Por padrão, quem não tem contrato ativo fica de fora — o mesmo critério das
                  réguas de cobrança. Marque apenas para reconquista ou pesquisa com ex-cliente.
                </span>
              </span>
            </label>
            {audienceTotal !== null && (
              <p className="text-sm text-gray-700">
                <strong>{audienceTotal}</strong> destinatário(s) na audiência.
                {removidosDistrato > 0 && (
                  <span className="block text-xs text-amber-700 mt-0.5">
                    {removidosDistrato} distratado(s) removido(s) da lista.
                  </span>
                )}
              </p>
            )}
          </section>
        )}

        {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}

        {/* Ações */}
        {audienceTotal !== null && audienceTotal > 0 && (
          <div className="flex justify-end gap-2">
            <button onClick={() => router.push('/campaigns')} disabled={busy}
              className="px-5 py-2.5 rounded-xl text-sm font-medium border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50">
              Salvar
            </button>
            <button onClick={start} disabled={busy}
              className={cn('flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium text-white transition-colors',
                busy ? 'bg-gray-300' : 'bg-emerald-600 hover:bg-emerald-700')}>
              <Send className="w-4 h-4" />
              {scheduledAt ? 'Salvar e agendar' : 'Salvar e enviar'}
            </button>
          </div>
        )}
      </div>
    </>
  )
}
