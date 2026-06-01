# Plano: Sistema de Ferramentas / Sub-agentes

> Criado em 2026-06-01. Retomar nesta sessão quando a janela de tokens virar.

---

## Contexto

O prompt do bot já orienta o usuário com opções:
**Pagar Boleto | Agendar Pagamento | Negociar | Já paguei esta parcela | Falar com atendente**

Cada opção tem um fluxo:
- **Pagar Boleto** → busca Sienge/SGL (já existe)
- **Negociar** → escala para humano (já existe via ESCALATION_SUFFIX)
- **Já paguei** → pede comprovante (já existe via process-media + ai_analysis)
- **Falar com atendente** → escala para humano (já existe)
- **Agendar Pagamento** → **NOVO — precisa ser construído**

---

## Arquitetura Geral

### Central de Integrações (`/integrations`)
Página onde o admin conecta APIs externas.
Cada conexão armazena credenciais com segurança e fica disponível para ferramentas.

### Ferramentas por Agente (na config do AgentEditor)
Cada agente pode ter N ferramentas. Uma ferramenta tem:
- Nome + descrição (o AI usa pra saber quando acioná-la)
- Tipo: `payment_scheduler`, `webhook`, `send_email`, etc.
- Integração conectada (ex: Google Calendar via Service Account)
- Config específica (ex: calendário ID, template de mensagem)

### Como o AI aciona ferramentas
Usando **OpenAI function calling nativo** (não token customizado):
1. ai-responder carrega as ferramentas do agente
2. Passa como `tools` na chamada OpenAI
3. Se OpenAI retorna `tool_calls` → executa a ferramenta
4. Envia resultado de volta ao OpenAI como `tool` role
5. OpenAI gera resposta final para o usuário

---

## Decisões do usuário

- **Auth Google Calendar**: Service Account (não OAuth2)
- **Lembretes**: WhatsApp via bot (não notificação no painel)
- **Ferramentas MVP**: Só o Agendador de Pagamento por enquanto

---

## 1. Banco de Dados (Migration)

### `chat_api_connections`
```sql
CREATE TABLE chat_api_connections (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,                          -- "Google Calendar Aviv"
  provider      TEXT NOT NULL,                          -- 'google_calendar', 'smtp', 'webhook'
  credentials   JSONB NOT NULL DEFAULT '{}',            -- service account JSON, tokens, etc.
  config        JSONB NOT NULL DEFAULT '{}',            -- ex: { "calendar_id": "..." }
  is_active     BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);
```

### `chat_agent_tools`
```sql
CREATE TABLE chat_agent_tools (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id            UUID REFERENCES chat_agents(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,                   -- "Agendador de Pagamentos"
  description         TEXT NOT NULL,                   -- usado no system prompt para o AI entender quando chamar
  tool_type           TEXT NOT NULL,                   -- 'payment_scheduler', 'webhook', 'send_email'
  config              JSONB NOT NULL DEFAULT '{}',     -- config específica da ferramenta
  api_connection_id   UUID REFERENCES chat_api_connections(id) ON DELETE SET NULL,
  is_active           BOOLEAN DEFAULT true,
  sort_order          INT DEFAULT 0,
  created_at          TIMESTAMPTZ DEFAULT now()
);
```

### `chat_scheduled_payments`
```sql
CREATE TABLE chat_scheduled_payments (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id             UUID REFERENCES chat_conversations(id),
  contact_id                  UUID REFERENCES chat_contacts(id),
  contact_name                TEXT,
  contact_wa_id               TEXT,
  scheduled_date              DATE NOT NULL,             -- data escolhida pelo cliente
  boleto_parcela              TEXT,                      -- descrição da parcela
  boleto_valor                DECIMAL(10,2),
  google_event_id             TEXT,                      -- ID do evento criado no Google Calendar
  status                      TEXT DEFAULT 'agendado',   -- 'agendado', 'lembrado_dia', 'lembrado_hora', 'cancelado'
  reminder_day_before_sent    BOOLEAN DEFAULT false,
  reminder_1h_before_sent     BOOLEAN DEFAULT false,
  notes                       TEXT,
  created_at                  TIMESTAMPTZ DEFAULT now()
);
```

### Adicionar status `pagamento_agendado` à conversa
```sql
-- Não precisa alterar o tipo — handled_by continua TEXT, mas o campo
-- é usado apenas para bot/human/pending_human.
-- Para "pagamento agendado", adicionar coluna separada:
ALTER TABLE chat_conversations
  ADD COLUMN IF NOT EXISTS payment_scheduled_id UUID REFERENCES chat_scheduled_payments(id);
```

