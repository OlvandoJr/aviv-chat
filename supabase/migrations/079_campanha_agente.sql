-- 079_campanha_agente.sql
-- IA por campanha: interruptor liga/desliga + agente especialista.
--
-- Problema: toda resposta a campanha caía no agente default (Vivi, cobrança) pela
-- "janela de 24h" do ai-responder — um lead respondendo a um convite de evento
-- ouvia falar de boleto. E não havia como tirar a IA de uma campanha específica.
--
-- Modelo: bot_ativo (default TRUE = comportamento clássico preservado) desliga a IA
-- da campanha inteira — respostas caem na fila humana. agent_id escolhe um agente
-- especialista para responder no lugar do default. O vínculo vale enquanto o ÚLTIMO
-- template out da conversa (até 7 dias) for desta campanha.

ALTER TABLE public.chat_campaigns
  ADD COLUMN IF NOT EXISTS bot_ativo boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS agent_id  uuid REFERENCES public.chat_agents(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.chat_campaigns.bot_ativo IS
  'Interruptor da IA nesta campanha. FALSE = nenhum bot responde aos leads (as respostas '
  'vão para a fila de atendimento humano, o ai-responder marca handled_by=human e sai calado). '
  'TRUE (default) = comportamento clássico.';

COMMENT ON COLUMN public.chat_campaigns.agent_id IS
  'Agente especialista que responde aos leads desta campanha (janela de 7 dias após o '
  'último template dela; um template mais novo de outra origem retoma a regra normal). '
  'NULL + bot_ativo=true = agente default pela janela de 24h, como sempre foi.';
