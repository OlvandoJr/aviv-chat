import type { Metadata } from 'next'
import { LegalShell, Secao } from '@/components/legal/LegalShell'

export const metadata: Metadata = {
  title:       'Termos de Uso — Aviv Chat',
  description: 'Condições de uso do canal oficial de atendimento via WhatsApp da Aviv Construtora e Incorporadora.',
}

// Página PÚBLICA (sem login): URL de termos exigida pela Meta no cadastro do app
// e documento de referência para os clientes do canal.

const ATUALIZACAO = '28 de agosto de 2026'

export default function TermosDeUso() {
  return (
    <LegalShell titulo="Termos de Uso" atualizacao={ATUALIZACAO}>
      <p className="mt-6 text-[15px] leading-relaxed text-gray-600">
        Estes Termos de Uso regulam a utilização do <strong className="text-gray-800">Aviv
        Chat</strong>, o canal oficial de atendimento via WhatsApp da{' '}
        <strong className="text-gray-800">Aviv Construtora e Incorporadora</strong>{' '}
        (&quot;Aviv&quot;, &quot;nós&quot;). Ao conversar conosco por este canal, você
        concorda com estas condições. Se não concordar, basta não utilizar o canal — os
        demais meios de contato da Aviv continuam à disposição.
      </p>

      <Secao numero="1" titulo="O que é o Aviv Chat">
        <p>
          O Aviv Chat é a plataforma pela qual a Aviv presta atendimento, envia cobranças,
          boletos, lembretes e comunicados, e recebe documentos (como comprovantes de
          pagamento) pelo WhatsApp, usando a API oficial do WhatsApp Business (Meta).
          Ele não é uma rede social, um serviço público nem um canal de emergência —
          é o meio de comunicação entre você e a Aviv sobre a sua relação conosco.
        </p>
      </Secao>

      <Secao numero="2" titulo="Quem pode usar">
        <p>
          O canal destina-se a clientes e potenciais clientes da Aviv, corretores e
          parceiros, maiores de 18 anos. Ao usá-lo, você declara que as informações que
          fornece (como nome e documentos) são verdadeiras e suas.
        </p>
      </Secao>

      <Secao numero="3" titulo="Uso adequado do canal">
        <p>Ao utilizar o Aviv Chat, você se compromete a:</p>
        <ul className="list-disc pl-5 space-y-2">
          <li>fornecer informações verdadeiras e enviar apenas documentos autênticos — comprovante adulterado ou de terceiros pode configurar crime;</li>
          <li>não usar o canal para fins ilícitos, ofensivos, discriminatórios ou de assédio à equipe de atendimento;</li>
          <li>não enviar conteúdo malicioso (vírus, links fraudulentos) nem tentar burlar os sistemas da plataforma;</li>
          <li>não usar o canal para divulgação, propaganda ou envio em massa alheios à relação com a Aviv.</li>
        </ul>
        <p>
          O uso abusivo pode levar à suspensão do atendimento automatizado pelo canal,
          sem prejuízo dos demais meios de contato e das medidas legais cabíveis.
        </p>
      </Secao>

      <Secao numero="4" titulo="Atendimento por inteligência artificial">
        <p>
          Parte do atendimento é realizada por assistentes virtuais (IA), identificados na
          conversa. Eles agilizam respostas — segunda via de boleto, confirmação de
          recebimento de comprovante, informações do seu contrato — mas você pode pedir
          atendimento humano a qualquer momento. Respostas automatizadas podem conter
          imprecisões; informações de caráter financeiro definitivo (como a quitação de
          uma parcela) seguem sempre os registros oficiais dos sistemas da Aviv, que
          prevalecem em caso de divergência.
        </p>
      </Secao>

      <Secao numero="5" titulo="Cobranças, boletos e segurança nos pagamentos">
        <ul className="list-disc pl-5 space-y-2">
          <li>
            Boletos e cobranças legítimos da Aviv são enviados apenas pelos nossos
            números oficiais e sempre em nome do beneficiário correto do seu contrato.{' '}
            <strong className="text-gray-800">Confira o beneficiário antes de pagar.</strong>
          </li>
          <li>
            A Aviv <strong className="text-gray-800">nunca</strong> solicita pagamento
            via PIX para contas de pessoa física, transferência para contas avulsas,
            senhas, códigos de verificação ou dados de cartão pelo WhatsApp. Ao receber
            qualquer pedido assim, não pague e avise-nos imediatamente.
          </li>
          <li>
            O envio de um comprovante pelo chat não substitui a compensação bancária: a
            confirmação definitiva do pagamento (baixa) segue o processamento do banco e
            dos sistemas financeiros da Aviv.
          </li>
        </ul>
      </Secao>

      <Secao numero="6" titulo="Comunicações e como parar de recebê-las">
        <p>
          Mensagens ativas (cobranças, lembretes, boletos e comunicados) são enviadas por
          modelos aprovados pelo WhatsApp. Você pode pedir, na própria conversa, para não
          receber mais determinado tipo de mensagem. Comunicações essenciais à execução
          do seu contrato podem continuar pelos canais adequados.
        </p>
      </Secao>

      <Secao numero="7" titulo="Privacidade e exclusão de dados">
        <p>
          O tratamento dos seus dados pessoais no Aviv Chat é regido pela nossa{' '}
          <a href="/privacidade" className="text-emerald-700 underline">Política de Privacidade</a>,
          que integra estes Termos. Para solicitar a exclusão dos seus dados, siga as
          instruções da página de{' '}
          <a href="/exclusao-de-dados" className="text-emerald-700 underline">Exclusão de Dados</a>.
        </p>
      </Secao>

      <Secao numero="8" titulo="Disponibilidade do serviço">
        <p>
          O Aviv Chat depende de serviços de terceiros — em especial do WhatsApp (Meta) e
          de provedores de infraestrutura — e por isso não garantimos funcionamento
          ininterrupto. Podemos suspender ou alterar o canal para manutenção ou por
          exigência desses provedores. Em caso de indisponibilidade, os demais canais de
          atendimento da Aviv permanecem válidos, e nenhuma obrigação contratual sua ou
          nossa se altera por indisponibilidade do chat.
        </p>
      </Secao>

      <Secao numero="9" titulo="Propriedade intelectual">
        <p>
          A marca Aviv, o Aviv Chat, seus textos, layouts e materiais são de titularidade
          da Aviv ou licenciados a ela. O uso do canal não transfere a você nenhum
          direito sobre eles. O WhatsApp é marca da Meta Platforms, sujeita aos{' '}
          <a href="https://www.whatsapp.com/legal/terms-of-service" target="_blank" rel="noopener noreferrer"
            className="text-emerald-700 underline">termos próprios do WhatsApp</a>.
        </p>
      </Secao>

      <Secao numero="10" titulo="Responsabilidades">
        <p>
          A Aviv responde pelo atendimento prestado no canal nos limites da lei. Não nos
          responsabilizamos por indisponibilidades do WhatsApp/Meta, falhas da sua
          conexão ou aparelho, golpes praticados por terceiros fora dos nossos números
          oficiais, nem pelo uso do canal em desacordo com estes Termos. Nada nestes
          Termos exclui direitos que o Código de Defesa do Consumidor e a legislação
          brasileira garantem a você.
        </p>
      </Secao>

      <Secao numero="11" titulo="Alterações destes Termos">
        <p>
          Podemos atualizar estes Termos para refletir mudanças no serviço ou na
          legislação. A versão vigente estará sempre nesta página, com a data no topo;
          alterações relevantes serão comunicadas pelos nossos canais. O uso do canal
          após a atualização vale como concordância com a nova versão.
        </p>
      </Secao>

      <Secao numero="12" titulo="Lei aplicável, foro e contato">
        <p>
          Estes Termos são regidos pelas leis da República Federativa do Brasil. Fica
          eleito o foro da comarca da sede da Aviv Construtora e Incorporadora, sem
          prejuízo do foro do seu domicílio nas relações de consumo. Dúvidas sobre estes
          Termos podem ser tratadas nos nossos canais oficiais de WhatsApp ou com o nosso
          Encarregado de Proteção de Dados, indicado na Política de Privacidade.
        </p>
      </Secao>
    </LegalShell>
  )
}
