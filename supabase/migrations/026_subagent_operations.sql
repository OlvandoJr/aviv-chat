-- 026_subagent_operations.sql
-- Operações de dados nos subagentes: além de Consultar (SELECT), permitir
-- Criar/Atualizar/Upsert (igual ao nó Postgres do n8n). Cada operação de dados
-- (chat_subagent_datasources) ganha uma "Ação".
--
-- Inclui catch-up das tabelas de subagente (existem em prod, faltavam no repo).

-- ── Catch-up (idempotente; não roda se já existem) ───────────────────────────
CREATE TABLE IF NOT EXISTS public.chat_subagents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id         uuid NOT NULL REFERENCES public.chat_agents(id) ON DELETE CASCADE,
  name             text NOT NULL,
  trigger_type     text NOT NULL DEFAULT 'text',   -- text|image|document|audio
  extraction_prompt text,
  extraction_model text DEFAULT 'gpt-4o-mini',
  instructions     text,
  output_format    text,
  model            text DEFAULT 'gpt-4o-mini',
  is_active        boolean NOT NULL DEFAULT true,
  sort_order       integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.chat_subagent_datasources (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subagent_id        uuid NOT NULL REFERENCES public.chat_subagents(id) ON DELETE CASCADE,
  connection_id      uuid,
  name               text,
  table_name         text,
  filter_column      text,
  filter_template    text,
  columns            text DEFAULT '*',
  max_rows           integer DEFAULT 5,
  output_placeholder text,
  sort_order         integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.chat_subagents             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_subagent_datasources  ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['chat_subagents','chat_subagent_datasources'] LOOP
    BEGIN EXECUTE format('CREATE POLICY auth_all ON public.%I FOR ALL TO authenticated USING (true) WITH CHECK (true)', t);
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END LOOP;
END $$;

-- ── Novidade: ação por operação ──────────────────────────────────────────────
ALTER TABLE public.chat_subagent_datasources
  ADD COLUMN IF NOT EXISTS operation text NOT NULL DEFAULT 'select',  -- select|insert|update|upsert
  ADD COLUMN IF NOT EXISTS value_map jsonb NOT NULL DEFAULT '{}'::jsonb;  -- { coluna: "valor_template" }