---

## 2. Lógica de Datas Úteis (JavaScript/TypeScript)

```typescript
function isDiaUtil(date: Date): boolean {
  const dia = date.getDay()
  return dia !== 0 && dia !== 6
}

function adicionarDiasUteis(data: Date, diasUteis: number): Date {
  const dataAtual = new Date(data)
  let count = 0
  while (count < diasUteis) {
    dataAtual.setDate(dataAtual.getDate() + 1)
    if (isDiaUtil(dataAtual)) count++
  }
  return dataAtual
}

function formatarDataBR(data: Date): string {
  return data.toLocaleDateString('pt-BR')
}

function calcularDatasDisponiveis(): { d3: Date; d5: Date; d10: Date } {
  const hoje = new Date()
  return {
    d3:  adicionarDiasUteis(hoje, 3),
    d5:  adicionarDiasUteis(hoje, 5),
    d10: adicionarDiasUteis(hoje, 10),
  }
}
```

---

## 3. Ferramenta `payment_scheduler` — Function Calling OpenAI

### Tools a passar para OpenAI quando agente tem payment_scheduler ativo:

```typescript
const paymentSchedulerTools = [
  {
    type: 'function',
    function: {
      name: 'calcular_datas_pagamento',
      description: 'Calcula as próximas datas úteis disponíveis para o cliente agendar o pagamento do boleto. Use quando o cliente escolher a opção "Agendar Pagamento" ou mencionar que quer pagar em outra data.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'confirmar_agendamento',
      description: 'Confirma e registra o agendamento do pagamento para a data escolhida pelo cliente. Use depois que o cliente escolher uma das datas oferecidas.',
      parameters: {
        type: 'object',
        required: ['data_escolhida'],
        properties: {
          data_escolhida: {
            type: 'string',
            description: 'Data escolhida pelo cliente no formato DD/MM/YYYY',
          },
          observacoes: {
            type: 'string',
            description: 'Observações adicionais do cliente sobre o agendamento',
          },
        },
      },
    },
  },
]
```

### Execução no ai-responder:

```typescript
// Após chamar OpenAI e receber tool_calls:
if (openAiData.choices[0].finish_reason === 'tool_calls') {
  const toolCall = openAiData.choices[0].message.tool_calls[0]
  const toolName = toolCall.function.name
  const toolArgs = JSON.parse(toolCall.function.arguments || '{}')
  
  let toolResult = ''
  
  if (toolName === 'calcular_datas_pagamento') {
    const { d3, d5, d10 } = calcularDatasDisponiveis()
    toolResult = JSON.stringify({
      datas: [
        { label: formatarDataBR(d3), iso: d3.toISOString().split('T')[0] },
        { label: formatarDataBR(d5), iso: d5.toISOString().split('T')[0] },
        { label: formatarDataBR(d10), iso: d10.toISOString().split('T')[0] },
      ]
    })
  }
  
  if (toolName === 'confirmar_agendamento') {
    // 1. Salvar em chat_scheduled_payments
    // 2. Criar evento no Google Calendar (se api_connection configurada)
    // 3. Atualizar chat_conversations.payment_scheduled_id
    // 4. toolResult = { success: true, google_event_url: "..." }
    toolResult = await handleConfirmarAgendamento(toolArgs, conv, contact, tool)
  }
  
  // Segunda chamada ao OpenAI com o resultado da tool
  openAiMessages.push(openAiData.choices[0].message) // mensagem com tool_calls
  openAiMessages.push({
    role: 'tool',
    tool_call_id: toolCall.id,
    content: toolResult,
  })
  
  // Nova chamada para gerar resposta final
  const finalResp = await fetch('https://api.openai.com/v1/chat/completions', { ... })
  botReply = finalResp.choices[0].message.content
}
```

---

## 4. Google Calendar — Service Account

### Setup:
1. No Google Cloud Console → IAM → Service Accounts → Criar conta
2. Baixar JSON da service account
3. Compartilhar o calendário desejado com o email da service account
4. Colar o JSON em `chat_api_connections.credentials`

### Criar evento (Deno/TypeScript):
```typescript
async function criarEventoCalendario(
  serviceAccountJson: any,
  calendarId: string,
  evento: {
    summary: string,
    description: string,
    startDate: string, // YYYY-MM-DD
    contactEmail?: string,
  }
): Promise<string | null> {
  // 1. Gerar JWT com service account
  // 2. Trocar por access_token via https://oauth2.googleapis.com/token
  // 3. POST https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events
  // 4. Retornar event.id
}
```

> Lib recomendada para JWT no Deno: `https://deno.land/x/djwt`

