-- ──────────────────────────────────────────────────────────────────────────────
-- 003_add_agents.sql
-- Tabela de agentes de IA configuráveis + regras de roteamento
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS chat_agents (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 TEXT         NOT NULL,
  description          TEXT,
  avatar_emoji         TEXT         NOT NULL DEFAULT '🤖',
  is_active            BOOLEAN      NOT NULL DEFAULT true,
  is_default           BOOLEAN      NOT NULL DEFAULT false,

  -- Configuração do modelo de IA
  model                TEXT         NOT NULL DEFAULT 'gpt-4o-mini',
  temperature          NUMERIC(3,2) NOT NULL DEFAULT 0.70,
  max_tokens           INTEGER      NOT NULL DEFAULT 600,
  memory_messages      INTEGER      NOT NULL DEFAULT 25,

  -- Prompts e mensagens
  system_prompt        TEXT         NOT NULL DEFAULT '',
  greeting_message     TEXT,
  off_hours_message    TEXT,

  -- Dados injetados no contexto
  include_boletos      BOOLEAN      NOT NULL DEFAULT true,
  include_contact_info BOOLEAN      NOT NULL DEFAULT true,
  custom_context       TEXT,

  -- Escalação
  escalation_keywords  TEXT[]       NOT NULL DEFAULT '{}',
  escalation_message   TEXT,

  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- RLS
ALTER TABLE chat_agents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins gerenciam agentes" ON chat_agents
  FOR ALL USING (
    EXISTS (SELECT 1 FROM chat_attendants WHERE id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "Atendentes visualizam agentes" ON chat_agents
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM chat_attendants WHERE id = auth.uid())
  );

-- ──────────────────────────────────────────────────────────────────────────────
-- Regras de roteamento de agentes
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS chat_agent_rules (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    UUID        NOT NULL REFERENCES chat_agents(id) ON DELETE CASCADE,
  rule_type   TEXT        NOT NULL CHECK (rule_type IN ('tag', 'keyword', 'inbox')),
  rule_value  TEXT        NOT NULL,
  priority    INTEGER     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE chat_agent_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins gerenciam regras de agentes" ON chat_agent_rules
  FOR ALL USING (
    EXISTS (SELECT 1 FROM chat_attendants WHERE id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "Atendentes visualizam regras de agentes" ON chat_agent_rules
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM chat_attendants WHERE id = auth.uid())
  );

-- ──────────────────────────────────────────────────────────────────────────────
-- Vincular conversas a agentes
-- ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE chat_conversations
  ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES chat_agents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_chat_conversations_agent_id
  ON chat_conversations(agent_id);

-- ──────────────────────────────────────────────────────────────────────────────
-- Seed: Agente padrão (Avi — cobrança)
-- ──────────────────────────────────────────────────────────────────────────────

INSERT INTO chat_agents (
  name, description, avatar_emoji, is_active, is_default,
  model, temperature, max_tokens, memory_messages,
  system_prompt, greeting_message,
  include_boletos, include_contact_info,
  escalation_message,
  escalation_keywords
) VALUES (
  'Avi',
  'Assistente virtual de cobrança da Aviv Construtora',
  '🤖',
  true,
  true,
  'gpt-4o-mini',
  0.60,
  600,
  25,
  'Você é a Avi, assistente virtual de cobrança da Aviv Construtora — uma incorporadora focada em imóveis residenciais.

MISSÃO:
Auxiliar clientes com dúvidas sobre boletos, parcelas, atrasos e comprovantes de pagamento, com agilidade e empatia.

COMPORTAMENTO:
- Seja sempre educada, empática e profissional
- Use linguagem simples e direta em português brasileiro
- Nunca invente valores, datas ou informações — use apenas os dados fornecidos
- Responda de forma concisa (máximo 3 parágrafos curtos)
- Use emojis com moderação para deixar o tom mais amigável

SOBRE BOLETOS E PARCELAS:
- Você tem acesso aos boletos cadastrados do cliente (listados abaixo como DADOS DO CLIENTE)
- Se o cliente perguntar sobre parcela, vencimento ou valor, use os dados fornecidos
- Informe que o pagamento pode ser feito via Pix ou boleto bancário
- Para boletos vencidos, oriente o cliente a entrar em contato para atualização do boleto

SOBRE COMPROVANTES (imagens/documentos):
- Quando o cliente enviar um comprovante, confirme o recebimento: "Recebi seu comprovante! Aguarde enquanto verificamos o pagamento. ✅"
- Se a análise já estiver disponível no contexto:
  * Se STATUS = CONFIRMADO COMO PAGO: comemore e informe que o pagamento foi registrado
  * Se STATUS = PENDENTE DE CONFIRMAÇÃO: informe que está sob análise manual e que retornarão em breve

SOBRE ÁUDIO:
- Se receber transcrição de áudio, responda ao conteúdo da mensagem normalmente

QUANDO TRANSFERIR PARA ATENDENTE HUMANO:
Se alguma destas situações ocorrer, responda APENAS com:
ESCALAR_HUMANO: [motivo]

Situações que exigem escalação:
- Cliente solicita falar com atendente, humano, pessoa, gerente ou responsável
- Dúvida jurídica ou solicitação de acordo/renegociação especial
- Reclamação grave ou ameaça jurídica
- Situação que você não consegue resolver com os dados disponíveis
- Cliente demonstra frustração extrema ou hostilidade

SAUDAÇÃO:
- Na primeira mensagem da conversa, cumprimente o cliente pelo nome (se disponível) e pergunte em que pode ajudar',
  'Olá! Sou a Avi, assistente virtual da Aviv Construtora. Como posso ajudar você hoje? 😊',
  true,
  true,
  'Entendido! Vou encaminhar você para um de nossos atendentes agora mesmo. Por favor, aguarde um momento. 🙏',
  ARRAY['atendente', 'humano', 'gerente', 'responsável', 'pessoa']
);
