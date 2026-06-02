-- ── Campos de Atualização de Conversa ────────────────────────────────────────
-- Cada agente pode definir quais campos da conversa o bot pode atualizar.
-- A coluna real (cf_<key>) é criada automaticamente via RPC.

CREATE TABLE IF NOT EXISTS chat_conversation_update_defs (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    UUID        NOT NULL REFERENCES chat_agents(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,            -- rótulo humano, ex: "Status de Pagamento"
  key         TEXT        NOT NULL,            -- slug, ex: "status_pagamento" → cria cf_status_pagamento
  field_type  TEXT        NOT NULL DEFAULT 'text',  -- 'text' | 'select' | 'number' | 'boolean'
  options     TEXT[]      NOT NULL DEFAULT '{}',    -- para field_type = 'select'
  description TEXT        NOT NULL DEFAULT '',      -- instrução para o AI sobre quando atualizar
  sort_order  INT         NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE chat_conversation_update_defs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can manage update defs"
  ON chat_conversation_update_defs
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- ── RPC: cria coluna cf_<key> em chat_conversations ───────────────────────────
CREATE OR REPLACE FUNCTION create_conversation_field(
  p_key  TEXT,
  p_type TEXT DEFAULT 'text'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  col_name TEXT := 'cf_' || p_key;
  col_ddl  TEXT;
BEGIN
  -- Validação estrita para evitar SQL injection
  IF p_key !~ '^[a-z][a-z0-9_]{0,50}$' THEN
    RAISE EXCEPTION 'Nome de campo inválido: %. Use apenas letras minúsculas, números e underscore.', p_key;
  END IF;

  col_ddl := CASE p_type
    WHEN 'number'  THEN 'NUMERIC'
    WHEN 'boolean' THEN 'BOOLEAN'
    ELSE 'TEXT'
  END;

  EXECUTE format(
    'ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS %I %s',
    col_name,
    col_ddl
  );

  -- Notifica o PostgREST para recarregar o schema imediatamente
  NOTIFY pgrst, 'reload schema';
END;
$$;

GRANT EXECUTE ON FUNCTION create_conversation_field(TEXT, TEXT) TO authenticated;
