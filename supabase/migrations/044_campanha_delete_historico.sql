-- 044_campanha_delete_historico.sql
-- (1) Exclusão de campanha = SOFT-DELETE (deleted_at): some da lista, mas o nome
--     continua resolvível p/ o histórico do cliente (evita perder a auditoria).
-- (2) vw_campanhas_cliente: histórico de campanhas POR CLIENTE — a mensagem real
--     enviada (chat_messages.metadata.campaign_id) ligada ao contato pela conversa.
--     Robusto contra a inconsistência de normalização do wa_id em recipients.

ALTER TABLE public.chat_campaigns ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE OR REPLACE VIEW public.vw_campanhas_cliente
WITH (security_invoker = true) AS
SELECT
  m.id              AS message_id,
  conv.contact_id   AS contact_id,
  m.conversation_id AS conversation_id,
  m.created_at      AS created_at,
  m.content         AS content,
  m.wa_status       AS wa_status,
  cmp.id            AS campaign_id,
  cmp.name          AS campaign_name,
  tpl.name          AS template_name
FROM public.chat_messages m
JOIN public.chat_conversations conv ON conv.id = m.conversation_id
JOIN public.chat_campaigns cmp      ON cmp.id = (m.metadata->>'campaign_id')::uuid
LEFT JOIN public.chat_wa_templates tpl ON tpl.id = cmp.template_id
WHERE m.metadata ? 'campaign_id';
