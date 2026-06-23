-- 052_campaign_header_media.sql
-- Campanhas com template de MÍDIA (header DOCUMENT/IMAGE/VIDEO, ex.: a_vencer1):
-- guardam UM arquivo (mesma mídia p/ todos os destinatários). O dispatch-campaign
-- gera signed URL no envio e anexa no header. Bucket privado dedicado.

ALTER TABLE public.chat_campaigns ADD COLUMN IF NOT EXISTS header_media_path     text;
ALTER TABLE public.chat_campaigns ADD COLUMN IF NOT EXISTS header_media_filename text;

INSERT INTO storage.buckets (id, name, public)
VALUES ('campaign-media', 'campaign-media', false)
ON CONFLICT (id) DO NOTHING;
