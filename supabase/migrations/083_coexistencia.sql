-- 083_coexistencia.sql
-- Coexistência (CoEx): número que continua no app WhatsApp Business do celular
-- e passa a ser espelhado na Cloud API. Estruturas do brief de 29/08/2026
-- (doc oficial da Meta "Onboarding WhatsApp Business app users").

-- ── Mensagens: origem e status histórico ─────────────────────────────────────
-- origin distingue o que veio da API (fluxo atual), o ECO do app do celular
-- (smb_message_echoes) e a IMPORTAÇÃO de histórico (até 180 dias). Regras que
-- dependem disso: eco nunca dispara bot; histórico não abre janela de 24h.
ALTER TABLE public.chat_messages
  ADD COLUMN IF NOT EXISTS origin text;

COMMENT ON COLUMN public.chat_messages.origin IS
  'NULL/api = Cloud API (fluxo normal); app_echo = enviada pelo app do celular '
  '(coexistência); history = importada da sincronização de histórico.';

CREATE INDEX IF NOT EXISTS idx_chat_messages_origin
  ON public.chat_messages (origin) WHERE origin IS NOT NULL;

-- ── Contatos sincronizados da agenda do celular (smb_app_state_sync) ─────────
CREATE TABLE IF NOT EXISTS public.chat_inbox_synced_contacts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_id     uuid NOT NULL REFERENCES public.chat_inboxes(id) ON DELETE CASCADE,
  phone_number text NOT NULL,
  full_name    text,
  first_name   text,
  source       text NOT NULL DEFAULT 'smb_sync',
  removed_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (inbox_id, phone_number)
);
ALTER TABLE public.chat_inbox_synced_contacts ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "authenticated read synced contacts" ON public.chat_inbox_synced_contacts
    FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Estado da conexão e da sincronização por caixa ───────────────────────────
ALTER TABLE public.chat_inboxes
  ADD COLUMN IF NOT EXISTS connection_mode          text NOT NULL DEFAULT 'cloud_api',
  ADD COLUMN IF NOT EXISTS connection_status        text NOT NULL DEFAULT 'connected',
  ADD COLUMN IF NOT EXISTS disconnect_reason        text,
  ADD COLUMN IF NOT EXISTS contacts_sync_request_id text,
  ADD COLUMN IF NOT EXISTS history_sync_request_id  text,
  ADD COLUMN IF NOT EXISTS sync_requested_at        timestamptz,
  ADD COLUMN IF NOT EXISTS sync_progress            integer,
  ADD COLUMN IF NOT EXISTS history_share            text;

COMMENT ON COLUMN public.chat_inboxes.connection_mode IS 'cloud_api | coexistence';
COMMENT ON COLUMN public.chat_inboxes.connection_status IS
  'connected | disconnected — atualizado pelo webhook account_update (PARTNER_REMOVED/'
  'ACCOUNT_OFFBOARDED/ACCOUNT_RECONNECTED). Desconectada, a caixa para de espelhar.';
COMMENT ON COLUMN public.chat_inboxes.contacts_sync_request_id IS
  'request_id do POST smb_app_data sync_type=smb_app_state_sync. Cada sync_type só pode '
  'ser chamado UMA vez por conexão (janela de 24h) — o guard usa esta coluna.';
COMMENT ON COLUMN public.chat_inboxes.history_sync_request_id IS
  'request_id do POST smb_app_data sync_type=history — mesmo guard de chamada única.';
COMMENT ON COLUMN public.chat_inboxes.history_share IS
  'pending | shared | declined — o 200 do smb_app_data NÃO confirma compartilhamento; '
  'a recusa chega no webhook history com code 2593109.';
