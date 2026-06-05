-- 014_campaigns.sql
-- Campanhas em massa de template WhatsApp (substitui o n8n "ENVIO - AVIV Cobrança").

CREATE TABLE IF NOT EXISTS public.chat_campaigns (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  inbox_id         uuid NOT NULL REFERENCES public.chat_inboxes(id)      ON DELETE RESTRICT,
  template_id      uuid NOT NULL REFERENCES public.chat_wa_templates(id) ON DELETE RESTRICT,
  status           text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','scheduled','running','paused','done','failed')),
  scheduled_at     timestamptz,                       -- quando começar (null = imediato ao iniciar)
  variable_mapping jsonb NOT NULL DEFAULT '{}'::jsonb, -- { "1": {type,value,format}, ... }
  audience         jsonb NOT NULL DEFAULT '{}'::jsonb, -- descrição da audiência (para auditoria)
  total            integer NOT NULL DEFAULT 0,
  sent             integer NOT NULL DEFAULT 0,
  failed           integer NOT NULL DEFAULT 0,
  created_by       uuid REFERENCES public.chat_attendants(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.chat_campaign_recipients (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   uuid NOT NULL REFERENCES public.chat_campaigns(id) ON DELETE CASCADE,
  wa_id         text NOT NULL,
  contact_id    uuid REFERENCES public.chat_contacts(id),
  name          text,
  variables     jsonb NOT NULL DEFAULT '[]'::jsonb,   -- array ordenado já resolvido
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','sent','delivered','read','failed','skipped')),
  wa_message_id text,
  error         text,
  sent_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, wa_id)
);

CREATE INDEX IF NOT EXISTS chat_campaign_recipients_status_idx
  ON public.chat_campaign_recipients (campaign_id, status);

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.chat_campaigns            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_campaign_recipients  ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['chat_campaigns','chat_campaign_recipients'] LOOP
    EXECUTE format('CREATE POLICY auth_select ON public.%I FOR SELECT TO authenticated USING (true)', t);
    EXECUTE format('CREATE POLICY auth_insert ON public.%I FOR INSERT TO authenticated WITH CHECK (true)', t);
    EXECUTE format('CREATE POLICY auth_update ON public.%I FOR UPDATE TO authenticated USING (true)', t);
    EXECUTE format('CREATE POLICY auth_delete ON public.%I FOR DELETE TO authenticated USING (true)', t);
  EXCEPTION WHEN duplicate_object THEN NULL;
  END LOOP;
END $$;
