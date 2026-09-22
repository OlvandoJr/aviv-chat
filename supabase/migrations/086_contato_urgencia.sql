-- 086_contato_urgencia.sql
-- Contato para urgências anexado a TODA escalação para humano (pedido de 22/09/2026).
--
-- A escalação tem três caminhos no ai-responder e só um deles usa a
-- escalation_message: (1) token ESCALAR_HUMANO → troca a resposta pela
-- mensagem configurada; (2) FRASE de escalação ("vou encaminhar seu caso",
-- frases do agente) → mantém a redação do modelo; (3) trava de pagamento sem
-- prova → texto fixo. Um contato escrito dentro da escalation_message sumia
-- nos caminhos 2 e 3. Este campo é anexado no ponto único em que a decisão de
-- escalar já está tomada, qualquer que tenha sido o caminho.

ALTER TABLE public.chat_agents
  ADD COLUMN IF NOT EXISTS contato_urgencia text;

COMMENT ON COLUMN public.chat_agents.contato_urgencia IS
  'Texto anexado (após linha em branco) a toda mensagem de escalação para humano, '
  'qualquer que seja o caminho da escalação. Ex.: WhatsApp da equipe para urgências.';
