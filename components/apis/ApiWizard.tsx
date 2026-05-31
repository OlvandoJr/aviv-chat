'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft, ArrowRight, Save, Play, CheckCircle, XCircle,
  Eye, EyeOff, Trash2, Info, Clock, Plus,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import KeyValueEditor from './KeyValueEditor'
import JsonMappingTree from './JsonMappingTree'
import type { ApiConfig, KVItem, ResponseMappingItem, HttpMethod, AuthType, BodyType } from '@/lib/types'

// ─── Utils ────────────────────────────────────────────────────────────────────
function uid()  { return Math.random().toString(36).slice(2, 11) }
function mkKV() { return { id: uid(), key: '', value: '', enabled: true } as KVItem }

function extractVarNames(text: string): string[] {
  const m = [...(text || '').matchAll(/\{\{variables\.([^}]+)\}\}/g)]
  return [...new Set(m.map(x => x[1]))]
}

function getAllVars(s: WizardState): string[] {
  const sources = [
    s.url, s.body,
    ...s.headers.map(h => h.value),
    ...s.queryParams.map(p => p.value),
    ...Object.values(s.authConfig),
  ]
  return [...new Set(sources.flatMap(t => extractVarNames(t)))]
}

function resolveJsonPath(obj: any, path: string): any {
  try {
    return path
      .replace(/\[(\d+)\]/g, '.$1')
      .split('.')
      .reduce((cur, k) => cur?.[k], obj)
  } catch { return undefined }
}

// ─── Types ────────────────────────────────────────────────────────────────────
interface TestResult {
  ok:           boolean
  status?:      number
  status_text?: string
  duration_ms?: number
  body?:        any
  error?:       string
  resolved_url?: string
}

interface WizardState {
  step:         number
  name:         string
  description:  string
  method:       HttpMethod
  url:          string
  bodyType:     BodyType
  authType:     AuthType
  authConfig:   Record<string, string>
  headers:      KVItem[]
  queryParams:  KVItem[]
  body:         string
  testVars:     Record<string, string>
  testResult:   TestResult | null
  testing:      boolean
  mapping:      ResponseMappingItem[]
  saving:       boolean
  showPassword: boolean
}

function initState(api: ApiConfig | null): WizardState {
  return {
    step:         1,
    name:         api?.name        ?? '',
    description:  api?.description ?? '',
    method:       api?.method      ?? 'GET',
    url:          api?.url         ?? '',
    bodyType:     api?.body_type   ?? 'none',
    authType:     api?.auth_type   ?? 'none',
    authConfig:   (api?.auth_config as Record<string,string>) ?? {},
    headers:      (api?.headers as KVItem[])      ?? [],
    queryParams:  (api?.query_params as KVItem[]) ?? [],
    body:         api?.body_template ?? '',
    testVars:     {},
    testResult:   null,
    testing:      false,
    mapping:      (api?.response_mapping as ResponseMappingItem[]) ?? [],
    saving:       false,
    showPassword: false,
  }
}

// ─── Main wizard ─────────────────────────────────────────────────────────────
interface Props { api: ApiConfig | null }

