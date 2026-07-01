'use client'

import { useRef, useState } from 'react'
import { useRouter }        from 'next/navigation'
import { UploadCloud, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react'
import { createClient }     from '@/lib/supabase/client'

// Lê a resposta com segurança: se não for JSON (ex.: 413 "Request Entity Too
// Large" em texto), devolve o texto como erro em vez de estourar JSON.parse.
async function readJson(r: Response): Promise<any> {
  const t = await r.text()
  try { return JSON.parse(t) } catch { return { error: (t || '').trim().slice(0, 200) || `Erro ${r.status}` } }
}

interface Resultado {
  ok: boolean
  recebidos: number
  gravados: number
  com_pdf: number
  sem_telefone: number
  falhas: { arquivo: string; motivo: string }[]
}

export default function BoletoUpload() {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [loading, setLoading]   = useState(false)
  const [erro, setErro]         = useState<string | null>(null)
  const [res, setRes]           = useState<Resultado | null>(null)

  async function enviar(file: File) {
    if (!/\.zip$/i.test(file.name)) { setErro('Selecione um arquivo .zip'); return }
    setErro(null); setRes(null); setLoading(true)
    try {
      // 1) pede uma URL assinada e sobe o ZIP DIRETO no Storage — evita o limite
      //    de ~4.5 MB do corpo da requisição nas funções da Vercel.
      const signResp = await fetch('/api/boletos/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sign' }),
      })
      const sign = await readJson(signResp)
      if (!signResp.ok || !sign?.token) throw new Error(sign?.error || 'Falha ao preparar o upload')

      const supabase = createClient()
      const { error: upErr } = await supabase.storage
        .from('boletos')
        .uploadToSignedUrl(sign.path, sign.token, file, { contentType: 'application/zip' })
      if (upErr) throw new Error('Falha ao enviar o ZIP: ' + upErr.message)

      // 2) processa o ZIP a partir do Storage (corpo minúsculo = só o caminho)
      const r = await fetch('/api/boletos/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: sign.path, filename: file.name }),
      })
      const data = await readJson(r)
      if (!r.ok) { setErro(data.error || 'Falha ao importar'); if (data.falhas) setRes({ ...data, ok: false }) }
      else { setRes(data); router.refresh() }
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault(); setDragging(false)
          const f = e.dataTransfer.files?.[0]; if (f) enviar(f)
        }}
        onClick={() => inputRef.current?.click()}
        className={`rounded-xl border-2 border-dashed p-10 text-center cursor-pointer transition-colors ${
          dragging ? 'border-emerald-400 bg-emerald-50' : 'border-gray-300 bg-white hover:bg-gray-50'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) enviar(f) }}
        />
        {loading ? (
          <div className="flex flex-col items-center gap-2 text-gray-500">
            <Loader2 className="w-7 h-7 animate-spin" />
            <span className="text-sm">Processando ZIP, extraindo PDFs…</span>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 text-gray-500">
            <UploadCloud className="w-7 h-7" />
            <span className="text-sm"><strong>Arraste o ZIP aqui</strong> ou clique para selecionar</span>
          </div>
        )}
      </div>

      {erro && (
        <div className="flex items-start gap-2 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> <span>{erro}</span>
        </div>
      )}

      {res && (
        <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm">
            <CheckCircle2 className="w-5 h-5 text-emerald-500" />
            <span className="text-gray-800">
              <strong>{res.gravados}</strong> gravados · <strong>{res.com_pdf}</strong> com PDF ·{' '}
              {res.recebidos} PDFs no ZIP
              {res.sem_telefone > 0 && <span className="text-amber-600"> · {res.sem_telefone} sem telefone</span>}
            </span>
          </div>

          {res.falhas?.length > 0 && (
            <div>
              <p className="text-xs font-medium text-amber-700 mb-1 flex items-center gap-1">
                <AlertTriangle className="w-3.5 h-3.5" /> {res.falhas.length} para revisão manual
              </p>
              <ul className="text-xs text-gray-600 space-y-0.5 max-h-48 overflow-y-auto">
                {res.falhas.map((f, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="font-mono text-gray-500 truncate max-w-[50%]">{f.arquivo}</span>
                    <span className="text-amber-600">— {f.motivo}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
