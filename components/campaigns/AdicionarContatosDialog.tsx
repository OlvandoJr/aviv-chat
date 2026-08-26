'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { X, Loader2, UserPlus, CheckCircle2, Info } from 'lucide-react'
import { cn } from '@/lib/utils'
import { lerArquivoPlanilha, parseDelimited, detectarColunas } from '@/lib/whatsapp/planilha'

type Etapa = 'origem' | 'conferido' | 'adicionado'

/**
 * Acrescenta contatos a uma campanha existente (mesmo encerrada).
 *
 * O fluxo é deliberadamente em dois tempos: primeiro CONFERE (dryRun, não grava)
 * e mostra quantos são realmente novos; só depois pergunta o que enviar. Isso
 * evita o pior caso — disparar de novo para quem já recebeu sem querer.
 */
export default function AdicionarContatosDialog({ campaignId, onClose }: {
  campaignId: string
  onClose: () => void
}) {
  const router = useRouter()
  const supabase = createClient()

  const [modo, setModo] = useState<'base' | 'upload'>('base')
  const [baseKind, setBaseKind] = useState<'boletos' | 'clientes'>('clientes')
  const [filtro, setFiltro] = useState({ empreendimento: '', contrato: '', nome: '', telefone: '' })
  const [sheet, setSheet] = useState<{ headers: string[]; rows: Record<string, string>[]; fileName: string } | null>(null)
  const [phoneCol, setPhoneCol] = useState('')
  const [nameCol, setNameCol] = useState('')
  const [colar, setColar] = useState('')

  const [etapa, setEtapa]   = useState<Etapa>('origem')
  const [previa, setPrevia] = useState<any>(null)
  const [busy, setBusy]     = useState(false)
  const [erro, setErro]     = useState<string | null>(null)

  function adotar(parsed: { headers: string[]; rows: Record<string, string>[] } | null, fileName: string) {
    if (!parsed) { setErro('Não consegui ler os dados — a 1ª linha deve ter os cabeçalhos.'); return }
    setErro(null)
    setSheet({ ...parsed, fileName })
    const det = detectarColunas(parsed.headers)
    setPhoneCol(det.telefone); setNameCol(det.nome)
  }

  function payloadAudiencia() {
    if (modo === 'upload') {
      return {
        mode: 'manual',
        rows: (sheet?.rows || []).map(r => ({ ...r, wa_id: r[phoneCol], ...(nameCol ? { name: r[nameCol] } : {}) })),
      }
    }
    return { mode: 'view', base: baseKind, filter: filtro }
  }

  async function chamar(path: string, body: any) {
    const { data: { session } } = await supabase.auth.getSession()
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify(body),
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j.error || 'Falha na operação.')
    return j
  }

  async function conferir() {
    setBusy(true); setErro(null)
    try {
      if (modo === 'upload' && !sheet) throw new Error('Carregue a planilha ou cole os dados.')
      if (modo === 'upload' && !phoneCol) throw new Error('Indique qual coluna é o telefone.')
      const j = await chamar(`/api/campaigns/${campaignId}/audience/add`, { ...payloadAudiencia(), dryRun: true })
      setPrevia(j); setEtapa('conferido')
    } catch (e) { setErro(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  async function adicionar() {
    setBusy(true); setErro(null)
    try {
      const j = await chamar(`/api/campaigns/${campaignId}/audience/add`, payloadAudiencia())
      setPrevia((p: any) => ({ ...p, ...j })); setEtapa('adicionado')
      router.refresh()
    } catch (e) { setErro(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  async function disparar(escopo: 'novos' | 'todos') {
    const msg = escopo === 'todos'
      ? `Reenviar para TODOS os ${previa?.total ?? ''} contatos da campanha?\n\nQuem já recebeu vai receber a mensagem outra vez.`
      : `Enviar para os ${previa?.novos ?? ''} contatos novos?`
    if (!confirm(msg)) return
    setBusy(true); setErro(null)
    try {
      await chamar(`/api/campaigns/${campaignId}/redispatch`, { escopo })
      onClose(); router.refresh()
    } catch (e) { setErro(e instanceof Error ? e.message : String(e)); setBusy(false) }
  }

  const semNovos = etapa !== 'origem' && previa?.novos === 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
            <UserPlus className="w-4 h-4 text-emerald-600" /> Adicionar contatos
          </h2>
          <button onClick={onClose} disabled={busy} className="text-gray-400 hover:text-gray-600">
            <X className="w-4 h-4" />
          </button>
        </div>

        {etapa === 'origem' && (
          <div className="space-y-3">
            <div className="flex flex-col gap-1.5">
              <label className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer">
                <input type="radio" className="mt-0.5" checked={modo === 'base'} onChange={() => setModo('base')} />
                <span>Selecionar da base <span className="text-gray-400">(clientes do sistema, por filtro)</span></span>
              </label>
              <label className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer">
                <input type="radio" className="mt-0.5" checked={modo === 'upload'} onChange={() => setModo('upload')} />
                <span>Carregar lista <span className="text-gray-400">(planilha CSV/XLSX ou colar dados)</span></span>
              </label>
            </div>

            {modo === 'base' ? (
              <div className="border border-gray-200 rounded-lg p-3 space-y-3 bg-gray-50/60">
                <div className="flex gap-4 text-sm">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="radio" checked={baseKind === 'clientes'} onChange={() => setBaseKind('clientes')} />
                    Qualquer cliente
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="radio" checked={baseKind === 'boletos'} onChange={() => setBaseKind('boletos')} />
                    Com boleto em aberto
                  </label>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Empreendimento (contém)</label>
                    <input value={filtro.empreendimento} onChange={e => setFiltro(f => ({ ...f, empreendimento: e.target.value }))}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="opcional" />
                  </div>
                  {baseKind === 'clientes' && (
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">Situação do contrato (contém)</label>
                      <input value={filtro.contrato} onChange={e => setFiltro(f => ({ ...f, contrato: e.target.value }))}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="ex.: Emitido" />
                    </div>
                  )}
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Nome (contém)</label>
                    <input value={filtro.nome} onChange={e => setFiltro(f => ({ ...f, nome: e.target.value }))}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="opcional" />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Telefone (contém)</label>
                    <input value={filtro.telefone} onChange={e => setFiltro(f => ({ ...f, telefone: e.target.value }))}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="DDD + número" />
                  </div>
                </div>
              </div>
            ) : (
              <div className="border border-gray-200 rounded-lg p-3 space-y-3 bg-gray-50/60">
                <input type="file" accept=".csv,.xlsx,.xls,text/csv"
                  onChange={async (e) => {
                    const f = e.target.files?.[0]; if (!f) return
                    adotar(await lerArquivoPlanilha(f), f.name); e.target.value = ''
                  }}
                  className="block w-full text-xs text-gray-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:bg-emerald-50 file:text-emerald-700" />
                <textarea value={colar} rows={3}
                  onChange={e => { setColar(e.target.value); if (e.target.value.trim()) adotar(parseDelimited(e.target.value), 'colado') }}
                  placeholder="…ou cole (separados por ; , ou TAB) — 1ª linha = cabeçalhos"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs font-mono" />
                {sheet && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">Coluna do telefone *</label>
                      <select value={phoneCol} onChange={e => setPhoneCol(e.target.value)}
                        className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm bg-white">
                        <option value="">Selecione…</option>
                        {sheet.headers.map(h => <option key={h} value={h}>{h}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">Coluna do nome</label>
                      <select value={nameCol} onChange={e => setNameCol(e.target.value)}
                        className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm bg-white">
                        <option value="">—</option>
                        {sheet.headers.map(h => <option key={h} value={h}>{h}</option>)}
                      </select>
                    </div>
                    <p className="col-span-2 text-[11px] text-gray-400">{sheet.rows.length} linhas em {sheet.fileName}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {etapa !== 'origem' && previa && (
          <div className="space-y-3">
            {semNovos ? (
              <div className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3">
                <Info className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-blue-800">A base já foi toda enviada nesta campanha</p>
                  <p className="text-[11px] text-blue-700/80 mt-0.5">
                    Os {previa.resolvidos} contatos que a seleção encontrou já estão na campanha. Nenhum contato novo para adicionar.
                  </p>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                <p className="text-sm font-medium text-emerald-800 flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4" />
                  {previa.novos} {previa.novos === 1 ? 'contato novo' : 'contatos novos'}
                  {etapa === 'adicionado' && ' adicionados'}
                </p>
                <p className="text-[11px] text-emerald-700/80 mt-0.5">
                  {previa.jaEstavam > 0 && `${previa.jaEstavam} já estavam na campanha e foram ignorados. `}
                  {previa.removidosDistrato > 0 && `${previa.removidosDistrato} fora por distrato. `}
                  {etapa === 'adicionado' && `A campanha agora tem ${previa.total} contatos.`}
                </p>
                {etapa === 'conferido' && previa.amostra?.length > 0 && (
                  <ul className="mt-2 text-[11px] text-emerald-900/70 space-y-0.5">
                    {previa.amostra.map((a: any) => (
                      <li key={a.wa_id}>• {a.name || a.wa_id}</li>
                    ))}
                    {previa.novos > previa.amostra.length && <li>• … e mais {previa.novos - previa.amostra.length}</li>}
                  </ul>
                )}
              </div>
            )}

            {etapa === 'adicionado' && !semNovos && (
              <div className="space-y-2">
                <p className="text-xs text-gray-600">O que você quer enviar agora?</p>
                <button onClick={() => disparar('novos')} disabled={busy}
                  className="w-full text-sm px-3 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40">
                  Enviar só para os {previa.novos} novos
                </button>
                <button onClick={() => disparar('todos')} disabled={busy}
                  className="w-full text-sm px-3 py-2 rounded-lg border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 disabled:opacity-40">
                  Reenviar para todos os {previa.total} <span className="text-amber-600">(quem já recebeu recebe de novo)</span>
                </button>
              </div>
            )}
          </div>
        )}

        {erro && <p className="text-xs text-red-600 mt-3">{erro}</p>}

        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} disabled={busy}
            className="text-sm px-3 py-2 rounded-lg text-gray-600 hover:bg-gray-100">
            {etapa === 'adicionado' ? 'Fechar' : 'Cancelar'}
          </button>
          {etapa === 'origem' && (
            <button onClick={conferir} disabled={busy}
              className={cn('text-sm px-3 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 flex items-center gap-1.5')}>
              {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Conferir
            </button>
          )}
          {etapa === 'conferido' && (
            <>
              <button onClick={() => setEtapa('origem')} disabled={busy}
                className="text-sm px-3 py-2 rounded-lg text-gray-600 hover:bg-gray-100">Voltar</button>
              {!semNovos && (
                <button onClick={adicionar} disabled={busy}
                  className="text-sm px-3 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 flex items-center gap-1.5">
                  {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Adicionar à campanha
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
