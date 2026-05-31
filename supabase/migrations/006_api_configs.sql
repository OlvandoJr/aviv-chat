-- Credenciais reutilizáveis (padrão n8n: auth fica separado do endpoint)
CREATE TABLE IF NOT EXISTS chat_api_credentials (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        varchar NOT NULL,
  auth_type   varchar NOT NULL CHECK (auth_type IN ('basic','bearer','api_key','custom_header')),
  config      jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

-- Configurações de API reutilizáveis
CREATE TABLE IF NOT EXISTS chat_api_configs (
  id                uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  name              varchar NOT NULL,
  description       text,
  method            varchar NOT NULL DEFAULT 'GET'
                    CHECK (method IN ('GET','POST','PUT','PATCH','DELETE')),
  url               varchar NOT NULL,
  auth_type         varchar NOT NULL DEFAULT 'none'
                    CHECK (auth_type IN ('none','basic','bearer','api_key','custom_header')),
  auth_config       jsonb   DEFAULT '{}',
  credential_id     uuid    REFERENCES chat_api_credentials(id) ON DELETE SET NULL,
  headers           jsonb   DEFAULT '[]',
  query_params      jsonb   DEFAULT '[]',
  body_type         varchar DEFAULT 'none'
                    CHECK (body_type IN ('none','json','form_data','urlencoded')),
  body_template     text,
  response_mapping  jsonb   DEFAULT '[]',
  is_active         boolean DEFAULT true,
  last_tested_at    timestamptz,
  last_test_status  varchar,
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);

-- RLS
ALTER TABLE chat_api_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_api_configs     ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth select api_credentials" ON chat_api_credentials FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth insert api_credentials" ON chat_api_credentials FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth update api_credentials" ON chat_api_credentials FOR UPDATE TO authenticated USING (true);
CREATE POLICY "auth delete api_credentials" ON chat_api_credentials FOR DELETE TO authenticated USING (true);

CREATE POLICY "auth select api_configs" ON chat_api_configs FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth insert api_configs" ON chat_api_configs FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth update api_configs" ON chat_api_configs FOR UPDATE TO authenticated USING (true);
CREATE POLICY "auth delete api_configs" ON chat_api_configs FOR DELETE TO authenticated USING (true);
