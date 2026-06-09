-- 031_receipt_validation.sql
-- Marca conversas que receberam um comprovante que PRECISA de validação humana
-- (veredito do subagente não foi "100% válido"). Tag + filtro na lista de conversas,
-- separado do "aguardando atendente" (handled_by='pending_human').
ALTER TABLE public.chat_conversations
  ADD COLUMN IF NOT EXISTS receipt_validation boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS chat_conversations_receipt_validation_idx
  ON public.chat_conversations (receipt_validation)
  WHERE receipt_validation = true;
