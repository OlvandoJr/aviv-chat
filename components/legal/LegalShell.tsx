import { MessageSquare } from 'lucide-react'

/**
 * Casco compartilhado das páginas legais públicas (/privacidade, /termos):
 * cabeçalho com a marca, miolo e rodapé com links cruzados. Extraído para as
 * duas páginas não divergirem de visual nem de rodapé.
 */

export function Secao({ numero, titulo, children }: {
  numero: string; titulo: string; children: React.ReactNode
}) {
  return (
    <section className="scroll-mt-20" id={`sec-${numero}`}>
      <h2 className="text-lg font-semibold text-gray-900 mt-10 mb-3">
        <span className="text-emerald-600 mr-2">{numero}.</span>{titulo}
      </h2>
      <div className="space-y-3 text-[15px] leading-relaxed text-gray-600">{children}</div>
    </section>
  )
}

export function LegalShell({ titulo, atualizacao, children }: {
  titulo: string; atualizacao: string; children: React.ReactNode
}) {
  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-gray-100">
        <div className="max-w-3xl mx-auto px-6 py-5 flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-emerald-500 flex items-center justify-center shrink-0">
            <MessageSquare className="w-4.5 h-4.5 text-white" />
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-900">Aviv Chat</p>
            <p className="text-xs text-gray-400">Aviv Construtora e Incorporadora</p>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-10">
        <h1 className="text-2xl font-bold text-gray-900">{titulo}</h1>
        <p className="text-sm text-gray-400 mt-1">Última atualização: {atualizacao}</p>
        {children}

        <footer className="mt-14 pt-6 border-t border-gray-100 text-xs text-gray-400">
          <p>Aviv Construtora e Incorporadora · Aviv Chat — atendimento oficial via WhatsApp.</p>
          <p className="mt-1">
            <a href="/privacidade" className="underline hover:text-gray-600">Política de Privacidade</a>
            {' · '}
            <a href="/termos" className="underline hover:text-gray-600">Termos de Uso</a>
            {' · '}
            <a href="/exclusao-de-dados" className="underline hover:text-gray-600">Exclusão de Dados</a>
            {' · '}última atualização em {atualizacao}.
          </p>
        </footer>
      </main>
    </div>
  )
}
