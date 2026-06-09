-- 029_storage_boletos.sql
-- Bucket PRIVADO para os PDFs dos boletos emitidos (lote semanal de 2ª via).
-- Upload e leitura acontecem server-side via service_role (API route /api/boletos/import
-- e signed URLs no ai-responder), portanto não há policy pública.

INSERT INTO storage.buckets (id, name, public)
VALUES ('boletos', 'boletos', false)
ON CONFLICT (id) DO NOTHING;

-- service_role já ignora RLS; mantemos o bucket sem policies públicas de propósito.
-- (Leitura no app é sempre por signed URL gerada com a service key.)
