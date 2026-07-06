-- 062_subagent_flow_framework.sql
-- Framework GENÉRICO de fluxos de subagente acionados por gatilho determinístico
-- (ex.: resposta de campanha "Indique e Ganhe"), com estado por conversa.
-- Substitui o MVP hardcoded (chat_referrals é removido).
--
--   • chat_subagents.trigger       → quando INICIAR o fluxo (jsonb configurável)
--   • chat_subagents.terminal_tool → ferramenta cujo sucesso ENCERRA o fluxo
--   • chat_active_flows            → conversa que está DENTRO de um fluxo
--   • chat_campaigns.reply_flow    → marca campanhas cujas respostas entram no fluxo

DROP TABLE IF EXISTS public.chat_referrals;

ALTER TABLE public.chat_campaigns
  ADD COLUMN IF NOT EXISTS reply_flow text;              -- null | 'indique_ganhe' | ...

ALTER TABLE public.chat_subagents
  ADD COLUMN IF NOT EXISTS trigger       jsonb,          -- {kind:'campaign_reply', reply_flow, buttons:[]}
  ADD COLUMN IF NOT EXISTS terminal_tool text;           -- nome da ferramenta terminal

-- Novo modo de invocação: 'flow' = acionado por gatilho determinístico (roteador),
-- não pelo principal (on_demand) nem por contexto/mídia.
ALTER TABLE public.chat_subagents DROP CONSTRAINT IF EXISTS chat_subagents_invocation_chk;
ALTER TABLE public.chat_subagents ADD CONSTRAINT chat_subagents_invocation_chk
  CHECK (invocation = ANY (ARRAY['auto_context','on_media','on_demand','flow']));

CREATE TABLE IF NOT EXISTS public.chat_active_flows (
  conversation_id uuid PRIMARY KEY REFERENCES public.chat_conversations(id) ON DELETE CASCADE,
  subagent_id     uuid NOT NULL REFERENCES public.chat_subagents(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'active',        -- active | done
  data            jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_active_flows_status_idx ON public.chat_active_flows(status);

ALTER TABLE public.chat_active_flows ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "auth read active_flows"
    ON public.chat_active_flows FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
