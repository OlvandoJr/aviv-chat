'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { ArrowLeft, Megaphone, Users, Send } from 'lucide-react'
import { AVAILABLE_COLUMNS, COLUMN_LABEL } from '@/lib/whatsapp/vars'
import MappedPreview from '@/components/whatsapp/MappedPreview'
import { cn } from '@/lib/utils'

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

export default function CampaignWizard({ inboxes, templates, campaign, attendants = [], memberships = [] }: Props) {
  const router = useRouter()
  const supabase = createClient()
  const isEdit = !!campaign

  const toLocalInput = (iso: string | null) => iso ? new Date(iso).toISOString().slice(0, 16) : ''

  const [name, setName]       = useState(campaign?.name || '')
  const [inboxId, setInboxId] = useState(campaign?.inbox_id || inboxes[0]?.id || '')
  const [templateId, setTemplateId] = useState(campaign?.template_id || '')
  const [mapping, setMapping] = useState<Record<string, { type: 'static' | 'column'; value: string; format?: string }>>(campaign?.variable_mapping || {})
  const [filter, setFilter]   = useState<{ source: string; dueFrom: string; dueTo: string; empreendimento: string }>(
    { source: campaign?.audience?.filter?.source || 'both', dueFrom: campaign?.audience?.filter?.dueFrom || '',
      dueTo: campaign?.audience?.filter?.dueTo || '', empreendimento: campaign?.audience?.filter?.empreendimento || '' })
  const [scheduledAt, setScheduledAt] = useState(toLocalInput(campaign?.scheduled_at || null))
  const [headerMediaPath, setHeaderMediaPath]         = useState<string | null>(campaign?.header_media_path || null)
  const [headerMediaFilename, setHeaderMediaFilename] = useState<string | null>(campaign?.header_media_filename || null)
  const [headerMediaMode, setHeaderMediaMode]         = useState<'upload' | 'boleto'>(campaign?.header_media_mode === 'boleto' ? 'boleto' : 'upload')
  const [uploading, setUploading] = useState(false)

  const [busy, setBusy]   = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draftId, setDraftId] = useState<string | null>(campaign?.id || null)
  const [audienceTotal, setAudienceTotal] = useState<number | null>(null)

  const inboxTemplates = templates.filter(t => t.inbox_id === inboxId)
  const tpl = templates.find(t => t.id === templateId) || null

  // Proprietário dos disparos (OBRIGATÓRIO): as conversas da campanha nascem
  // atribuídas a ele — só ele (e admin/gerente) as vê. Opções: atendentes
  // vinculados à caixa selecionada + admins/gerentes (veem tudo).
  const [ownerId, setOwnerId] = useState<string>(campaign?.owner_id || '')
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

  // Cria rascunho (se preciso) + resolve audiência → mostra total
  async function calcAudience() {
    setError(null)
    if (!name || !inboxId || !templateId) { setError('Preencha nome, inbox e template.'); return }
    if (!ownerId) { setError('Selecione o proprietário dos disparos.'); return }
    if (!mappingReady) { setError('Mapeie todas as variáveis do template.'); return }
    if (isMediaTemplate && headerMediaMode === 'upload' && !headerMediaPath) { setError(`Anexe o ${mediaLabel} do template antes de continuar.`); return }
    setBusy(true)
    try {
      const headers = await authHeader()
      let id = draftId
      const cleanMapping: any = {}
      for (const n of allVars) {
        const m = mapping[n]
        cleanMapping[String(n)] = m.type === 'static'
          ? { type: 'static', value: m.value }
          : { type: 'column', value: m.value, ...(m.format ? { format: m.format } : {}) }
      }
      const usaUpload = isMediaTemplate && headerMediaMode === 'upload'
      const payload = { name, inboxId, templateId, ownerId, variableMapping: cleanMapping, scheduledAt: scheduledAt || null,
        headerMediaMode: isMediaTemplate ? headerMediaMode : 'upload',
        headerMediaPath: usaUpload ? headerMediaPath : null,
        headerMediaFilename: usaUpload ? headerMediaFilename : null }
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
      const ra = await fetch(`/api/campaigns/${id}/audience`, {
        method: 'POST', headers,
        body: JSON.stringify({ mode: 'view', filter }),
      })
      const ja = await ra.json()
      if (!ra.ok) throw new Error(ja.error || 'Falha ao calcular audiência')
      setAudienceTotal(ja.total)
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

        {/* 2. Variáveis */}
        {tpl && allVars.length > 0 && (
          <section className="bg-white border border-gray-100 rounded-xl p-5 space-y-3">
            <h2 className="text-sm font-semibold text-gray-800">Mapeamento de variáveis</h2>
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
                      {AVAILABLE_COLUMNS.map(c => <option key={c} value={c}>{COLUMN_LABEL[c]}</option>)}
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

        {/* 3. Audiência */}
        {tpl && (
          <section className="bg-white border border-gray-100 rounded-xl p-5 space-y-4">
            <h2 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
              <Users className="w-4 h-4 text-gray-500" /> Audiência (boletos em aberto)
            </h2>
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
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Agendar para (opcional)</label>
              <input type="datetime-local" value={scheduledAt} onChange={e => setScheduledAt(e.target.value)}
                className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            </div>
            <button onClick={calcAudience} disabled={busy}
              className="text-sm font-medium px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 disabled:opacity-50">
              {busy ? 'Salvando…' : isEdit ? 'Salvar e calcular audiência' : 'Calcular audiência'}
            </button>
            {audienceTotal !== null && (
              <p className="text-sm text-gray-700">
                <strong>{audienceTotal}</strong> destinatário(s) na audiência.
              </p>
            )}
          </section>
        )}

        {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}

        {/* Ações */}
        {audienceTotal !== null && audienceTotal > 0 && (
          <div className="flex justify-end">
            <button onClick={start} disabled={busy}
              className={cn('flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium text-white transition-colors',
                busy ? 'bg-gray-300' : 'bg-emerald-600 hover:bg-emerald-700')}>
              <Send className="w-4 h-4" />
              {scheduledAt ? 'Agendar campanha' : `Enviar para ${audienceTotal}`}
            </button>
          </div>
        )}
      </div>
    </>
  )
}
