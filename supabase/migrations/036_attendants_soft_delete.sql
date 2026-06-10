-- 036_attendants_soft_delete.sql
-- "Excluir usuário" = soft-delete. Apagar a linha de chat_attendants é inviável: as FKs
-- de chat_messages.attendant_id / chat_conversations.assignee_id / chat_campaigns.created_by
-- são NO ACTION (RESTRICT) e apagar destruiria a autoria do histórico. Em vez disso,
-- marcamos deleted_at (some da lista) e revogamos o login no Auth (lado da aplicação).
ALTER TABLE public.chat_attendants ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
