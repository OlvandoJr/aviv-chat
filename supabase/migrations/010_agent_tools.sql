-- ── chat_api_connections ──────────────────────────────────────────────────────
-- Armazena credenciais de integrações externas (Google Calendar, etc.)
CREATE TABLE IF NOT EXISTS chat_api_connections (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  provider    TEXT NOT NULL,                   -- 'google_calendar', 'smtp', 'webhook'
  credentials JSONB NOT NULL DEFAULT '{}',     -- service account JSON, tokens, etc.
  config      JSONB NOT NULL DEFAULT '{}',     -- ex: { "calendar_id": "..." }
  is_active   BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE chat_api_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can manage api_connections"
  ON chat_api_connections FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- ── chat_agent_tools ──────────────────────────────────────────────────────────
-- Ferramentas associadas a agentes (acionadas via OpenAI function calling)
CREATE TABLE IF NOT EXISTS chat_agent_tools (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          UUID REFERENCES chat_agents(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,          -- "Agendador de Pagamentos"
  description       TEXT NOT NULL,          -- instrução para o AI
  tool_type         TEXT NOT NULL,          -- 'payment_scheduler', 'webhook'
  config            JSONB NOT NULL DEFAULT '{}',
  api_connection_id UUID REFERENCES chat_api_connections(id) ON DELETE SET NULL,
  is_active         BOOLEAN DEFAULT true,
  sort_order        INT DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE chat_agent_tools ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can manage agent_tools"
  ON chat_agent_tools FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- ── chat_scheduled_payments ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_scheduled_payments (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id          UUID REFERENCES chat_conversations(id),
  contact_id               UUID REFERENCES chat_contacts(id),
  contact_name             TEXT,
  contact_wa_id            TEXT,
  scheduled_date           DATE NOT NULL,
  boleto_parcela           TEXT,
  boleto_valor             DECIMAL(10,2),
  google_event_id          TEXT,
  status                   TEXT DEFAULT 'agendado',   -- 'agendado','lembrado_dia','lembrado_hora','cancelado','pago'
  reminder_day_before_sent BOOLEAN DEFAULT false,
  reminder_1h_before_sent  BOOLEAN DEFAULT false,
  notes                    TEXT,
  created_at               TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE chat_scheduled_payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can manage scheduled_payments"
  ON chat_scheduled_payments FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- ── Coluna payment_scheduled_id em chat_conversations ─────────────────────────
ALTER TABLE chat_conversations
  ADD COLUMN IF NOT EXISTS payment_scheduled_id UUID REFERENCES chat_scheduled_payments(id);
