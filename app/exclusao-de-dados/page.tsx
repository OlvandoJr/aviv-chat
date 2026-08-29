import type { Metadata } from 'next'
import { LegalShell, Secao } from '@/components/legal/LegalShell'

export const metadata: Metadata = {
  title:       'Exclusão de Dados — Aviv Chat',
  description: 'Como solicitar a exclusão dos seus dados pessoais tratados no atendimento via WhatsApp da Aviv.',
}

// Página PÚBLICA (sem login): é a "Data Deletion Instructions URL" exigida pela
// Meta no cadastro do app, e o roteiro LGPD de eliminação para os clientes.

const ATUALIZACAO = '28 de agosto de 2026'

export default function ExclusaoDeDados() {
  return (
    <LegalShell titulo="Exclusão de Dados" atualizacao={ATUALIZACAO}>
      <p className="mt-6 text-[15px] leading-relaxed text-gray-600">
        Esta página explica como solicitar a <strong className="text-gray-800">exclusão dos
        seus dados pessoais</strong> tratados pela Aviv Construtora e Incorporadora no{' '}
        <strong className="text-gray-800">Aviv Chat</strong> — nosso atendimento via
        WhatsApp — conforme a Lei Geral de Proteção de Dados (LGPD, Lei nº 13.709/2018)
        e as políticas da Meta para aplicativos do WhatsApp Business.
      </p>

      <Secao numero="1" titulo="Como solicitar a exclusão">
        <p>Escolha qualquer um destes caminhos:</p>
        <ul className="list-disc pl-5 space-y-2">
          <li>
            <strong className="text-gray-800">Pelo próprio WhatsApp:</strong> envie, na
            conversa com um dos nossos números oficiais, a mensagem{' '}
            <em>&quot;Quero excluir meus dados&quot;</em>. Um atendente humano assumirá a
            solicitação.
          </li>
          <li>
            <strong className="text-gray-800">Pelo Encarregado de Proteção de Dados
            (DPO):</strong> escreva para o contato indicado na nossa{' '}
            <a href="/privacidade" className="text-emerald-700 underline">Política de
            Privacidade</a> (seção 12), informando o número de telefone usado nas
            conversas.
          </li>
        </ul>
      </Secao>

      <Secao numero="2" titulo="Confirmação de identidade">
        <p>
          Para proteger você, confirmamos que o pedido parte do titular: a solicitação
          feita pelo próprio número de WhatsApp das conversas vale como confirmação;
          pedidos por outros meios podem exigir uma verificação simples (por exemplo,
          confirmar dados do seu cadastro). Nunca pediremos senhas ou códigos.
        </p>
      </Secao>

      <Secao numero="3" titulo="O que é excluído">
        <p>Atendida a solicitação, eliminamos da plataforma de atendimento:</p>
        <ul className="list-disc pl-5 space-y-2">
          <li>o seu cadastro de contato do chat (nome, telefone, foto de perfil);</li>
          <li>o histórico das conversas — mensagens de texto, áudios, imagens e vídeos;</li>
          <li>arquivos enviados nas conversas, como comprovantes, guardados nos nossos repositórios;</li>
          <li>registros de campanhas e notificações associados ao seu número.</li>
        </ul>
      </Secao>

      <Secao numero="4" titulo="O que a lei nos obriga a manter">
        <p>
          Alguns registros não podem ser apagados de imediato, por obrigação legal ou
          para o exercício regular de direitos (art. 16 da LGPD):
        </p>
        <ul className="list-disc pl-5 space-y-2">
          <li>
            registros financeiros e contratuais — pagamentos, boletos, parcelas e o seu
            contrato com a Aviv — mantidos nos sistemas de gestão pelos prazos legais e
            prescricionais;
          </li>
          <li>documentos fiscais e registros exigidos por autoridades.</li>
        </ul>
        <p>
          Esses dados ficam restritos às finalidades legais, deixam de ser usados para
          atendimento ou comunicação e são eliminados ou anonimizados ao fim dos prazos.
        </p>
      </Secao>

      <Secao numero="5" titulo="Prazos e confirmação">
        <p>
          Confirmaremos o recebimento do pedido e concluiremos a exclusão nos prazos da
          LGPD, informando você ao final. Atenção: excluir os dados do chat encerra o
          histórico do seu atendimento por este canal — se você voltar a nos escrever,
          um novo cadastro de contato será criado a partir daquela conversa.
        </p>
      </Secao>

      <Secao numero="6" titulo="Dados no WhatsApp (Meta)">
        <p>
          A exclusão descrita aqui alcança os dados sob controle da Aviv. As cópias das
          mensagens no seu aparelho e os dados tratados pelo próprio WhatsApp seguem a{' '}
          <a href="https://www.whatsapp.com/legal/privacy-policy" target="_blank" rel="noopener noreferrer"
            className="text-emerald-700 underline">política de privacidade do WhatsApp</a>{' '}
          — para removê-los, use os recursos do próprio aplicativo ou contate a Meta.
        </p>
      </Secao>
    </LegalShell>
  )
}
