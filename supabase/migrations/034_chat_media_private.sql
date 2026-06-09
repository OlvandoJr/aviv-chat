-- 034_chat_media_private.sql
-- SEGURANÇA: torna o bucket `chat-media` PRIVADO. Ele guarda mídia do cliente
-- (imagens, áudios, documentos e COMPROVANTES com PII financeira) que estava
-- acessível por URL pública sem login + listável (advisor public_bucket_allows_listing).
--
-- Pré-requisito (já no ar): todo acesso passou a ser server-side via service role —
-- proxy autenticado `/api/media` para a UI, e signed URLs para Meta/OpenAI nos produtores
-- (process-media, ai-responder/enviarBoletoPDF, /api/boletos/forward). send-media usa media_id.
--
-- Por isso podemos remover a policy de leitura ampla: signed URLs via service role
-- ignoram RLS, então nada client-side depende dessa policy.

UPDATE storage.buckets SET public = false WHERE id = 'chat-media';

DROP POLICY IF EXISTS "authenticated read chat-media" ON storage.objects;
