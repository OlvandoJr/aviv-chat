-- ============================================================
-- Aviv Chat — Adiciona coluna handled_by em chat_conversations
-- ============================================================

-- 'bot'            → bot está respondendo (padrão)
-- 'human'          → atendente humano assumiu
-- 'pending_human'  → bot escalou, aguardando atendente

ALTER TABLE chat_conversations
  ADD COLUMN IF NOT EXISTS handled_by text NOT NULL DEFAULT 'bot'
  CHECK (handled_by IN ('bot', 'human', 'pending_human'));

-- Índice para buscar conversas que precisam de atendimento humano
CREATE INDEX IF NOT EXISTS idx_chat_conversations_handled_by
  ON chat_conversations(handled_by);
