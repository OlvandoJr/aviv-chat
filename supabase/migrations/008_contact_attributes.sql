-- ── 008_contact_attributes.sql ───────────────────────────────────────────────
-- Contact Attributes: "Campos Personalizáveis" feature
-- Two tables:
--   chat_contact_attribute_defs  → field definitions per agent (what to capture)
--   chat_contact_attributes      → captured values per contact

-- ── Definitions table ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_contact_attribute_defs (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     UUID        NOT NULL REFERENCES chat_agents(id) ON DELETE CASCADE,
  name         TEXT        NOT NULL,                        -- display label, e.g. "CPF do Cliente"
  key          TEXT        NOT NULL,                        -- slug, e.g. "cpf"
  field_type   TEXT        NOT NULL DEFAULT 'text',         -- 'cpf_cnpj' | 'email' | 'phone' | 'text' | 'number'
  action       TEXT        NOT NULL DEFAULT 'save',         -- 'save' | 'save_and_lookup_sienge'
  capture_regex TEXT,                                       -- optional override regex (NULL = use built-in for field_type)
  sort_order   INT         NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(agent_id, key)
);

-- ── Values table ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_contact_attributes (
  id                           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id                   UUID        NOT NULL REFERENCES chat_contacts(id) ON DELETE CASCADE,
  attribute_key                TEXT        NOT NULL,
  attribute_value              TEXT        NOT NULL,
  attribute_label              TEXT,                        -- snapshot of def.name at capture time
  captured_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  captured_in_conversation_id  UUID        REFERENCES chat_conversations(id) ON DELETE SET NULL,
  UNIQUE(contact_id, attribute_key)
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS chat_contact_attribute_defs_agent_id_idx
  ON chat_contact_attribute_defs (agent_id);

CREATE INDEX IF NOT EXISTS chat_contact_attributes_contact_id_idx
  ON chat_contact_attributes (contact_id);

-- ── Row-Level Security ────────────────────────────────────────────────────────
ALTER TABLE chat_contact_attribute_defs ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_contact_attributes     ENABLE ROW LEVEL SECURITY;

-- service_role bypasses RLS — edge functions use this role
-- authenticated users (dashboard) get full access
CREATE POLICY "service_role full access on attribute_defs"
  ON chat_contact_attribute_defs FOR ALL
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "authenticated full access on attribute_defs"
  ON chat_contact_attribute_defs FOR ALL
  TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "service_role full access on contact_attributes"
  ON chat_contact_attributes FOR ALL
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "authenticated full access on contact_attributes"
  ON chat_contact_attributes FOR ALL
  TO authenticated USING (true) WITH CHECK (true);
