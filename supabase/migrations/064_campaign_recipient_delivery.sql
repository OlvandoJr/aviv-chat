-- 064_campaign_recipient_delivery.sql
-- Indicadores por destinatário de campanha: Recebidas (delivered), Visualizadas (read)
-- e Respondidas (cliente clicou num botão do template). Populados pelo whatsapp-webhook
-- (service role) casando por wa_message_id. replied_at é ortogonal ao status.

ALTER TABLE public.chat_campaign_recipients
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz,
  ADD COLUMN IF NOT EXISTS read_at      timestamptz,
  ADD COLUMN IF NOT EXISTS replied_at   timestamptz;

-- O webhook casa o evento de status ao destinatário por wa_message_id.
CREATE INDEX IF NOT EXISTS chat_campaign_recipients_wa_message_id_idx
  ON public.chat_campaign_recipients (wa_message_id);

-- Realtime: a tela de detalhe da campanha depende disto para atualizar ao vivo
-- (hoje só chat_conversations/chat_messages estão publicados).
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_campaign_recipients;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_campaigns;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.chat_campaign_recipients REPLICA IDENTITY FULL;
ALTER TABLE public.chat_campaigns            REPLICA IDENTITY FULL;
