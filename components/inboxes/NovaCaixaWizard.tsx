'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { ArrowLeft, Zap, KeyRound, MessageSquare, Smartphone, Camera, Loader2, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import InboxEditor from './InboxEditor'

/**
 * Nova caixa de entrada — seleção em duas etapas:
 *   1) MÉTODO: Cadastro Incorporado (Embedded Signup da Meta) ou Cadastro Manual
 *   2) CANAL:  WhatsApp Oficial (Cloud API) · WhatsApp Não Oficial · Instagram
 *
 * Manual + WhatsApp Oficial reusa o InboxEditor de sempre. Incorporado +
 * WhatsApp Oficial abre o fluxo oficial da Meta (login no Facebook → a Meta
 * devolve WABA e número → trocamos o código por token no servidor e a caixa é
 * criada sozinha). Os demais canais aparecem como "em breve" — ainda não têm
 * backend nesta plataforma.
 */

type Metodo = 'incorporado' | 'manual'
type Canal  = 'wa_oficial' | 'wa_nao_oficial' | 'instagram'

const APP_ID    = process.env.NEXT_PUBLIC_META_APP_ID || ''
const CONFIG_ID = process.env.NEXT_PUBLIC_META_ES_CONFIG_ID || ''

declare global {
  interface Window { FB?: any; fbAsyncInit?: () => void }
}

export default function NovaCaixaWizard() {
  const router = useRouter()
  const [metodo, setMetodo] = useState<Metodo | null>(null)
  const [canal,  setCanal]  = useState<Canal | null>(null)

  const escolherCanal = (c: Canal) => setCanal(c)

  // Manual + WhatsApp Oficial → formulário clássico
  if (metodo === 'manual' && canal === 'wa_oficial') {
    return <InboxEditor inbox={null} />
  }

  return (
    <div className="max-w-2xl mx-auto px-6 py-8">
      <button onClick={() => (canal ? setCanal(null) : metodo ? setMetodo(null) : router.push('/inboxes'))}
        className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4">
        <ArrowLeft className="w-4 h-4" /> {canal || metodo ? 'Voltar' : 'Caixas de Entrada'}
      </button>
      <h1 className="text-xl font-bold text-gray-900 mb-6">Nova caixa de entrada</h1>

      {/* Etapa 1 — método */}
      {!metodo && (
        <div className="space-y-3">
          <p className="text-sm text-gray-500 mb-4">Como você quer conectar a conta?</p>
          <CartaoOpcao
            icone={<Zap className="w-5 h-5" />}
            titulo="Cadastro Incorporado"
            descricao="Conecte pela própria Meta: você faz login, escolhe a conta e o número, e a caixa é configurada automaticamente — sem copiar tokens."
            onClick={() => setMetodo('incorporado')}
          />
          <CartaoOpcao
            icone={<KeyRound className="w-5 h-5" />}
            titulo="Cadastro Manual"
            descricao="Informe você mesmo as credenciais (Phone Number ID, WABA ID e Access Token) geradas no painel da Meta."
            onClick={() => setMetodo('manual')}
          />
        </div>
      )}

      {/* Etapa 2 — canal */}
      {metodo && !canal && (
        <div className="space-y-3">
          <p className="text-sm text-gray-500 mb-4">
            Qual canal? <span className="text-gray-400">
              ({metodo === 'incorporado' ? 'Cadastro Incorporado' : 'Cadastro Manual'})
            </span>
          </p>
          <CartaoOpcao
            icone={<MessageSquare className="w-5 h-5" />}
            titulo="WhatsApp Oficial"
            descricao="API oficial do WhatsApp Business (Cloud API da Meta). Templates aprovados, número verificado."
            onClick={() => escolherCanal('wa_oficial')}
          />
          <CartaoOpcao
            icone={<Smartphone className="w-5 h-5" />}
            titulo="WhatsApp Não Oficial"
            descricao="Conexão via QR Code, sem a API oficial."
            emBreve
            onClick={() => escolherCanal('wa_nao_oficial')}
          />
          <CartaoOpcao
            icone={<Camera className="w-5 h-5" />}
            titulo="Instagram"
            descricao="Mensagens diretas do Instagram."
            emBreve
            onClick={() => escolherCanal('instagram')}
          />
        </div>
      )}

      {/* Combinações ainda não disponíveis */}
      {metodo && (canal === 'wa_nao_oficial' || canal === 'instagram') && (
        <div className="border border-gray-200 rounded-xl p-6 bg-gray-50 text-center">
          <p className="text-sm font-medium text-gray-700">
            {canal === 'instagram' ? 'Instagram' : 'WhatsApp Não Oficial'} — em breve
          </p>
          <p className="text-xs text-gray-500 mt-1">
            Este canal ainda não está disponível na plataforma. Por enquanto, use o
            WhatsApp Oficial.
          </p>
        </div>
      )}

      {/* Incorporado + WhatsApp Oficial → Embedded Signup */}
      {metodo === 'incorporado' && canal === 'wa_oficial' && <EmbeddedSignup />}
    </div>
  )
}

