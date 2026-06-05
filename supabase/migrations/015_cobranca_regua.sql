-- 015_cobranca_regua.sql
-- Régua de cobrança configurável (substitui o n8n "Sienge 01/03/B").
-- Cada regra dispara um template para boletos cujo vencimento está a
-- offset_days da data atual (negativo = antes, 0 = no dia, positivo = depois).

CREATE TABLE IF NOT EXISTS public.cobranca_regua (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  active           boolean NOT NULL DEFAULT true,
  inbox_id         uuid NOT NULL REFERENCES public.chat_inboxes(id)      ON DELETE RESTRICT,
  template_id      uuid NOT NULL REFERENCES public.chat_wa_templates(id) ON DELETE RESTRICT,
  offset_days      integer NOT NULL DEFAULT 0,
  send_time        time NOT NULL DEFAULT '09:00',
  variable_mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  audience_filter  jsonb NOT NULL DEFAULT '{}'::jsonb,   -- { source: 'both'|'sienge'|'sgl', empreendimento? }
  sort_order       integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.cobranca_regua_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  regua_id      uuid NOT NULL REFERENCES public.cobranca_regua(id) ON DELETE CASCADE,
  wa_id         text,
  phone_norm    text NOT NULL,
  due_date      date NOT NULL,
  parcela       text,
  run_date      date NOT NULL DEFAULT (now() AT TIME ZONE 'America/Sao_Paulo')::date,
  status        text NOT NULL DEFAULT 'sent',
  wa_message_id text,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (regua_id, phone_norm, due_date)
);

ALTER TABLE public.cobranca_regua     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cobranca_regua_log ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cobranca_regua','cobranca_regua_log'] LOOP
    BEGIN EXECUTE format('CREATE POLICY auth_select ON public.%I FOR SELECT TO authenticated USING (true)', t);
    EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN EXECUTE format('CREATE POLICY auth_insert ON public.%I FOR INSERT TO authenticated WITH CHECK (true)', t);
    EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN EXECUTE format('CREATE POLICY auth_update ON public.%I FOR UPDATE TO authenticated USING (true)', t);
    EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN EXECUTE format('CREATE POLICY auth_delete ON public.%I FOR DELETE TO authenticated USING (true)', t);
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END LOOP;
END $$;
