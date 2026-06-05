-- 013_wa_templates_catchup.sql
-- Catch-up: reflete no repo o schema que já existe em produção (aplicado fora das
-- migrations versionadas). Idempotente — seguro reexecutar.
--
--  * coluna chat_inboxes.waba_id (necessária para templates/Meta)
--  * tabela chat_wa_templates (criação/sync/envio de templates)

-- ── Inbox: WhatsApp Business Account ID ──────────────────────────────────────
ALTER TABLE public.chat_inboxes
  ADD COLUMN IF NOT EXISTS waba_id text;

-- ── Templates de mensagem WhatsApp ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.chat_wa_templates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_id         uuid NOT NULL REFERENCES public.chat_inboxes(id) ON DELETE CASCADE,
  name             text NOT NULL,
  category         text NOT NULL,                       -- MARKETING | UTILITY | AUTHENTICATION
  language         text NOT NULL DEFAULT 'pt_BR',
  status           text NOT NULL DEFAULT 'PENDING',     -- PENDING|APPROVED|REJECTED|PAUSED|DISABLED
  wa_id            text,                                -- ID do template na Meta
  header_type      text,                                -- TEXT|IMAGE|VIDEO|DOCUMENT
  header_text      text,
  body_text        text NOT NULL,
  footer_text      text,
  buttons          jsonb NOT NULL DEFAULT '[]'::jsonb,
  body_var_count   integer NOT NULL DEFAULT 0,
  header_var_count integer NOT NULL DEFAULT 0,
  rejection_reason text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Evita duplicar o mesmo template (nome+idioma) por inbox
CREATE UNIQUE INDEX IF NOT EXISTS chat_wa_templates_inbox_name_lang_idx
  ON public.chat_wa_templates (inbox_id, name, language);

ALTER TABLE public.chat_wa_templates ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.chat_wa_templates'::regclass AND polname='auth_select') THEN
    CREATE POLICY auth_select ON public.chat_wa_templates FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.chat_wa_templates'::regclass AND polname='auth_insert') THEN
    CREATE POLICY auth_insert ON public.chat_wa_templates FOR INSERT TO authenticated WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.chat_wa_templates'::regclass AND polname='auth_update') THEN
    CREATE POLICY auth_update ON public.chat_wa_templates FOR UPDATE TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.chat_wa_templates'::regclass AND polname='auth_delete') THEN
    CREATE POLICY auth_delete ON public.chat_wa_templates FOR DELETE TO authenticated USING (true);
  END IF;
END $$;
