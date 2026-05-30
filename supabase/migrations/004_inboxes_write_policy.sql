-- ================================================================
-- Migration 004 — Caixas de Entrada: permissões de escrita + extras
-- ================================================================

-- Coluna de descrição (opcional)
ALTER TABLE chat_inboxes ADD COLUMN IF NOT EXISTS description text;

-- Políticas de escrita para admin autenticado
CREATE POLICY "authenticated insert inboxes"
  ON chat_inboxes FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "authenticated update inboxes"
  ON chat_inboxes FOR UPDATE TO authenticated USING (true);

CREATE POLICY "authenticated delete inboxes"
  ON chat_inboxes FOR DELETE TO authenticated USING (true);
