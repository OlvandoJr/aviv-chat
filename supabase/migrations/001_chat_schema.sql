-- ============================================================
-- Aviv Chat — Schema do banco de dados
-- ============================================================

-- ── Inboxes (números WhatsApp configurados) ─────────────────
CREATE TABLE IF NOT EXISTS chat_inboxes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  phone_number     text NOT NULL,
  phone_number_id  text NOT NULL UNIQUE,
  access_token     text NOT NULL,
  verify_token     text NOT NULL,
  is_active        boolean DEFAULT true,
  created_at       timestamptz DEFAULT now()
);

-- ── Contatos (clientes WhatsApp) ────────────────────────────
CREATE TABLE IF NOT EXISTS chat_contacts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_id                text NOT NULL UNIQUE, -- número com DDI: 5511999998888
  name                 text,
  profile_picture_url  text,
  created_at           timestamptz DEFAULT now(),
  updated_at           timestamptz DEFAULT now()
);

-- ── Atendentes ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_attendants (
  id         uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name       text NOT NULL,
  email      text NOT NULL UNIQUE,
  avatar_url text,
  role       text NOT NULL DEFAULT 'agent', -- 'admin' | 'agent'
  is_active  boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

-- ── Conversas ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_conversations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_id             uuid NOT NULL REFERENCES chat_inboxes(id),
  contact_id           uuid NOT NULL REFERENCES chat_contacts(id),
  assignee_id          uuid REFERENCES chat_attendants(id),
  status               text NOT NULL DEFAULT 'open', -- 'open' | 'resolved' | 'archived'
  last_message_at      timestamptz,
  last_message_preview text,
  unread_count         int NOT NULL DEFAULT 0,
  sector               text, -- 'Cobrança' | 'Vendas' | 'Outros'
  created_at           timestamptz DEFAULT now(),
  updated_at           timestamptz DEFAULT now()
);

-- ── Mensagens ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  wa_message_id   text UNIQUE, -- ID da mensagem no WhatsApp
  direction       text NOT NULL CHECK (direction IN ('in', 'out')),
  type            text NOT NULL DEFAULT 'text', -- 'text'|'image'|'audio'|'document'|'button'|'template'
  content         text,            -- conteúdo texto
  media_url       text,            -- URL do arquivo no Supabase Storage
  media_mime_type text,
  media_filename  text,
  wa_status       text DEFAULT 'sent', -- 'sent'|'delivered'|'read'|'failed'
  ai_analysis     jsonb,           -- resultado da análise de comprovante
  metadata        jsonb,           -- dados extras (ex: transcrição de áudio)
  attendant_id    uuid REFERENCES chat_attendants(id), -- quem enviou (se direction='out')
  created_at      timestamptz DEFAULT now()
);

-- ── Índices ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_chat_conversations_status        ON chat_conversations(status);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_contact       ON chat_conversations(contact_id);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_assignee      ON chat_conversations(assignee_id);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_last_msg      ON chat_conversations(last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation       ON chat_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created            ON chat_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_contacts_wa_id              ON chat_contacts(wa_id);

-- ── RLS ─────────────────────────────────────────────────────
ALTER TABLE chat_inboxes       ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_contacts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_attendants    ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages      ENABLE ROW LEVEL SECURITY;

-- Atendentes autenticados leem tudo
CREATE POLICY "authenticated read inboxes"
  ON chat_inboxes FOR SELECT TO authenticated USING (true);

CREATE POLICY "authenticated read contacts"
  ON chat_contacts FOR SELECT TO authenticated USING (true);

CREATE POLICY "authenticated manage contacts"
  ON chat_contacts FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "authenticated read attendants"
  ON chat_attendants FOR SELECT TO authenticated USING (true);

CREATE POLICY "authenticated manage attendants"
  ON chat_attendants FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "authenticated read conversations"
  ON chat_conversations FOR SELECT TO authenticated USING (true);

CREATE POLICY "authenticated manage conversations"
  ON chat_conversations FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "authenticated read messages"
  ON chat_messages FOR SELECT TO authenticated USING (true);

CREATE POLICY "authenticated insert messages"
  ON chat_messages FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "authenticated update messages"
  ON chat_messages FOR UPDATE TO authenticated USING (true);

-- Service role (Edge Functions) tem acesso total — sem restrição de RLS
-- (service_role bypassa RLS automaticamente)

-- ── Inserir inbox padrão (número de cobrança) ───────────────
INSERT INTO chat_inboxes (name, phone_number, phone_number_id, access_token, verify_token)
VALUES (
  'Cobrança Aviv',
  '554391318822',
  '761871190338757',
  'EAAZCmJ7vL7W4BRFq2pgVWMcyProNuVkpo6x1AZCgmgSNKIXB2x518qq3HcQCJAI4VjTFEOZBYTdWmAyuycCSQCR2JdGIUOO9PP6MZBXDfWkGD1qaBgVw1zYmxq2loS973hw4jc5oLhns3OMdIuWXDfV4fSSMv2vzyYAR7XUmNeDhfr56LlZCZAG4GH9ZAwmZCAFYlwZDZD',
  'aviv-webhook-2025'
)
ON CONFLICT (phone_number_id) DO NOTHING;

-- ── Trigger: atualiza updated_at automaticamente ─────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_chat_conversations_updated_at
  BEFORE UPDATE ON chat_conversations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_chat_contacts_updated_at
  BEFORE UPDATE ON chat_contacts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── Habilitar Realtime nas tabelas do chat ───────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE chat_conversations;
ALTER PUBLICATION supabase_realtime ADD TABLE chat_messages;
