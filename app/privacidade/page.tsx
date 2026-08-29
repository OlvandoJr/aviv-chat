import type { Metadata } from 'next'
import { LegalShell, Secao } from '@/components/legal/LegalShell'

export const metadata: Metadata = {
  title:       'Política de Privacidade — Aviv Chat',
  description: 'Como a Aviv Construtora e Incorporadora trata os dados pessoais no atendimento via WhatsApp.',
}

/**
 * Página PÚBLICA (sem login): é a URL de política de privacidade exigida pela
 * Meta para apps do WhatsApp Business, e o documento LGPD para os clientes.
 * O conteúdo descreve o que o sistema REALMENTE faz — se um fluxo novo passar a
 * tratar dado pessoal de outra forma, esta página precisa acompanhar.
 */

const ATUALIZACAO = '27 de agosto de 2026'

export default function PoliticaPrivacidade() {
  return (
    <LegalShell titulo="Política de Privacidade" atualizacao={ATUALIZACAO}>

        <p className="mt-6 text-[15px] leading-relaxed text-gray-600">
          Esta Política de Privacidade explica como a{' '}
          <strong className="text-gray-800">Aviv Construtora e Incorporadora</strong>{' '}
          (&quot;Aviv&quot;, &quot;nós&quot;) coleta, usa, armazena e protege os seus dados pessoais quando você conversa conosco pelo
          WhatsApp por meio da plataforma{' '}
          <strong className="text-gray-800">Aviv Chat</strong> — nosso canal oficial de atendimento, cobrança e comunicados. Ela foi escrita para
          ser lida por pessoas, não só por advogados; em caso de dúvida, fale conosco pelos
          canais indicados na seção 12.
        </p>
        <p className="mt-3 text-[15px] leading-relaxed text-gray-600">
          O tratamento de dados descrito aqui segue a Lei Geral de Proteção de Dados
          Pessoais — <strong className="text-gray-800">Lei nº 13.709/2018 (LGPD)</strong>.
          A Aviv atua como <em>controladora</em> dos dados pessoais tratados na plataforma.
        </p>

        <Secao numero="1" titulo="A quem esta política se aplica">
          <p>
            A clientes e potenciais clientes da Aviv que conversam conosco pelos nossos
            números oficiais de WhatsApp — seja porque nos escreveram, seja porque
            receberam de nós uma mensagem de cobrança, um boleto, um convite ou um
            comunicado. Aplica-se também a corretores e parceiros que recebem
            notificações operacionais pelos mesmos canais.
          </p>
        </Secao>

        <Secao numero="2" titulo="Quais dados coletamos">
          <p>Tratamos as seguintes categorias de dados pessoais:</p>
          <ul className="list-disc pl-5 space-y-2">
            <li>
              <strong className="text-gray-800">Identificação e contato:</strong> nome,
              número de telefone/WhatsApp e, quando disponível, a foto de perfil pública
              do seu WhatsApp.
            </li>
            <li>
              <strong className="text-gray-800">Conteúdo das conversas:</strong> as
              mensagens trocadas com a Aviv — texto, áudios, imagens, vídeos e documentos
              que você nos envia, e as respostas que enviamos a você.
            </li>
            <li>
              <strong className="text-gray-800">Documentos financeiros:</strong>{' '}
              comprovantes de pagamento, boletos e agendamentos que você compartilha na
              conversa, que podem conter CPF, dados bancários do pagamento e valores.
            </li>
            <li>
              <strong className="text-gray-800">Dados contratuais e de cobrança:</strong>{' '}
              informações do seu contrato com a Aviv mantidas em nossos sistemas de
              gestão — empreendimento, parcelas, vencimentos, valores e situação de
              pagamento — usadas para atendê-lo corretamente.
            </li>
            <li>
              <strong className="text-gray-800">Registros de atendimento:</strong>{' '}
              histórico das conversas, status de entrega e leitura das mensagens e
              anotações internas da equipe.
            </li>
          </ul>
          <p>
            Não solicitamos senhas, cartões de crédito ou códigos de segurança pelo
            WhatsApp — desconfie de qualquer mensagem nesse sentido.
          </p>
        </Secao>

        <Secao numero="3" titulo="Para que usamos os seus dados">
          <ul className="list-disc pl-5 space-y-2">
            <li>
              <strong className="text-gray-800">Atendimento:</strong> responder às suas
              mensagens, encaminhá-lo à equipe certa e manter o histórico do seu
              relacionamento conosco.
            </li>
            <li>
              <strong className="text-gray-800">Cobrança e gestão financeira:</strong>{' '}
              enviar boletos, segundas vias, lembretes de vencimento e confirmar o
              recebimento de comprovantes de pagamento.
            </li>
            <li>
              <strong className="text-gray-800">Validação de comprovantes:</strong>{' '}
              conferir automaticamente os comprovantes que você envia (valor, vencimento,
              beneficiário e código do boleto) para agilizar a baixa do pagamento.
            </li>
            <li>
              <strong className="text-gray-800">Comunicados:</strong> avisos relevantes
              da sua relação com a Aviv — como convites de entrega de chaves, informações
              do seu empreendimento e campanhas institucionais.
            </li>
            <li>
              <strong className="text-gray-800">Melhoria do serviço:</strong> acompanhar
              a qualidade do atendimento e corrigir falhas da plataforma.
            </li>
          </ul>
        </Secao>

        <Secao numero="4" titulo="Uso de inteligência artificial">
          <p>
            Parte do atendimento do Aviv Chat é feita por <strong className="text-gray-800">
            assistentes virtuais (IA)</strong>, e queremos que isso seja transparente:
          </p>
          <ul className="list-disc pl-5 space-y-2">
            <li>
              Um assistente pode responder às suas mensagens automaticamente — por
              exemplo, enviar a segunda via de um boleto ou confirmar o recebimento de um
              comprovante. Ele é identificado na conversa e você pode, a qualquer
              momento, pedir para falar com um atendente humano.
            </li>
            <li>
              Comprovantes e documentos enviados na conversa podem ser lidos por
              tecnologia de reconhecimento automático para extrair valor, data e código
              do boleto. A confirmação definitiva de pagamentos segue os registros dos
              nossos sistemas financeiros.
            </li>
            <li>
              Áudios enviados podem ser transcritos automaticamente para que a equipe e o
              assistente entendam a sua solicitação.
            </li>
            <li>
              Para essas funções utilizamos provedores especializados de IA (como a
              OpenAI), que processam o conteúdo estritamente para gerar a resposta ou a
              leitura do documento, conforme a seção 5.
            </li>
          </ul>
          <p>
            Decisões que afetem significativamente você — como tratar uma divergência de
            pagamento — passam por revisão humana.
          </p>
        </Secao>

        <Secao numero="5" titulo="Com quem compartilhamos">
          <p>
            Não vendemos os seus dados. Compartilhamos apenas com quem precisa deles para
            o serviço funcionar:
          </p>
          <ul className="list-disc pl-5 space-y-2">
            <li>
              <strong className="text-gray-800">Meta (WhatsApp Business):</strong> as
              mensagens trafegam pela infraestrutura do WhatsApp, sujeitas também à{' '}
              <a href="https://www.whatsapp.com/legal/privacy-policy" target="_blank" rel="noopener noreferrer"
                className="text-emerald-700 underline">política de privacidade do WhatsApp</a>.
            </li>
            <li>
              <strong className="text-gray-800">Provedores de tecnologia (operadores):</strong>{' '}
              serviços de hospedagem e banco de dados (Supabase, Vercel) e de
              inteligência artificial (OpenAI) que processam dados em nosso nome, sob
              contrato e apenas para as finalidades desta política.
            </li>
            <li>
              <strong className="text-gray-800">Sistemas internos da Aviv:</strong> nosso
              sistema de gestão (ERP) e ferramentas de cobrança, para manter seu contrato
              e seus pagamentos em dia.
            </li>
            <li>
              <strong className="text-gray-800">Autoridades:</strong> quando houver
              obrigação legal ou ordem de autoridade competente.
            </li>
          </ul>
          <p>
            Alguns desses provedores operam servidores fora do Brasil. Nesses casos, a
            transferência internacional ocorre com as salvaguardas previstas na LGPD.
          </p>
        </Secao>

        <Secao numero="6" titulo="Bases legais">
          <p>Tratamos os seus dados com fundamento nas seguintes bases da LGPD:</p>
          <ul className="list-disc pl-5 space-y-2">
            <li>
              <strong className="text-gray-800">Execução de contrato</strong> (art. 7º,
              V): atendimento, cobrança, envio de boletos e validação de pagamentos do
              seu contrato com a Aviv.
            </li>
            <li>
              <strong className="text-gray-800">Legítimo interesse</strong> (art. 7º,
              IX): comunicados relevantes da sua relação conosco e melhoria do
              atendimento, sempre respeitando suas expectativas e seu direito de opor-se.
            </li>
            <li>
              <strong className="text-gray-800">Cumprimento de obrigação legal</strong>{' '}
              (art. 7º, II): guarda de registros exigidos por lei.
            </li>
            <li>
              <strong className="text-gray-800">Consentimento</strong> (art. 7º, I):
              quando aplicável, para comunicações que não decorram do contrato — e que
              você pode revogar a qualquer momento.
            </li>
          </ul>
        </Secao>

        <Secao numero="7" titulo="Por quanto tempo guardamos">
          <p>
            Mantemos os dados pelo tempo necessário às finalidades desta política:
            o histórico de atendimento e os registros financeiros são conservados durante
            a vigência do seu contrato e pelos prazos legais e regulatórios aplicáveis
            (por exemplo, prazos prescricionais de obrigações contratuais). Depois disso,
            os dados são eliminados ou anonimizados, salvo obrigação legal de guarda.
          </p>
        </Secao>

        <Secao numero="8" titulo="Como protegemos">
          <ul className="list-disc pl-5 space-y-2">
            <li>Criptografia em trânsito em todas as comunicações da plataforma.</li>
            <li>
              Acesso restrito por perfil: cada atendente enxerga apenas as conversas e
              caixas de atendimento sob sua responsabilidade.
            </li>
            <li>Controles de acesso no banco de dados e registro das ações da equipe.</li>
            <li>
              Arquivos (comprovantes, documentos) armazenados em repositórios privados,
              acessíveis somente por pessoal autorizado e autenticado.
            </li>
          </ul>
          <p>
            Nenhum sistema é infalível; caso ocorra um incidente de segurança com risco
            relevante, comunicaremos os afetados e a Autoridade Nacional de Proteção de
            Dados (ANPD) conforme a lei.
          </p>
        </Secao>

        <Secao numero="9" titulo="Seus direitos (art. 18 da LGPD)">
          <p>Você pode, a qualquer momento e gratuitamente, solicitar:</p>
          <ul className="list-disc pl-5 space-y-2">
            <li>confirmação de que tratamos seus dados e acesso a eles;</li>
            <li>correção de dados incompletos, inexatos ou desatualizados;</li>
            <li>anonimização, bloqueio ou eliminação de dados desnecessários ou excessivos;</li>
            <li>portabilidade, nos termos da regulamentação;</li>
            <li>informação sobre com quem compartilhamos seus dados;</li>
            <li>revogação de consentimento e oposição a tratamentos baseados em legítimo interesse;</li>
            <li>revisão de decisões tomadas unicamente de forma automatizada.</li>
          </ul>
          <p>
            Para exercer qualquer direito, use os canais da seção 12. Responderemos nos
            prazos da LGPD. Você também pode apresentar reclamação à ANPD.
          </p>
        </Secao>

        <Secao numero="10" titulo="Mensagens que enviamos e como parar de recebê-las">
          <p>
            Enviamos mensagens ativas apenas por meio de modelos aprovados pelo WhatsApp
            (cobranças, lembretes, boletos e comunicados). Se não quiser mais receber
            mensagens de um desses tipos, basta responder na própria conversa pedindo a
            interrupção — registraremos sua preferência. Comunicações essenciais à
            execução do contrato (como avisos de cobrança) podem continuar sendo enviadas
            pelos canais adequados.
          </p>
        </Secao>

        <Secao numero="11" titulo="Crianças e adolescentes">
          <p>
            O Aviv Chat destina-se a clientes e parceiros da Aviv, maiores de 18 anos.
            Não coletamos intencionalmente dados de crianças ou adolescentes; se
            identificarmos um caso, eliminaremos os dados.
          </p>
        </Secao>

        <Secao numero="12" titulo="Contato e encarregado de dados">
          <p>
            Dúvidas sobre esta política ou solicitações sobre seus dados podem ser
            feitas:
          </p>
          <ul className="list-disc pl-5 space-y-2">
            <li>pelos nossos canais oficiais de WhatsApp — a mesma conversa em que você nos escreve;</li>
            <li>
              com o nosso Encarregado de Proteção de Dados (DPO):{' '}
              <span className="font-medium text-gray-800">[nome e e-mail do encarregado]</span>.
            </li>
          </ul>
        </Secao>

        <Secao numero="13" titulo="Alterações desta política">
          <p>
            Podemos atualizar esta política para refletir mudanças na plataforma ou na
            legislação. A versão vigente estará sempre nesta página, com a data de
            atualização no topo. Mudanças relevantes serão comunicadas pelos nossos
            canais.
          </p>
        </Secao>

    </LegalShell>
  )
}