---

## 5. Edge Function `send-reminders`

### Lógica:
```typescript
// Roda a cada hora via cron do Supabase
// Verificar lembretes do DIA ANTERIOR ao scheduled_date
// Verificar lembretes de UMA HORA ANTES (quando scheduled_date é hoje + horário ~9h)

const amanha = new Date()
amanha.setDate(amanha.getDate() + 1)
const dataAmanha = amanha.toISOString().split('T')[0]

// Lembrete do dia anterior
const { data: remindersDia } = await supabase
  .from('chat_scheduled_payments')
  .select('*, conversation:chat_conversations(*)')
  .eq('scheduled_date', dataAmanha)
  .eq('reminder_day_before_sent', false)
  .eq('status', 'agendado')

for (const payment of remindersDia) {
  // Enviar WhatsApp via send-message
  await sendWhatsAppReminder(payment, 'day_before')
  await supabase.from('chat_scheduled_payments')
    .update({ reminder_day_before_sent: true })
    .eq('id', payment.id)
}

// Lembrete de 1h antes (só se scheduled_date é hoje)
// ... similar logic ...
```

### Agendar o cron:
No Supabase Dashboard → Edge Functions → `send-reminders` → Schedule: `0 * * * *` (todo hora)

---

## 6. UI — AgentEditor: Seção "Ferramentas"

### Componente ToolEditor (dentro de AgentEditor.tsx):

```tsx
// Nova aba ou seção "Ferramentas" no AgentEditor
// Lista ferramentas existentes do agente
// Botão "Adicionar Ferramenta"
// Modal/drawer com:
//   - Nome da ferramenta
//   - Tipo (select: Agendador de Pagamentos, Webhook, ...)
//   - Descrição (textarea - explica ao AI quando usar)
//   - Integração conectada (select de chat_api_connections)
//   - Config específica do tipo

interface AgentTool {
  id: string
  name: string
  description: string
  tool_type: 'payment_scheduler' | 'webhook' | 'send_email'
  api_connection_id: string | null
  config: Record<string, any>
  is_active: boolean
}
```

---

## 7. Página `/integrations`

### Rota: `app/integrations/page.tsx`

```
┌─────────────────────────────────────────┐
│ Integrações                             │
│                                         │
│ ┌─────────────────┐  ┌───────────────┐  │
│ │ 🗓 Google Cal.  │  │ + Nova        │  │
│ │ ✅ Conectado    │  │ Integração    │  │
│ │ [Editar]        │  │               │  │
│ └─────────────────┘  └───────────────┘  │
└─────────────────────────────────────────┘
```

Para Google Calendar com Service Account:
- Upload/paste do JSON da service account
- Campo para Calendar ID (ex: `nome@grupo.calendar.google.com`)
- Botão "Testar Conexão" → tenta listar eventos

---

## 8. Ordem de Implementação

1. **Migration SQL** (DB schema completo)
2. **`send-reminders` Edge Function** (lógica de lembretes WhatsApp)
3. **Atualizar `ai-responder`** (function calling + execução das tools)
4. **Página `/integrations`** (Service Account Google Calendar)
5. **AgentEditor — Seção Ferramentas** (CRUD de tools)
6. **Testar fluxo completo**

---

## Arquivos a criar/modificar

| Arquivo | Ação |
|---|---|
| `supabase/migrations/010_agent_tools.sql` | CRIAR |
| `supabase/functions/send-reminders/index.ts` | CRIAR |
| `supabase/functions/ai-responder/index.ts` | MODIFICAR (function calling) |
| `app/integrations/page.tsx` | CRIAR |
| `components/integrations/ApiConnectionEditor.tsx` | CRIAR |
| `components/agents/AgentEditor.tsx` | MODIFICAR (seção Ferramentas) |
| `components/agents/ToolEditor.tsx` | CRIAR |
| `lib/types.ts` | MODIFICAR (AgentTool, ApiConnection, ScheduledPayment) |

---

## Notas adicionais

- O `handled_by` da conversa NÃO muda para um novo valor. A conversa continua como `bot` mesmo com pagamento agendado. O `payment_scheduled_id` é o sinalizador.
- Os lembretes de WhatsApp usam a inbox da conversa original (mesmo número de bot).
- Google Calendar Service Account: não precisa de OAuth redirect, só o JSON e o calendarId.
- O lembrete de "1 hora antes" é relativo ao horário padrão do dia (ex: 9h = lembrete às 8h). Configurável no tool config.
- Feriados: MVP não considera feriados, só fins de semana. Pode ser adicionado depois como lista configurável.
