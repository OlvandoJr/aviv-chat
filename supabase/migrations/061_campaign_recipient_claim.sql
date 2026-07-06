-- 061_campaign_recipient_claim.sql
-- Trava atômica por destinatário no disparo de campanha. Sem isso, duas execuções
-- concorrentes do dispatch-campaign (start + cron/auto-reinvocação) pegavam os
-- mesmos destinatários 'pending' e enviavam 2x (caso Indique e Ganhe — Tapejara).
-- claimed_at é a "reserva": só quem consegue setar (WHERE claimed_at IS NULL) envia.
ALTER TABLE public.chat_campaign_recipients
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
