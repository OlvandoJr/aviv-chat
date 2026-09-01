-- 084_agente_por_caixa.sql
-- Alocação de agente de IA na própria caixa de entrada (pedido de 01/09/2026).
--
-- Três estados possíveis por caixa:
--   ia_ativa=false                       → caixa 100% HUMANA: nenhum bot responde
--                                          nela, nunca (ai-responder sai no portão).
--   ia_ativa=true + default_agent_id     → o agente alocado atende TUDO da caixa,
--                                          inclusive respostas a template — vence a
--                                          regra "template em 24h → agente padrão".
--   ia_ativa=true + default_agent_id NULL→ comportamento legado (regras de agente +
--                                          agente padrão). É o estado das caixas
--                                          existentes: Cobrança/Comunicados seguem
--                                          exatamente como antes (régua intocada).

ALTER TABLE public.chat_inboxes
  ADD COLUMN IF NOT EXISTS default_agent_id uuid REFERENCES public.chat_agents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ia_ativa boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.chat_inboxes.default_agent_id IS
  'Agente de IA alocado à caixa (opcional). Precedência no ai-responder: campanha > '
  'agente da caixa > template 24h→padrão > regra de inbox > padrão.';
COMMENT ON COLUMN public.chat_inboxes.ia_ativa IS
  'false = caixa 100% humana: o ai-responder marca handled_by=human e sai calado; '
  'o auto-return-bot ignora conversas dessas caixas.';
