-- 016_regua_multistep.sql
-- Régua passa a ser um FLUXO (pai) com vários DISPAROS (passos/filhos).
-- Cada passo tem seu offset_days, horário, template e mapeamento de variáveis.
-- Tabelas anteriores estavam vazias → recriação limpa.

DROP TABLE IF EXISTS public.cobranca_regua_log;
DROP TABLE IF EXISTS public.cobranca_regua;

-- Fluxo (pai): audiência e inbox compartilhados por todos os disparos
CREATE TABLE public.cobranca_regua (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  active          boolean NOT NULL DEFAULT true,
  inbox_id        uuid NOT NULL REFERENCES public.chat_inboxes(id) ON DELETE RESTRICT,
  audience_filter jsonb NOT NULL DEFAULT '{}'::jsonb,   -- { source, empreendimento }
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Disparo (filho): cada toque da régua relativo ao vencimento
CREATE TABLE public.cobranca_regua_step (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  regua_id         uuid NOT NULL REFERENCES public.cobranca_regua(id) ON DELETE CASCADE,
  offset_days      integer NOT NULL DEFAULT 0,           -- negativo = antes do vencimento
  send_time        time NOT NULL DEFAULT '09:00',
  template_id      uuid NOT NULL REFERENCES public.chat_wa_templates(id) ON DELETE RESTRICT,
  variable_mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort_order       integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cobranca_regua_step_regua_idx ON public.cobranca_regua_step (regua_id);

-- Log de envio + dedup. Chave por (regua_id, offset_days, ...) — estável mesmo
-- que os passos sejam recriados ao editar o fluxo.
CREATE TABLE public.cobranca_regua_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  regua_id      uuid NOT NULL REFERENCES public.cobranca_regua(id) ON DELETE CASCADE,
  step_id       uuid,
  offset_days   integer NOT NULL,
  wa_id         text,
  phone_norm    text NOT NULL,
  due_date      date NOT NULL,
  parcela       text,
  run_date      date NOT NULL DEFAULT (now() AT TIME ZONE 'America/Sao_Paulo')::date,
  status        text NOT NULL DEFAULT 'sent',
  wa_message_id text,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (regua_id, offset_days, phone_norm, due_date)
);

ALTER TABLE public.cobranca_regua      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cobranca_regua_step ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cobranca_regua_log  ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cobranca_regua','cobranca_regua_step','cobranca_regua_log'] LOOP
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
