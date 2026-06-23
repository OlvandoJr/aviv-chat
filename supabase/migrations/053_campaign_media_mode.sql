-- 053_campaign_media_mode.sql
-- Campanha com template de mídia pode enviar:
--   'upload' (padrão): UM arquivo p/ todos (header_media_path).
--   'boleto'         : o PDF do boleto de CADA destinatário (como a régua).
-- Para o modo 'boleto', guardamos o pdf_path por destinatário no momento da audiência.

ALTER TABLE public.chat_campaigns
  ADD COLUMN IF NOT EXISTS header_media_mode text NOT NULL DEFAULT 'upload'
  CHECK (header_media_mode IN ('upload', 'boleto'));

ALTER TABLE public.chat_campaign_recipients
  ADD COLUMN IF NOT EXISTS boleto_pdf_path text;