export default function ApiWizard({ api }: Props) {
  const router  = useRouter()
  const [s, setS] = useState<WizardState>(initState(api))

  function set(partial: Partial<WizardState>) {
    setS(prev => ({ ...prev, ...partial }))
  }

  function next() { set({ step: Math.min(s.step + 1, 6) }) }
  function back() { set({ step: Math.max(s.step - 1, 1) }) }

  // ── Test request ────────────────────────────────────────────────────────────
  async function runTest() {
    set({ testing: true, testResult: null })
    try {
      const supabase = createClient()
      const { data, error } = await supabase.functions.invoke('test-api-call', {
        body: {
          method:       s.method,
          url:          s.url,
          headers:      s.headers.filter(h => h.enabled),
          queryParams:  s.queryParams.filter(p => p.enabled),
          bodyType:     s.bodyType,
          body:         s.body,
          authType:     s.authType,
          authConfig:   s.authConfig,
          testVariables: s.testVars,
        },
      })
      if (error) throw error
      set({ testResult: data, testing: false })
    } catch (err) {
      set({ testResult: { ok: false, error: String(err) }, testing: false })
    }
  }

  // ── Save ────────────────────────────────────────────────────────────────────
  async function save() {
    set({ saving: true })
    const supabase = createClient()
    const payload  = {
      name:             s.name.trim(),
      description:      s.description.trim() || null,
      method:           s.method,
      url:              s.url.trim(),
      auth_type:        s.authType,
      auth_config:      s.authConfig,
      headers:          s.headers,
      query_params:     s.queryParams,
      body_type:        s.bodyType,
      body_template:    s.body || null,
      response_mapping: s.mapping,
      is_active:        true,
      ...(s.testResult ? {
        last_tested_at:   new Date().toISOString(),
        last_test_status: s.testResult.ok ? 'success' : 'error',
      } : {}),
    }

    if (api?.id) {
      await supabase.from('chat_api_configs').update({ ...payload, updated_at: new Date().toISOString() }).eq('id', api.id)
    } else {
      await supabase.from('chat_api_configs').insert(payload)
    }

    router.push('/apis')
    router.refresh()
  }

  // ── Computed ────────────────────────────────────────────────────────────────
  const allVars      = getAllVars(s)
  const hasBody      = ['POST', 'PUT', 'PATCH'].includes(s.method)
  const canAdvance1  = s.name.trim().length > 0
  const canAdvance2  = s.url.trim().length > 3
  const statusColor  = !s.testResult ? ''
    : s.testResult.ok ? 'text-green-600' : 'text-red-600'

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-3xl mx-auto">

        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <button
            onClick={() => router.push('/apis')}
            className="p-2 text-gray-400 hover:text-gray-600 hover:bg-white rounded-lg transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-xl font-semibold text-gray-900">
              {api?.id ? `Editar: ${api.name}` : 'Nova API'}
            </h1>
            <p className="text-sm text-gray-500">
              Configure um endpoint para usar nos fluxos de automação
            </p>
          </div>
        </div>

        {/* Step progress */}
        <StepProgress current={s.step} />

        {/* Step content */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm mt-6">
          {s.step === 1 && <Step1 s={s} set={set} />}
          {s.step === 2 && <Step2 s={s} set={set} hasBody={hasBody} />}
          {s.step === 3 && <Step3 s={s} set={set} />}
          {s.step === 4 && <Step4 s={s} set={set} hasBody={hasBody} />}
          {s.step === 5 && <Step5 s={s} set={set} allVars={allVars} runTest={runTest} statusColor={statusColor} />}
          {s.step === 6 && <Step6 s={s} set={set} />}
        </div>

        {/* Navigation */}
        <div className="flex items-center justify-between mt-6">
          <button
            onClick={back}
            disabled={s.step === 1}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-600
                       border border-gray-200 rounded-xl hover:bg-gray-50 disabled:opacity-40
                       disabled:cursor-not-allowed transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Voltar
          </button>

          <span className="text-sm text-gray-400">{s.step} / 6</span>

          {s.step < 6 ? (
            <button
              onClick={next}
              disabled={(s.step === 1 && !canAdvance1) || (s.step === 2 && !canAdvance2)}
              className="flex items-center gap-2 px-5 py-2 text-sm font-semibold text-white
                         bg-emerald-600 rounded-xl hover:bg-emerald-700 disabled:opacity-40
                         disabled:cursor-not-allowed transition-colors"
            >
              Próximo
              <ArrowRight className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={save}
              disabled={s.saving || !s.name.trim()}
              className="flex items-center gap-2 px-5 py-2 text-sm font-semibold text-white
                         bg-emerald-600 rounded-xl hover:bg-emerald-700 disabled:opacity-40
                         disabled:cursor-not-allowed transition-colors"
            >
              {s.saving ? (
                <span className="flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Salvando…
                </span>
              ) : (
                <>
                  <Save className="w-4 h-4" />
                  Salvar API
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Step progress bar ───────────────────────────────────────────────────────
const STEP_LABELS = ['Identificação', 'Requisição', 'Autenticação', 'Parâmetros', 'Testar', 'Mapear Resposta']

function StepProgress({ current }: { current: number }) {
  return (
    <div className="flex items-center gap-0">
      {STEP_LABELS.map((label, i) => {
        const n    = i + 1
        const done = n < current
        const act  = n === current
        return (
          <div key={n} className="flex items-center flex-1 last:flex-none">
            <div className="flex flex-col items-center gap-1 min-w-0">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold border-2
                transition-all ${
                  done ? 'bg-emerald-500 border-emerald-500 text-white' :
                  act  ? 'bg-white border-emerald-500 text-emerald-600' :
                         'bg-white border-gray-200 text-gray-400'
                }`}>
                {done ? <CheckCircle className="w-4 h-4" /> : n}
              </div>
              <span className={`text-xs font-medium hidden sm:block ${
                act ? 'text-emerald-600' : done ? 'text-gray-500' : 'text-gray-400'
              }`}>
                {label}
              </span>
            </div>
            {i < STEP_LABELS.length - 1 && (
              <div className={`flex-1 h-0.5 mx-1 mb-5 ${n < current ? 'bg-emerald-400' : 'bg-gray-200'}`} />
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── Step 1: Identificação ───────────────────────────────────────────────────
function Step1({ s, set }: { s: WizardState; set: (p: Partial<WizardState>) => void }) {
  return (
    <div className="p-8 space-y-6">
      <StepHeader n={1} title="Identificação" sub="Dê um nome claro para identificar este endpoint nos fluxos." />

      <Field label="Nome da API" required>
        <input
          type="text"
          value={s.name}
          onChange={e => set({ name: e.target.value })}
          placeholder="Ex: Sienge — Buscar cliente por CPF"
          className={inputCls}
          autoFocus
        />
      </Field>

      <Field label="Descrição" hint="Opcional — ajuda a lembrar o propósito da API">
        <textarea
          value={s.description}
          onChange={e => set({ description: e.target.value })}
          placeholder="Busca um cliente no Sienge usando o CPF e retorna ID e nome."
          rows={3}
          className={`${inputCls} resize-none`}
        />
      </Field>
    </div>
  )
}

// ─── Step 2: Requisição ──────────────────────────────────────────────────────
const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
const METHOD_COLORS: Record<string, string> = {
  GET:    'bg-green-100  border-green-400  text-green-700',
  POST:   'bg-orange-100 border-orange-400 text-orange-700',
  PUT:    'bg-blue-100   border-blue-400   text-blue-700',
  PATCH:  'bg-yellow-100 border-yellow-400 text-yellow-700',
  DELETE: 'bg-red-100    border-red-400    text-red-700',
}
const METHOD_INACTIVE = 'bg-gray-50 border-gray-200 text-gray-400 hover:bg-gray-100'

function Step2({ s, set, hasBody }: { s: WizardState; set: (p: Partial<WizardState>) => void; hasBody: boolean }) {
  return (
    <div className="p-8 space-y-6">
      <StepHeader n={2} title="Requisição" sub="Defina o método HTTP e o endereço do endpoint." />

      <Field label="Método">
        <div className="flex gap-2 flex-wrap">
          {METHODS.map(m => (
            <button
              key={m}
              type="button"
              onClick={() => set({ method: m, bodyType: ['GET', 'DELETE'].includes(m) ? 'none' : s.bodyType })}
              className={`px-4 py-1.5 rounded-lg text-sm font-bold font-mono border-2 transition-all
                ${s.method === m ? METHOD_COLORS[m] : METHOD_INACTIVE}`}
            >
              {m}
            </button>
          ))}
        </div>
      </Field>

      <Field label="URL" required hint='Use {{variables.nome}} para valores dinâmicos'>
        <input
          type="url"
          value={s.url}
          onChange={e => set({ url: e.target.value })}
          placeholder="https://api.exemplo.com/v1/endpoint"
          className={`${inputCls} font-mono`}
        />
      </Field>

      {hasBody && (
        <Field label="Tipo de corpo">
          <div className="flex gap-3 flex-wrap">
            {(['none', 'json', 'form_data', 'urlencoded'] as BodyType[]).map(bt => (
              <label key={bt} className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="bodyType"
                  checked={s.bodyType === bt}
                  onChange={() => set({ bodyType: bt })}
                  className="accent-emerald-600"
                />
                <span className="text-sm text-gray-700 font-mono">
                  {bt === 'none' ? 'Nenhum' : bt === 'json' ? 'JSON' : bt === 'form_data' ? 'Form Data' : 'URL Encoded'}
                </span>
              </label>
            ))}
          </div>
        </Field>
      )}
    </div>
  )
}

// ─── Step 3: Autenticação ────────────────────────────────────────────────────
const AUTH_LABELS: Record<string, string> = {
  none:           'Nenhuma',
  basic:          'Basic Auth',
  bearer:         'Bearer Token',
  api_key:        'API Key',
  custom_header:  'Header customizado',
}

function Step3({ s, set }: { s: WizardState; set: (p: Partial<WizardState>) => void }) {
  function setAC(key: string, value: string) {
    set({ authConfig: { ...s.authConfig, [key]: value } })
  }

  return (
    <div className="p-8 space-y-6">
      <StepHeader n={3} title="Autenticação" sub="Configure como a API autentica as requisições." />

      <Field label="Tipo de autenticação">
        <div className="flex flex-col gap-2">
          {(Object.keys(AUTH_LABELS) as AuthType[]).map(at => (
            <label key={at} className="flex items-center gap-2.5 cursor-pointer group">
              <input
                type="radio"
                name="authType"
                checked={s.authType === at}
                onChange={() => set({ authType: at, authConfig: {} })}
                className="accent-emerald-600"
              />
              <span className={`text-sm font-medium ${s.authType === at ? 'text-gray-900' : 'text-gray-500 group-hover:text-gray-700'}`}>
                {AUTH_LABELS[at]}
              </span>
            </label>
          ))}
        </div>
      </Field>

      {s.authType !== 'none' && (
        <div className="pt-2 border-t border-gray-100 space-y-4">
          <p className="text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-2 flex items-start gap-2">
            <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            Use <code className="font-mono">{'{{env.NOME_SECRET}}'}</code> para referenciar segredos do servidor sem exposição no frontend.
          </p>

          {s.authType === 'basic' && (
            <>
              <Field label="Usuário">
                <input type="text" value={s.authConfig.username ?? ''} onChange={e => setAC('username', e.target.value)}
                  placeholder="{{env.SIENGE_USER}}" className={`${inputCls} font-mono`} />
              </Field>
              <Field label="Senha">
                <PasswordInput value={s.authConfig.password ?? ''} onChange={v => setAC('password', v)} show={s.showPassword}
                  onToggle={() => set({ showPassword: !s.showPassword })} placeholder="{{env.SIENGE_PASSWORD}}" />
              </Field>
            </>
          )}

          {s.authType === 'bearer' && (
            <Field label="Token">
              <PasswordInput value={s.authConfig.token ?? ''} onChange={v => setAC('token', v)} show={s.showPassword}
                onToggle={() => set({ showPassword: !s.showPassword })} placeholder="{{env.API_TOKEN}}" />
            </Field>
          )}

          {s.authType === 'api_key' && (
            <>
              <Field label="Nome do header/parâmetro">
                <input type="text" value={s.authConfig.key_name ?? ''} onChange={e => setAC('key_name', e.target.value)}
                  placeholder="X-Api-Key" className={`${inputCls} font-mono`} />
              </Field>
              <Field label="Valor">
                <PasswordInput value={s.authConfig.key_value ?? ''} onChange={v => setAC('key_value', v)} show={s.showPassword}
                  onToggle={() => set({ showPassword: !s.showPassword })} placeholder="{{env.API_KEY}}" />
              </Field>
              <Field label="Local">
                <div className="flex gap-4">
                  {['header', 'query'].map(loc => (
                    <label key={loc} className="flex items-center gap-1.5 cursor-pointer">
                      <input type="radio" name="keyLoc" checked={(s.authConfig.location ?? 'header') === loc}
                        onChange={() => setAC('location', loc)} className="accent-emerald-600" />
                      <span className="text-sm text-gray-700 capitalize">{loc === 'header' ? 'Header' : 'Query param'}</span>
                    </label>
                  ))}
                </div>
              </Field>
            </>
          )}

          {s.authType === 'custom_header' && (
            <>
              <Field label="Nome do header">
                <input type="text" value={s.authConfig.header_name ?? ''} onChange={e => setAC('header_name', e.target.value)}
                  placeholder="Authorization" className={`${inputCls} font-mono`} />
              </Field>
              <Field label="Valor">
                <input type="text" value={s.authConfig.header_value ?? ''} onChange={e => setAC('header_value', e.target.value)}
                  placeholder="Bearer {{env.TOKEN}}" className={`${inputCls} font-mono`} />
              </Field>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Step 4: Parâmetros ──────────────────────────────────────────────────────
const BODY_TABS = [
  { id: 'query', label: 'Query Params' },
  { id: 'headers', label: 'Headers' },
  { id: 'body', label: 'Body' },
]

function Step4({ s, set, hasBody }: { s: WizardState; set: (p: Partial<WizardState>) => void; hasBody: boolean }) {
  const [tab, setTab] = useState<'query' | 'headers' | 'body'>('query')

  // Preview URL
  const preview = (() => {
    try {
      const u = new URL(s.url || 'https://placeholder.com')
      s.queryParams.filter(p => p.enabled && p.key).forEach(p => u.searchParams.set(p.key, p.value || '…'))
      return u.toString()
    } catch { return s.url }
  })()

  return (
    <div className="p-8 space-y-6">
      <StepHeader n={4} title="Parâmetros" sub="Configure headers, query params e corpo da requisição." />

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200">
        {BODY_TABS.filter(t => t.id !== 'body' || hasBody).map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id as any)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.id
                ? 'border-emerald-500 text-emerald-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
            {t.id === 'query' && s.queryParams.filter(p => p.enabled && p.key).length > 0 &&
              <span className="ml-1.5 text-xs bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-full">
                {s.queryParams.filter(p => p.enabled && p.key).length}
              </span>
            }
            {t.id === 'headers' && s.headers.filter(h => h.enabled && h.key).length > 0 &&
              <span className="ml-1.5 text-xs bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-full">
                {s.headers.filter(h => h.enabled && h.key).length}
              </span>
            }
          </button>
        ))}
      </div>

      {tab === 'query' && (
        <div className="space-y-4">
          <KeyValueEditor items={s.queryParams} onChange={v => set({ queryParams: v })} keyPlaceholder="param" valPlaceholder="valor" />
          {s.url && (
            <div className="text-xs text-gray-500 bg-gray-50 rounded-lg p-3 font-mono break-all">
              <span className="text-gray-400 font-sans mr-1">URL resultante:</span>
              {preview}
            </div>
          )}
        </div>
      )}

      {tab === 'headers' && (
        <KeyValueEditor items={s.headers} onChange={v => set({ headers: v })} keyPlaceholder="Content-Type" valPlaceholder="application/json" />
      )}

      {tab === 'body' && hasBody && (
        <div className="space-y-3">
          {s.bodyType === 'none' ? (
            <p className="text-sm text-gray-500 italic">Nenhum corpo selecionado. Volte ao passo 2 para configurar.</p>
          ) : (
            <>
              <p className="text-xs text-gray-400">
                {s.bodyType === 'json' ? 'JSON — use {{variables.x}} para valores dinâmicos' :
                 s.bodyType === 'urlencoded' ? 'Formato: chave=valor (uma por linha)' :
                 'Formato form-data'}
              </p>
              <textarea
                value={s.body}
                onChange={e => set({ body: e.target.value })}
                rows={8}
                placeholder={s.bodyType === 'json'
                  ? '{\n  "cpf": "{{variables.cpf}}",\n  "active": true\n}'
                  : 'chave=valor\noutro={{variables.x}}'}
                className={`${inputCls} font-mono text-xs resize-y`}
              />
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Step 5: Testar ──────────────────────────────────────────────────────────
function Step5({
  s, set, allVars, runTest, statusColor,
}: {
  s: WizardState
  set: (p: Partial<WizardState>) => void
  allVars: string[]
  runTest: () => Promise<void>
  statusColor: string
}) {
  return (
    <div className="p-8 space-y-6">
      <StepHeader n={5} title="Testar Requisição" sub="Preencha os valores de teste e verifique se a API responde corretamente." />

      {/* Test variables */}
      {allVars.length > 0 && (
        <Field label="Valores de teste para as variáveis">
          <div className="space-y-2">
            {allVars.map(v => (
              <div key={v} className="flex items-center gap-2">
                <span className="text-xs font-mono text-purple-600 bg-purple-50 px-2 py-1 rounded w-48 flex-shrink-0">
                  {'{{variables.' + v + '}}'}
                </span>
                <input
                  type="text"
                  value={s.testVars[v] ?? ''}
                  onChange={e => set({ testVars: { ...s.testVars, [v]: e.target.value } })}
                  placeholder={`Valor de teste para "${v}"`}
                  className={`${inputCls} flex-1`}
                />
              </div>
            ))}
          </div>
        </Field>
      )}

      {/* URL preview */}
      {s.url && (
        <div className="text-xs text-gray-500 bg-gray-50 rounded-lg p-3 font-mono break-all">
          <span className="font-bold text-gray-400 font-sans mr-1">{s.method}</span>
          {s.url}
        </div>
      )}

      {/* Test button */}
      <button
        type="button"
        onClick={runTest}
        disabled={s.testing || !s.url}
        className="w-full flex items-center justify-center gap-2 py-3 text-sm font-semibold
                   bg-blue-600 text-white rounded-xl hover:bg-blue-700 disabled:opacity-50
                   disabled:cursor-not-allowed transition-colors"
      >
        {s.testing ? (
          <>
            <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            Enviando…
          </>
        ) : (
          <>
            <Play className="w-4 h-4" />
            Enviar Requisição
          </>
        )}
      </button>

      {/* Response */}
      {s.testResult && (
        <div className="border border-gray-200 rounded-xl overflow-hidden">
          {/* Status bar */}
          <div className="flex items-center gap-3 px-4 py-2.5 bg-gray-50 border-b border-gray-200">
            {s.testResult.ok
              ? <CheckCircle className="w-4 h-4 text-green-500" />
              : <XCircle    className="w-4 h-4 text-red-500"   />
            }
            <span className={`font-mono text-sm font-bold ${statusColor}`}>
              {s.testResult.status} {s.testResult.status_text}
            </span>
            {s.testResult.duration_ms != null && (
              <span className="ml-auto flex items-center gap-1 text-xs text-gray-400">
                <Clock className="w-3 h-3" />
                {s.testResult.duration_ms}ms
              </span>
            )}
          </div>

          {/* Body */}
          <div className="p-4 max-h-72 overflow-auto">
            {s.testResult.error ? (
              <p className="text-red-600 text-sm font-mono">{s.testResult.error}</p>
            ) : (
              <pre className="text-xs font-mono text-gray-700 whitespace-pre-wrap break-all">
                {JSON.stringify(s.testResult.body, null, 2)}
              </pre>
            )}
          </div>

          {s.testResult.ok && (
            <div className="px-4 py-2.5 bg-emerald-50 border-t border-emerald-200 text-xs text-emerald-700">
              ✓ Teste bem-sucedido. Avance para mapear os campos da resposta como variáveis.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Step 6: Mapear resposta ─────────────────────────────────────────────────
function Step6({ s, set }: { s: WizardState; set: (p: Partial<WizardState>) => void }) {
  function addMapping(item: ResponseMappingItem) {
    set({ mapping: [...s.mapping, item] })
  }
  function removeMapping(id: string) {
    set({ mapping: s.mapping.filter(m => m.id !== id) })
  }

  const responseBody = s.testResult?.body

  return (
    <div className="p-8 space-y-6">
      <StepHeader n={6} title="Mapear Resposta"
        sub="Clique em um valor do JSON para criar uma variável que poderá ser usada nos próximos passos do fluxo." />

      {!responseBody && !s.testResult ? (
        <div className="text-center py-12 text-gray-400">
          <p className="text-sm">Nenhuma resposta de teste disponível.</p>
          <p className="text-xs mt-1">Volte ao passo 5 e execute um teste para mapear os campos.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-6">
          {/* JSON tree */}
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
              Resposta — clique em um valor para mapear
            </p>
            <div className="border border-gray-200 rounded-xl p-4 overflow-auto max-h-96 bg-gray-50">
              {typeof responseBody === 'object' && responseBody !== null ? (
                <JsonMappingTree data={responseBody} mappings={s.mapping} onAdd={addMapping} />
              ) : (
                <pre className="text-xs font-mono text-gray-600">{String(responseBody)}</pre>
              )}
            </div>
          </div>

          {/* Mapping table */}
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
              Variáveis mapeadas
            </p>
            {s.mapping.length === 0 ? (
              <div className="border-2 border-dashed border-gray-200 rounded-xl p-6 text-center text-gray-400 text-sm">
                Nenhuma variável mapeada ainda.
                <br />
                <span className="text-xs">Clique nos valores do JSON ao lado.</span>
              </div>
            ) : (
              <div className="space-y-2">
                {s.mapping.map(m => (
                  <div key={m.id} className="flex items-start gap-2 p-3 bg-gray-50 rounded-xl border border-gray-200">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-mono font-bold text-emerald-700">
                          {'{{variables.' + m.variable_name + '}}'}
                        </span>
                      </div>
                      <span className="text-xs font-mono text-gray-500 truncate block">
                        ← {m.json_path}
                      </span>
                      {m.example && (
                        <span className="text-xs text-gray-400 truncate block">
                          Ex: {m.example}
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => removeMapping(m.id)}
                      className="p-1 text-gray-300 hover:text-red-500 flex-shrink-0 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Manual add */}
            <button
              type="button"
              onClick={() => addMapping({
                id: Math.random().toString(36).slice(2),
                variable_name: '',
                json_path:     '',
                description:   '',
              })}
              className="mt-3 flex items-center gap-1.5 text-sm text-emerald-600 hover:text-emerald-700 font-medium"
            >
              <Plus className="w-4 h-4" />
              Adicionar manualmente
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Shared sub-components ───────────────────────────────────────────────────
function StepHeader({ n, title, sub }: { n: number; title: string; sub: string }) {
  return (
    <div className="pb-4 border-b border-gray-100">
      <div className="flex items-center gap-2 mb-1">
        <span className="w-6 h-6 rounded-full bg-emerald-100 text-emerald-700 text-xs font-bold flex items-center justify-center">
          {n}
        </span>
        <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
      </div>
      <p className="text-sm text-gray-500 ml-8">{sub}</p>
    </div>
  )
}

function Field({ label, children, required, hint }: {
  label:     string
  children:  React.ReactNode
  required?: boolean
  hint?:     string
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium text-gray-700">
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {hint && <p className="text-xs text-gray-400">{hint}</p>}
      {children}
    </div>
  )
}

function PasswordInput({ value, onChange, show, onToggle, placeholder }: {
  value:       string
  onChange:    (v: string) => void
  show:        boolean
  onToggle:    () => void
  placeholder?: string
}) {
  return (
    <div className="relative">
      <input
        type={show ? 'text' : 'password'}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className={`${inputCls} font-mono pr-10`}
      />
      <button
        type="button"
        onClick={onToggle}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
      >
        {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  )
}

const inputCls = `w-full text-sm px-3 py-2 border border-gray-200 rounded-xl
  focus:outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100
  bg-white placeholder:text-gray-300 transition-colors`