function CartaoOpcao({ icone, titulo, descricao, emBreve, onClick }: {
  icone: React.ReactNode; titulo: string; descricao: string; emBreve?: boolean; onClick: () => void
}) {
  return (
    <button onClick={onClick}
      className={cn(
        'w-full flex items-start gap-4 p-4 rounded-xl border text-left transition-colors',
        emBreve ? 'border-gray-200 bg-gray-50/60 hover:border-gray-300' : 'border-gray-200 bg-white hover:border-emerald-300 hover:bg-emerald-50/40',
      )}>
      <div className={cn('w-10 h-10 rounded-lg flex items-center justify-center shrink-0',
        emBreve ? 'bg-gray-200 text-gray-500' : 'bg-emerald-100 text-emerald-700')}>
        {icone}
      </div>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-gray-800 flex items-center gap-2">
          {titulo}
          {emBreve && <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-full bg-gray-200 text-gray-500">Em breve</span>}
        </p>
        <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{descricao}</p>
      </div>
    </button>
  )
}

/**
 * Fluxo oficial de Embedded Signup (Meta):
 *  1. Carrega o SDK do Facebook e chama FB.login com o config_id do fluxo.
 *  2. A janela da Meta devolve, por postMessage (WA_EMBEDDED_SIGNUP), o waba_id e
 *     o phone_number_id que o usuário escolheu; o FB.login devolve um `code`.
 *  3. Mandamos os três ao servidor, que troca o code por token, assina o app na
 *     WABA, registra o número e CRIA a caixa — daí abrimos o editor para revisar.
 */
function EmbeddedSignup() {
  const router = useRouter()
  const supabase = createClient()
  const [sdkPronto, setSdkPronto] = useState(false)
  const [fase, setFase] = useState<'idle' | 'meta' | 'trocando' | 'ok'>('idle')
  const [erro, setErro] = useState<string | null>(null)
  // Coexistência: número que JÁ usa o app WhatsApp Business no celular e continua
  // usando — o featureType muda o fluxo da Meta para esse modo.
  const [coexistencia, setCoexistencia] = useState(false)
  // ids chegam por postMessage; o code chega pelo callback do FB.login — juntamos os dois
  const idsRef = useRef<{ waba_id?: string; phone_number_id?: string; evento?: string }>({})

  // Auditoria da jornada (meta_signup_log): saber em que tela a pessoa travou
  // vale mais que o erro genérico. Best-effort — nunca bloqueia o fluxo.
  async function logar(evento: string, dados?: unknown) {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      await fetch('/api/inboxes/signup-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ evento, dados: dados ?? null }),
      })
    } catch { /* auditoria não derruba cadastro */ }
  }

  const configurado = !!APP_ID && !!CONFIG_ID

  // Retorno do modo redirecionamento: a Meta devolve ?code= nesta mesma URL.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    const code = q.get('code')
    if (!code) {
      const err = q.get('error_description') || q.get('error')
      if (err) { setErro(`A Meta recusou o cadastro: ${err}`); logar('redirect_erro', { err }) }
      return
    }
    const estadoOk = (() => {
      try { return sessionStorage.getItem('meta_es_state') === q.get('state') } catch { return true }
    })()
    let coex = coexistencia
    try { coex = sessionStorage.getItem('meta_es_coex') === '1' } catch { /* usa o checkbox */ }
    // Limpa a URL para um F5 não reenviar o mesmo code (que a Meta já invalidou).
    window.history.replaceState({}, '', '/inboxes/new')
    if (!estadoOk) { setErro('Retorno da Meta não confere com esta sessão. Tente conectar de novo.'); return }

    ;(async () => {
      setFase('trocando')
      logar('redirect_volta', { coex })
      try {
        const { data: { session } } = await supabase.auth.getSession()
        const r = await fetch('/api/inboxes/embedded-signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
          body: JSON.stringify({ code, evento: coex ? 'finish_coexistence' : 'finish' }),
        })
        const j = await r.json()
        if (!r.ok) { logar('backend_erro', { erro: j.error }); throw new Error(j.error || 'Falha ao concluir o cadastro.') }
        logar('backend_ok', { inboxId: j.inboxId, avisos: j.avisos })
        setFase('ok')
        router.push(`/inboxes/${j.inboxId}`)
      } catch (e) {
        setFase('idle')
        setErro(e instanceof Error ? e.message : String(e))
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!configurado) return
    let cancelado = false

    // O SDK chama fbAsyncInit UMA vez, quando carrega. Se o componente remonta
    // (voltar para a tela, StrictMode em dev), a nova instância registra um
    // fbAsyncInit que nunca mais é chamado — o botão ficava preso em "Carregando
    // o SDK" e, pior, o FB.init podia não rodar nesta instância, fazendo o
    // FB.login falhar sem abrir janela nenhuma. Por isso: tentamos inicializar
    // já, registramos o callback E deixamos um poll de segurança.
    const tentarInit = (): boolean => {
      if (!window.FB) return false
      try { window.FB.init({ appId: APP_ID, autoLogAppEvents: true, xfbml: false, version: 'v20.0' }) } catch { /* init repetido é inofensivo */ }
      if (!cancelado) setSdkPronto(true)
      return true
    }

    let poll: ReturnType<typeof setInterval> | undefined
    if (!tentarInit()) {
      window.fbAsyncInit = () => { tentarInit() }
      if (!document.getElementById('facebook-jssdk')) {
        const js = document.createElement('script')
        js.id = 'facebook-jssdk'
        js.src = 'https://connect.facebook.net/en_US/sdk.js'
        js.async = true; js.defer = true
        document.body.appendChild(js)
      }
      // Rede de segurança para o caso do script já estar carregado (remount).
      poll = setInterval(() => { if (tentarInit() && poll) clearInterval(poll) }, 300)
      setTimeout(() => poll && clearInterval(poll), 20000)
    }

    const onMessage = (event: MessageEvent) => {
      if (!String(event.origin).endsWith('facebook.com')) return
      try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data
        if (data?.type !== 'WA_EMBEDDED_SIGNUP') return
        // FINISH = fluxo padrão; FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING = coexistência.
        if (data.event === 'FINISH' || data.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING') {
          // O EVENTO REAL decide o ramo do backend (register vs smb_app_data) —
          // não o checkbox: a pessoa pode marcar coexistência e a Meta concluir
          // o fluxo padrão, ou vice-versa.
          idsRef.current = {
            waba_id:        data.data?.waba_id,
            phone_number_id: data.data?.phone_number_id,
            evento:         data.event === 'FINISH' ? 'finish' : 'finish_coexistence',
          }
          logar(idsRef.current.evento!, data.data)
        } else if (data.event === 'CANCEL') {
          // current_step = a TELA em que a pessoa desistiu — ouro para o suporte.
          logar('cancel', data.data)
          setFase('idle')
          setErro(`Cadastro cancelado${data.data?.current_step ? ` na etapa "${data.data.current_step}"` : ''}.`)
        } else if (data.event === 'ERROR') {
          logar('error', data.data)
          setFase('idle')
          setErro(`A Meta reportou um erro: ${data.data?.error_message || 'sem detalhes'}`)
        }
      } catch { /* mensagens de outros widgets da Meta — ignora */ }
    }
    window.addEventListener('message', onMessage)
    return () => {
      cancelado = true
      if (poll) clearInterval(poll)
      window.removeEventListener('message', onMessage)
    }
  }, [configurado])

  async function iniciar() {
    setErro(null); setFase('meta')
    logar('login_click', { coexistencia })
    // Popup bloqueado não gera NENHUM callback — sem este timeout o botão ficava
    // preso em "Aguardando a Meta…" para sempre (aconteceu no Arc e no Safari,
    // que bloqueiam popup silenciosamente por padrão).
    const timeout = setTimeout(() => {
      setFase((f) => {
        if (f !== 'meta') return f
        setErro('A janela da Meta não respondeu. Use o botão "Conectar sem janela pop-up" abaixo — '
          + 'ele faz o mesmo cadastro pela própria aba, sem depender de pop-up.')
        logar('popup_sem_resposta', { coexistencia })
        return 'idle'
      })
    }, 60000)

    // O SDK precisa existir DE FATO: `window.FB?.login(...)` com FB indefinido não
    // faz nada e não avisa — era um dos caminhos possíveis do silêncio observado.
    const fb = window.FB
    if (!fb?.login) {
      clearTimeout(timeout)
      setFase('idle')
      setErro('O SDK da Meta não carregou nesta página (connect.facebook.net bloqueado por extensão, '
        + 'rede ou modo de navegação). Recarregue com ⌘⇧R; se persistir, desative bloqueadores para este site.')
      logar('sdk_ausente')
      return
    }

    try {
      // Garante que ESTA instância da página inicializou o SDK antes de logar.
      fb.init({ appId: APP_ID, autoLogAppEvents: true, xfbml: false, version: 'v20.0' })
    } catch (e) {
      logar('fb_init_excecao', { msg: String(e) })
    }

    try {
    fb.login(async (resp: any) => {
      clearTimeout(timeout)
      const code = resp?.authResponse?.code
      if (!code) { setFase('idle'); setErro('Login cancelado ou não autorizado na Meta.'); return }
      setFase('trocando')
      try {
        const { data: { session } } = await supabase.auth.getSession()
        const r = await fetch('/api/inboxes/embedded-signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
          body: JSON.stringify({ code, ...idsRef.current }),
        })
        const j = await r.json()
        if (!r.ok) { logar('backend_erro', { erro: j.error }); throw new Error(j.error || 'Falha ao concluir o cadastro.') }
        logar('backend_ok', { inboxId: j.inboxId, avisos: j.avisos })
        setFase('ok')
        router.push(`/inboxes/${j.inboxId}`)
      } catch (e) {
        setFase('idle')
        setErro(e instanceof Error ? e.message : String(e))
      }
    }, {
      config_id: CONFIG_ID,
      response_type: 'code',
      override_default_response_type: true,
      extras: {
        setup: {},
        sessionInfoVersion: '3',
        ...(coexistencia ? { featureType: 'whatsapp_business_app_onboarding' } : {}),
      },
    })
    } catch (e) {
      // Exceção síncrona do SDK (config_id inválido, produto não habilitado,
      // versão sem suporte a Business Login): sem isto ela sumia numa promessa
      // rejeitada e a tela só dizia "não respondeu".
      clearTimeout(timeout)
      setFase('idle')
      const msg = e instanceof Error ? e.message : String(e)
      setErro(`O SDK da Meta recusou a chamada: ${msg}`)
      logar('fb_login_excecao', { msg })
    }
  }

  // ── Modo redirecionamento (sem pop-up) ───────────────────────────────────
  // O SDK depende de uma janela pop-up que alguns navegadores engolem em
  // silêncio. Este caminho leva a própria aba ao diálogo oficial da Meta (o
  // mesmo que responde no teste por URL direta) e volta com ?code= — sem
  // pop-up nenhum. O waba_id não vem por postMessage aqui: o servidor o
  // descobre pelo debug_token.
  function conectarPorRedirect() {
    const estado = Math.random().toString(36).slice(2)
    try {
      sessionStorage.setItem('meta_es_state', estado)
      sessionStorage.setItem('meta_es_coex', coexistencia ? '1' : '0')
    } catch { /* sem sessionStorage: segue sem validação de estado */ }
    logar('redirect_inicio', { coexistencia })

    const extras = {
      feature: 'whatsapp_embedded_signup',
      setup: {},
      sessionInfoVersion: '3',
      ...(coexistencia ? { featureType: 'whatsapp_business_app_onboarding' } : {}),
    }
    const url = new URL('https://www.facebook.com/v20.0/dialog/oauth')
    url.searchParams.set('client_id', APP_ID)
    url.searchParams.set('config_id', CONFIG_ID)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('override_default_response_type', 'true')
    url.searchParams.set('redirect_uri', `${window.location.origin}/inboxes/new`)
    url.searchParams.set('state', estado)
    url.searchParams.set('extras', JSON.stringify(extras))
    window.location.href = url.toString()
  }

  if (!configurado) {
    return (
      <div className="border border-amber-200 bg-amber-50 rounded-xl p-5 text-sm text-amber-800 space-y-2">
        <p className="font-semibold">Cadastro Incorporado ainda não configurado</p>
        <p className="text-xs leading-relaxed">
          Defina as variáveis de ambiente <code className="font-mono">NEXT_PUBLIC_META_APP_ID</code>{' '}
          (ID do app na Meta) e <code className="font-mono">NEXT_PUBLIC_META_ES_CONFIG_ID</code>{' '}
          (ID da configuração do Embedded Signup) — além de <code className="font-mono">META_APP_SECRET</code>{' '}
          no servidor — e faça um novo deploy. Enquanto isso, use o Cadastro Manual.
        </p>
      </div>
    )
  }

  return (
    <div className="border border-gray-200 rounded-xl p-6 bg-white space-y-4">
      <div>
        <p className="text-sm font-semibold text-gray-800">Conectar com a Meta</p>
        <p className="text-xs text-gray-500 mt-1 leading-relaxed">
          Você fará login no Facebook, escolherá (ou criará) a conta do WhatsApp Business e o
          número. Ao concluir, a caixa é criada automaticamente com as credenciais — sem copiar
          nada. É preciso ser administrador do portfólio empresarial na Meta.
        </p>
      </div>

      <label className="flex items-start gap-2 text-xs text-gray-600 cursor-pointer">
        <input type="checkbox" className="mt-0.5" checked={coexistencia}
          onChange={e => setCoexistencia(e.target.checked)} />
        <span>
          Este número <strong>já usa o aplicativo WhatsApp Business no celular</strong> e vai
          continuar usando (coexistência). Marque para a Meta conduzir a conexão sem desativar
          o aplicativo — será pedido escanear um QR Code com o celular do número.{' '}
          <strong>Mantenha o app aberto</strong> durante e após a conexão: a sincronização de
          contatos e histórico pode levar alguns minutos.
        </span>
      </label>

      {erro && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{erro}</p>}
      {fase === 'ok' && (
        <p className="text-xs text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2 flex items-center gap-1.5">
          <CheckCircle2 className="w-3.5 h-3.5" /> Caixa criada! Abrindo o editor…
        </p>
      )}

      <button onClick={iniciar} disabled={!sdkPronto || fase === 'meta' || fase === 'trocando'}
        className="flex items-center gap-2 text-sm px-4 py-2.5 rounded-lg bg-[#1877F2] text-white hover:bg-[#166FE5] disabled:opacity-50">
        {(fase === 'meta' || fase === 'trocando') && <Loader2 className="w-4 h-4 animate-spin" />}
        {fase === 'trocando' ? 'Configurando a caixa…' : fase === 'meta' ? 'Aguardando a Meta…' : 'Continuar com o Facebook'}
      </button>
      {!sdkPronto && <p className="text-[11px] text-gray-400">Carregando o SDK da Meta…</p>}

      {/* Diagnóstico visível: sem isto, "não abriu" não distingue SDK ausente de
          variável faltando ou de recusa da Meta. */}
      <p className="text-[11px] text-gray-400">
        Diagnóstico: SDK {sdkPronto ? '✓ carregado' : '… carregando'} · App {APP_ID ? `✓ ${APP_ID}` : '✗ ausente'} ·
        {' '}Configuração {CONFIG_ID ? `✓ ${CONFIG_ID}` : '✗ ausente'}
      </p>

      <div className="pt-2 border-t border-gray-100">
        <button onClick={conectarPorRedirect} disabled={fase === 'trocando'}
          className="text-xs text-gray-500 underline hover:text-gray-800 disabled:opacity-50">
          A janela não abre? Conectar sem janela pop-up
        </button>
        <p className="text-[11px] text-gray-400 mt-1">
          Leva você ao site da Meta nesta mesma aba e volta ao final — mesmo cadastro, sem depender de pop-up.
        </p>
      </div>
    </div>
  )
}
