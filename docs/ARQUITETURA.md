# Aviv Chat — Documentação de Arquitetura

> Documento vivo. **Sempre que algo novo for construído ou alterado de forma relevante, atualize
> aqui** (e marque a data na seção [Changelog](#15-changelog-de-decisões)). É a referência única para
> um dev entender, replicar, ajustar e operar o sistema.

Última atualização: **2026-06-11**

---

## 1. Visão geral

**Aviv Chat** é o sistema de **atendimento e cobrança via WhatsApp** da **Aviv Construtora**. Ele:

- Recebe e responde mensagens do WhatsApp (Cloud API da Meta) com **bots de IA** (OpenAI).
- Faz **cobrança proativa** de boletos (régua automática + campanhas).
- **Valida comprovantes** de pagamento enviados pelo cliente (imagem/PDF).
- Envia a **2ª via do boleto** (PDF + linha digitável) a partir do banco.
- Integra com o ERP **Sienge** (clientes, boletos, baixa via webhook) e com o sistema legado **SGL**.
- Oferece uma **Central de Clientes** (visão 360) e telas de gestão (campanhas, régua, agentes, templates, etc.).

Dois bots convivem no **mesmo número/inbox**:
| Bot | id | Papel |
|---|---|---|
| **Vivi** (`is_default`) | `ead82b93-84c8-49bf-98bb-53d395b49ba7` | Cobrança, 2ª via de boleto, validação de comprovante. |
| **Contato Inteligente** | `1f054c3f-97f0-4cee-9a1a-ceede21e9943` | Jornada guiada estilo DigitaAi (LGPD → CPF → menu 1‑6 → CSAT) para contato avulso. |

O **roteamento por origem** decide qual bot atende (ver [§8.2](#82-roteamento-de-agente-regra-das-24h)).

---

## 2. Stack & infraestrutura

| Camada | Tecnologia |
|---|---|
| Frontend / BFF | **Next.js 16** (App Router, RSC), **React 19**, **Tailwind CSS 4**, `lucide-react` |
| Auth & DB | **Supabase** (Postgres + Auth + Storage + Realtime). Projeto `jpxlczmbxfcnujemlxzq` |
| Backend assíncrono | **Supabase Edge Functions** (Deno/TypeScript) |
| IA | **OpenAI** (`gpt-4o-mini` padrão; `gpt-4o` para PDF/visão; Whisper para áudio) |
| Mensageria | **WhatsApp Cloud API** (Meta Graph v20.0) |
| ERP | **Sienge** (REST, plano **Free** → cota baixa) + **webhook** de baixa |
| Legado | **SGL** (sem API — boletos com link, via tabela `mensagens_cobranca`) |
| Automação legada | **n8n** (em desativação; ainda usado por alguns fluxos antigos) |
| Hospedagem do app | **Vercel** (deploy automático no merge para `main`) |
| Repositório | `github.com/OlvandoJr/aviv-chat` |

**Fluxo de entrega:** trabalha-se em branch → PR → **squash-merge** para `main` → Vercel faz o deploy do
app automaticamente. **Edge Functions e migrations NÃO sobem no merge** — são publicadas
manualmente (ver [§13](#13-como-rodar--deployar)).

---

## 3. Estrutura do repositório

```
app/                      # Next App Router (páginas + API routes)
  api/                    # Route handlers (BFF; rodam no servidor)
    boletos/              #   confirm, import, pdf, forward
    campaigns/, regua/, templates/, send-template, send-media, attendants
  conversations/, clients/, campaigns/, regua/, agents/, apis/,
  inboxes/, templates/, integrations/, calendar/, settings/, boletos/, login/
components/               # UI React (client components)
  chat/ conversations/ clients/ agents/ apis/ campaigns/ inboxes/
  integrations/ calendar/ boletos/ whatsapp/ ui/
lib/
  supabase/{client,server}.ts   # factories de client (browser / RSC)
  whatsapp/{send,conversation,vars}.ts  # núcleo de disparo (lado Next)
  types.ts utils.ts
supabase/
  functions/              # Edge Functions (Deno)
    _shared/{whatsapp,apiExec}.ts
    ai-responder/ process-media/ whatsapp-webhook/ send-message/
    dispatch-campaign/ cobranca-regua/ sgl-dispatch/ import-boletos/
    sienge-webhook/ test-api-call/ analyze-comprovante/ send-reminders/ list-models/
  migrations/             # 001…033 (SQL versionado)
docs/
  ARQUITETURA.md (este)  ROADMAP.md  SEGURANCA.md
scripts/
  test-boleto-extract.cjs # valida o parser de boletos vs n8n
```

---

## 4. Variáveis de ambiente / secrets

**Next (`.env.local` / Vercel):**
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` — client público.
- `SUPABASE_SERVICE_ROLE_KEY` — usado **server-side** (route handlers) para bypass de RLS.

**Edge Functions (Supabase secrets):**
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY`
- `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` (fallback; o token real vem do inbox)
- `SIENGE_USER`, `SIENGE_PASSWORD` (auth basic da API Sienge)
- `SIENGE_WEBHOOK_TOKEN`, `SIENGE_WEBHOOK_CONFIRM` (proteção do webhook de baixa)

> ⚠️ O CLI `supabase secrets set` apresentou bug de token nesta conta; secrets foram definidos pelo
> **Dashboard**. Credenciais de WhatsApp ficam **por inbox** em `chat_inboxes.access_token`.

---

## 5. Integrações externas

### 5.1 WhatsApp Cloud API (Meta)
- Webhook de entrada → Edge `whatsapp-webhook` (verificação GET + POST de mensagens/status).
- Envio: Graph `POST /{phone_number_id}/messages` (texto, template, document, etc.).
- **Janela de 24h**: fora dela só **templates** aprovados podem ser enviados (erro `131047`).
- Credenciais por inbox em `chat_inboxes` (`phone_number_id`, `access_token`, `waba_id`, `verify_token`).

### 5.2 OpenAI
- `ai-responder`: chat + **function calling** (tools).
- `process-media`: extração + veredito de comprovante (2 passos), Whisper (áudio, timeout 25s).

### 5.3 Sienge (ERP) — **cota baixa (plano Free)**
- Base: `https://api.sienge.com.br/avivconstrutora/public/api/v1`, **auth basic** `SIENGE_USER:SIENGE_PASSWORD`.
- Usos: `customers`, `accounts-receivable/receivable-bills[/installments]`,
  `payment-slip-notification` (2ª via), `total-current-debit-balance` (quitação), etc.
- **Princípio:** NÃO bater na API boleto a boleto. A fonte de verdade é o banco
  (`boletos_emitidos`); Sienge é **fallback**.
- **Webhook de baixa** (push, sem consumir cota): `RECEIPT_PROCESSED` e
  `UPDATE_RECEIVABLE_BILL_SITUATION` → Edge `sienge-webhook` (hook id `69881d0c-4e6c-4d6a-a800-d9e96c440517`).

### 5.4 SGL (legado)
- Sem API. Boletos legados ficam em `mensagens_cobranca` (já têm **link** de pagamento).
- Bot envia o link direto; não usa 2ª via do Sienge para esses.

### 5.5 n8n (legado, em desativação)
- Workflow antigo "Importar Boletos do Drive" foi **substituído** pela tela `/boletos` (ver [§8.3](#83-boletos-fluxo-completo)).
- Régua/cobrança antiga do n8n em processo de cutover.

---

## 6. Modelo de dados

### 6.1 Núcleo do chat
| Tabela | Função |
|---|---|
| `chat_inboxes` | Caixas WhatsApp (creds, waba_id, verify_token). |
| `chat_contacts` | Contatos (`wa_id` normalizado, nome, foto). |
| `chat_conversations` | Conversas. Campos-chave: `status` (open/resolved/archived), `handled_by` (bot/human/pending_human), `agent_id`, `assignee_id`, `unread_count`, **`receipt_validation`** (bool — comprovante aguardando validação humana). |
| `chat_messages` | Mensagens (`direction`, `type`, `content`, `media_url`, `wa_status`, `ai_analysis` jsonb, `metadata`). |
| `chat_attendants` | Usuários do sistema (`role`: admin/manager/agent; `sector`). |

### 6.2 Agentes / IA
| Tabela | Função |
|---|---|
| `chat_agents` | Bots (system_prompt, model, include_boletos, escalation_rules, is_default, …). |
| `chat_agent_rules` | Roteamento por inbox/tag/keyword → agente. |
| `chat_agent_tools` | Tools de function-calling. `tool_type`: `payment_scheduler` \| `webhook` \| `api_call`. |
| `chat_subagents` (+ `chat_subagent_datasources`) | Subagentes por gatilho (`text`/`image`/`document`/`audio`) com prompts e **fontes de dados** (consultas/escritas à base). |
| `chat_contact_attribute_defs` (+ `chat_contact_attributes`) | Campos capturados do cliente (CPF/e-mail…), com `action` `save` ou `save_and_lookup_sienge`. |
| `chat_conversation_update_defs` | Campos que o bot pode atualizar (ex.: CSAT) via tool `atualizar_conversa`. |
| `chat_api_configs` | Construtor de APIs (`/apis`) — base das tools `api_call`. |
| `chat_api_connections`, `chat_api_credentials` | Conexões/credenciais de provedores. |

### 6.3 Boletos / cobrança
| Tabela | Função |
|---|---|
| **`boletos_emitidos`** | **Fonte de verdade do boleto.** Lote semanal de 2ª via (CAIXA). Tem `valor` REAL (c/ juros), `linha_digitavel`, `pdf_path` (Storage), `vencimento`, `client_id` (Sienge), `phone_norm`, `status`, `paid_at`. Unique `(client_id, vencimento)`. |
| `sienge_boletos` | Parcelas vindas do Sienge (valor da parcela, sem juros). Status `aberto`/`pago`/…, `paid_at`. |
| `sienge_clientes` | Cadastro de clientes Sienge (telefone, cpf, nome, client_id). |
| `sienge_comprovantes` | Registro de comprovante por boleto (quando há id local). |
| `mensagens_cobranca` | Boletos/cobrança **SGL** (link de pagamento embutido). |
| `cobranca_regua` (+ `_step`, `_log`) | Régua Sienge (cadência por offset de vencimento). |
| `sgl_regua_map`, `sienge_cobranca_log`, `sienge_notificacoes` | Apoio à cobrança. |
| `chat_campaigns` (+ `chat_campaign_recipients`) | Campanhas de disparo em massa. |
| `chat_scheduled_payments` | Agendamentos de pagamento (tool `payment_scheduler`). |
| `sienge_webhook_events`, `sienge_webhook_log` | Auditoria dos webhooks Sienge. |
| `sienge_empreendimentos` | Empreendimentos (referência para validação de comprovante). |

### 6.4 Views (importantes — qual usar)
| View | Quem usa | `amount` (valor) | Observação |
|---|---|---|---|
| **`vw_boleto_chat`** | **bot (ai-responder)** + validação | boleto emitido | só boletos emitidos em aberto + IDs Sienge (join) + `pdf_path`, `linha_digitavel`, `customer_cpf`. |
| **`vw_cobranca_boletos`** | **régua** | boleto emitido | por boleto, com linha digitável. |
| **`vw_clientes_boletos`** | **campanhas (audiência)** + fallback | boleto emitido (fallback parcela) | deduplicado por telefone; prioriza quem tem boleto emitido. |
| **`vw_boletos_central`** | **Central de Clientes** (seção Boletos) | boleto emitido | status unificado (pago se emitido OU parcela paga) + cadastro Sienge. |
| **`vw_comprovantes`** | **Central** (histórico de comprovantes) | — | comprovantes de `chat_messages` (verdito) por `phone_norm`. |
| `vw_central_clientes` | Central (lista 360) | — | 1 linha por telefone (chat + Sienge + SGL). |

> **Regra de ouro:** o **valor do boleto** vem sempre de `boletos_emitidos.valor` (com juros/multa),
> nunca de `sienge_boletos.amount` (parcela). Todas as views de cobrança já seguem isso.

---

## 7. Edge Functions (Deno)

| Função | Disparada por | O que faz |
|---|---|---|
| **`whatsapp-webhook`** | Meta (GET verify / POST) | Dedup por `wa_message_id`; upsert contato/conversa; salva mensagem; status updates (inclui detectar janela fechada `131047`); aciona `process-media` (mídia) ou `ai-responder` (texto). Normaliza o `from`. |
| **`process-media`** | `whatsapp-webhook` | Baixa mídia → Storage; **áudio**: Whisper + interpreta; **imagem/PDF**: extrai campos + **veredito de comprovante** (subagente). Casa o boleto (**`getBoletoEmitido` primeiro**, Sienge/SGL fallback), valida pelo **valor do boleto**, marca `boletos_emitidos.status` + `chat_conversations.receipt_validation`. Por fim chama `ai-responder`. |
| **`ai-responder`** | webhook/process-media | Cérebro do bot: seleciona agente (**regra 24h**), monta contexto (boletos de `vw_boleto_chat`, atributos, subagentes de texto), **function calling** (2ª via, agendamento, `api_call`, atualizar conversa), escalação `ESCALAR_HUMANO`. Envia a resposta. |
| **`send-message`** | App | Envio de mensagem livre/manual pelo atendente. |
| **`cobranca-regua`** | Cron | Régua Sienge: lê `vw_cobranca_boletos`, dispara template por offset de vencimento; loga em `cobranca_regua_log`. |
| **`dispatch-campaign`** | App/cron | Processa `chat_campaign_recipients` e dispara templates. |
| **`sgl-dispatch`** | Cron | Poller da cobrança legada SGL (`mensagens_cobranca`). |
| **`import-boletos`** | (legado n8n) | Recebia boletos extraídos do Drive. **Substituído** por `/api/boletos/import`. Mantido como fallback. |
| **`sienge-webhook`** | Sienge (push) | `RECEIPT_PROCESSED`/`UPDATE_…` → marca `sienge_boletos.status='pago'` + `paid_at`; auditoria em `sienge_webhook_events`. Protegido por `SIENGE_WEBHOOK_TOKEN`. |
| **`test-api-call`** | App (`/apis`) | Testa uma `chat_api_configs` (usa `_shared/apiExec.ts`). |
| **`auto-return-bot`** | Cron (horário, min 15) | Devolve ao bot conversas em que o atendente assumiu e deixou o cliente esperando entre **4h e 22h** (dentro da janela da Meta) → flip `handled_by='bot'` + invoca `ai-responder` (responde ou re-escala). Evita conversa abandonada morrer em silêncio. |
| **`analyze-comprovante`**, **`send-reminders`**, **`list-models`** | App/cron | Utilitários de apoio. |

**Compartilhados (`_shared/`):**
- `whatsapp.ts` — `normalizeWaId()`, `sendTemplateMessage()`, `ensureConversation()`, `buildTemplateComponents()`, `resolveVariables()`, `COBRANCA_AGENT_ID`.
- `apiExec.ts` — `executeApiConfig(cfg, {variables, contact})`: resolve `{{variables.X}}`/`{{env.X}}`/`{{contact.X}}`, auth, monta request, faz fetch. Reusado pelo `ai-responder` (tool `api_call`) e por `test-api-call`.

---

## 8. Fluxos principais

### 8.1 Recebimento de mensagem
```
Meta → whatsapp-webhook (dedup, upsert, salva msg)
   ├─ mídia  → process-media (Storage + análise/comprovante) → ai-responder
   └─ texto  → ai-responder
ai-responder → seleciona agente → monta contexto → (tools) → envia resposta via Graph API
```

### 8.2 Roteamento de agente (regra das 24h)
No `ai-responder`: se existe um **template `out` nas últimas 24h** na conversa → é "janela de
campanha/cobrança" → **agente default (Vivi)**. Caso contrário (mensagem avulsa) → regra de inbox
(**Contato Inteligente**) → fallback default. Esse mesmo sinal (`recentTpl`) define o **gate de
identidade** (ver §8.3).

### 8.3 Boletos (fluxo completo)
1. **Upload (substitui Drive/n8n):** financeiro arrasta o **ZIP** do lote em **`/boletos`** →
   `POST /api/boletos/import` (Node): `jszip` descompacta → **`pdf-parse@1.1.1`** (mesma lib do n8n) +
   **regexes idênticos** extraem `clientId` (do nome `"{clientId} - {nome} - {lote}.pdf"`),
   linha digitável (`/104-0[\d.\-\s]+\d/`), vencimento, valor, nosso número → sobe o **PDF** no bucket
   `boletos` → upsert `boletos_emitidos` (`pdf_path`). Mostra resumo + falhas.
2. **Bot envia o boleto:** `ai-responder` carrega de **`vw_boleto_chat`** (banco). 2ª via =
   **linha digitável (texto) + PDF (signed URL do Storage)** via `enviarBoletoPDF`. **Sienge só fallback.**
   Não lista parcelas futuras; **antecipação → `ESCALAR_HUMANO`**.
3. **Identidade:** com template recente (partiu de nós) o cliente já é conhecido; **avulso** → o bot
   exige **nome completo + CPF** e confere com o cadastro (oculto no prompt) antes de enviar.
4. **Central:** `/clients/[phone]` mostra os boletos (de `vw_boletos_central`) com **Abrir PDF**
   (`/api/boletos/pdf` → signed URL) e **Encaminhar na conversa** (`/api/boletos/forward` → checa
   janela de 24h; fechada → só avisa que precisa de template).

### 8.4 Comprovante (validação)
1. Cliente envia imagem/PDF → `process-media` extrai campos + roda o **subagente** ("Analisador de
   Comprovantes") que dá o **veredito** (`100% / 80% / 50% / negado`).
2. Boleto é casado por **`getBoletoEmitido`** (valor REAL do boleto → acaba a divergência falsa);
   pagador casado de forma **tolerante** (nome parcial).
3. `boletos_emitidos.status='comprovante_recebido'`; se o veredito **não** for "100% válido",
   `chat_conversations.receipt_validation=true` → **tag/filtro "Validação de comprovante"** na lista.
4. O **pago** definitivo só vem do **webhook Sienge** (baixa real) — não do comprovante.

### 8.5 Cobrança proativa
- **Régua Sienge** (`cobranca-regua` + `cobranca_regua`/`_step`): dispara templates por offset de
  vencimento, lendo `vw_cobranca_boletos` (valor do boleto + linha digitável).
- **Campanhas** (`/campaigns` → `chat_campaigns`/`_recipients` → `dispatch-campaign`): audiência de
  `vw_clientes_boletos` (valor do boleto).
- **SGL** (`sgl-dispatch`): cobrança legada via `mensagens_cobranca` (link direto).
- Disparos abrem a thread com `agent_id = Vivi` (roteamento por origem).

### 8.6 Webhook de baixa Sienge
`sienge-webhook` recebe push (sem cota), valida `SIENGE_WEBHOOK_TOKEN`, marca
`sienge_boletos.status='pago'`+`paid_at`, audita em `sienge_webhook_events`. As views de cobrança
passam a excluir o boleto; a Central reflete "PAGO".

---

## 9. Bots, subagentes, tools

### 9.1 Tools de function-calling (`ai-responder`)
- `enviar_segunda_via_boleto` — envia o boleto escolhido (por `vencimento_id` ou IDs Sienge); banco
  primeiro, Sienge fallback.
- `calcular_datas_pagamento` / `confirmar_agendamento` — agendamento (`payment_scheduler`).
- `atualizar_conversa` — grava campos (`chat_conversation_update_defs`), ex.: CSAT.
- **`api_call`** (genérica) — chama qualquer `chat_api_configs` (Sienge: quitação, extrato, endereço…).
- Escalação: o modelo emite `ESCALAR_HUMANO: <motivo>` → conversa vira `pending_human`.

### 9.2 Subagentes (`chat_subagents`)
Por gatilho: `image`/`document` (comprovante — extração + veredito), `audio` (Whisper + interpretação),
`text` (consultam a base e injetam contexto). Cada um tem `instructions`, `output_format`, `model` e
**datasources** (consulta/escrita com `value_map`).

### 9.3 Captura de atributos
`chat_contact_attribute_defs` define campos (CPF, e-mail…). `action='save_and_lookup_sienge'` dispara
o lookup do cliente no Sienge e persiste `sienge_customer_id`.

---

## 10. Frontend (rotas-chave)

| Rota | Função |
|---|---|
| `/conversations` (+ `/[id]`) | Caixa de entrada + chat realtime. Filtros (Status multi, Atendimento) + tags "Aguarda atendente" / "Validação de comprovante". |
| `/clients` (+ `/[phone]`) | Central de Clientes (lista 360 + detalhe: Boletos, Resumo de parcelas, Histórico de cobrança, Comprovantes, Conversa). |
| `/boletos` | Upload do ZIP de boletos (substitui o Drive). |
| `/campaigns` (+ `/new`, `/[id]`) | Campanhas de disparo. |
| `/regua` | Régua de cobrança. |
| `/agents` (+ `/[id]`) | Editor de agentes/subagentes/tools. |
| `/apis` (+ `/[id]`) | Construtor de integrações (`chat_api_configs`). |
| `/templates` | Templates WhatsApp (sync com a Meta). |
| `/inboxes`, `/integrations`, `/calendar`, `/settings/attendants` | Configurações. |

**API routes** (BFF, server-side com service role): `boletos/{confirm,import,pdf,forward}`,
`campaigns/*`, `regua/*`, `templates`, `send-template`, `send-media`, `attendants`.

**Auth/role:** páginas admin/manager protegidas no `layout.tsx` (redirect). `GET /api/templates`
liberado a qualquer atendente (para enviar template na conversa); criar/sync/excluir = admin/manager.

---

## 11. Convenções & padrões

- **Telefone:** sempre normalizar com `normalizeWaId()` (`_shared/whatsapp.ts`) — DDI 55, remove "0" de
  tronco, adiciona "9" de celular. Aplicado no envio E no recebimento (evita conversas duplicadas).
- **Boleto = `boletos_emitidos`.** Sienge é fallback. Valor sempre do boleto (com juros), nunca da parcela.
- **Storage:** `chat-media` (público, mídia do chat) e `boletos` (privado, PDFs — acesso só por signed URL server-side).
- **Pago** só via webhook Sienge (baixa real) ou confirmação manual (`ConfirmPaymentButton`).
- **RLS:** route handlers usam **service role** (server-side); o client do browser usa anon + RLS.
- **Migrations** numeradas e idempotentes (`IF NOT EXISTS`, `CREATE OR REPLACE`).

---

## 12. Como rodar localmente

```bash
npm install
# .env.local com NEXT_PUBLIC_SUPABASE_URL / ANON_KEY / SUPABASE_SERVICE_ROLE_KEY
npm run dev        # http://localhost:3000
npx tsc --noEmit   # type-check
```

---

## 13. Como deployar

- **App (Next):** merge na `main` → **Vercel** faz deploy automático. Inclui páginas e `app/api/*`.
- **Edge Functions:** manual —
  `npx supabase functions deploy <nome> --project-ref jpxlczmbxfcnujemlxzq`.
- **Migrations:** aplicar no Supabase (MCP `apply_migration` ou painel/CLI). **Não** sobem no merge.
- **PR + merge autônomo:** via API do GitHub usando o token do Keychain
  (`git credential fill` → `POST /pulls` → `PUT /pulls/{n}/merge` `squash`). `gh` CLI não está instalado.

---

## 14. Segurança

- Webhooks protegidos por token (`SIENGE_WEBHOOK_TOKEN`).
- Service role **nunca** exposto ao client (só em route handlers / edge).
- Ver `docs/SEGURANCA.md` (inclui pendência de rotação de senha vazada — issue de segurança).

---

## 15. Changelog de decisões

> Adicione novas entradas no topo, com data.

- **2026-06-18 — Link público do boleto (`boleto-link`) + na mensagem da régua.**
  - `boletos_emitidos.public_token` (uuid aleatório, migration 050) + edge **pública** `boleto-link?t=<token>` (`--no-verify-jwt`): gera signed URL fresca do PDF e redireciona (302); sem PDF, página HTML com linha digitável + valor + vencimento. URL base = Supabase (estável, não depende do domínio Vercel). Link abre sem login e funciona dias depois. Validado: token válido → PDF, inválido → 404 amigável.
  - **Na mensagem (migration 051):** a coluna `link_boleto` (já mapeada na variável `{{Boleto}}` da régua/campanha, rótulo "Link do boleto") passou a conter a **URL do link** em vez da linha digitável — em `vw_cobranca_boletos` e `vw_clientes_boletos`. Logo, todo disparo da régua/campanha já manda o link clicável, **sem mudar template nem mapeamento**. SGL mantém seu próprio `linkboleto`. (security_invoker=true preservado nas duas.) A linha digitável segue disponível em `boletos_emitidos.linha_digitavel` e na 2ª via sob demanda do bot.
- **2026-06-18 — Validador de comprovante: apelidos de empreendimento.**
  - A SPE no boleto difere do nome comercial: "LOTEAMENTO JARDIM PAULO FREIRE SPE LTDA" == "Jardim dos Ypes"/"Jardim dos Ipês". O validador tratava como divergência → validação manual.
  - `sienge_empreendimentos.apelidos` (migration 049); `getEmpreendimentosTexto` (process-media) inclui "(também conhecido como: …)" na lista de referência. **Instruções dos 2 subagentes** validadores (`chat_subagents`, ids `fd4101fe…`/`22e4dc8a…`) ganharam OBS: nomes "também conhecido como" são o MESMO empreendimento — não rebaixar o veredito por isso. Para novos apelidos, basta preencher `apelidos` no empreendimento.
- **2026-06-18 — Validação geral + fix security_invoker das views.**
  - Advisor apontou 3 ERROS `security_definer_view`: `vw_central_clientes` e `vw_boletos_central` foram regredidas para DEFINER pelas recriações 045–047 (CREATE OR REPLACE sem `WITH (security_invoker=true)`); `vw_clientes_boletos` já era DEFINER desde 032. Migration **048** religa `security_invoker=true` nas três (seguro: nenhuma tabela-base sem policy). Lição: ao recriar uma view, **repetir a cláusula `WITH (security_invoker=true)`**.
  - Saúde OK: todas as edges 200 nas últimas horas; 6 crons ativos; views respondendo; tsc limpo. Backlog de segurança pré-existente segue (leaked-password protection, upgrade Postgres, tabelas legadas sem policy) — ver `docs/SEGURANCA.md`.
- **2026-06-18 — Empreendimento correto POR BOLETO (não pelo contrato do cliente).**
  - O empreendimento era derivado do contrato do cliente — errado quando o cliente tem mais de uma unidade/empreendimento (ou o contrato do boleto não está sincronizado). Caso: Paulo (client 1) contrato "Por do Sol", mas o boleto é "Jardim das Palmeiras"; a mensagem da régua saiu com "Por do Sol".
  - `boletos_emitidos.empreendimento` (migration 047); o import grava o **Beneficiário lido do PDF** (regex `… SPE LTDA` + fallback rótulo). Views `vw_cobranca_boletos`, `vw_boletos_central`, `vw_clientes_boletos`, `vw_central_clientes` passam a usar `COALESCE(boleto, contrato, parcela)`. **Sem backfill** (só daqui pra frente; boletos antigos seguem no fallback do contrato até serem recarregados).
  - **Régua/2ª via** (`vw_cobranca_boletos`, boleto-driven) já mostra o empreendimento certo por boleto. **Limitação**: a coluna da lista da Central (via `vw_clientes_boletos`, guiada por `sienge_boletos`) mostra 1 empreendimento por cliente — para clientes multi-empreendimento, o da parcela mais próxima.
- **2026-06-18 — Central: coluna Empreendimento na tabela de clientes.**
  - `vw_central_clientes` (migration 046) expõe `empreendimento` (`vw_cliente_contrato.enterprise_name`, join já existente). Coluna adicionada na tabela `/clients` entre Contrato e Plataforma.
- **2026-06-18 — Central de Clientes: lista em tabela profissional.**
  - `/clients` reescrita como **tabela** (`ClientsClient.tsx`): Nome (+CPF) · Telefone · E-mail · Contrato · Plataforma · Boleto mensal · Conversa. Linha clicável → ficha. Busca (nome/e-mail/CPF/tel) + filtros (Sienge/SGL/Ambos/Conversa/Vencido/Pago/Cancelado).
  - `vw_central_clientes` (migration 045) ganhou 3 colunas: `email` (coluna nova em `sienge_clientes`, **nula por ora — sync do Sienge é pendência**), `contrato_situacao` (de `vw_cliente_contrato.situation`: Emitido→"Ativo", Cancelado, etc.), `boleto_status` (`pago`>`vencido`>`enviado`>`a_enviar`>`sem_boleto`). O `boleto_status` considera `boletos_emitidos` em aberto além do `vw_clientes_boletos` (pega cliente novo/avulso sem parcela em `sienge_boletos`, ex.: Daniele → "enviado").
- **2026-06-17 — Import de boleto avulso: fallback por título.**
  - `app/api/boletos/import/route.ts` (formato B `{nome}_{título}_{parcela}_{data}`): além de resolver o cliente por NOME em `sienge_clientes`, agora cai no **título** (`sienge_contratos.receivable_bill_id → client_id`) quando o nome não resolve (cliente novo cujo cadastro ainda não sincronizou, ou nome ambíguo). Validado: `receivable_bill_id` é único por cliente; caso Daniele (título 216 → 13060). Complementa o fix do webhook `CUSTOMER_CREATED`.
- **2026-06-17 — Central: "Réguas inscritas" + próximo disparo na ficha do cliente.**
  - Card "Histórico de cobrança" ganhou a seção **Réguas inscritas**: lista as réguas ativas em que o cliente se enquadra (check verde) + **próximo disparo** (1 data/hora). Inscrição = mesma audiência da edge `cobranca-regua` (cliente em `vw_cobranca_boletos` batendo o `audience_filter`).
  - Helper `lib/regua/schedule.ts` (server): `matchAudiencia()` + `proximoDisparo()` espelham a lógica da edge — carga via `load_dispatch_date`, offset = **venc + offset_days** (offset −3 = 3 dias antes), regra de dia útil (sáb/dom → segunda), pula passos já no log e datas passadas; carga pendente de hoje conta como iminente. Formata a data pelos getters locais (números BRT) p/ não deslocar fuso em prod (UTC). Computado em `app/clients/[phone]/page.tsx` (sem migration).
- **2026-06-16 — Fix: webhook CUSTOMER_CREATED gravava cliente-fantasma (nome/telefone nulos).**
  - Estávamos **recebendo** os `CUSTOMER_CREATED` (hook `ffe111bb`) e o handler buscava `GET /customers/{id}`, mas no instante da criação o cliente às vezes ainda não está consultável (GET volta vazio) → fazia upsert de um registro com **nome/telefone nulos** e reportava "cliente upsert" (sucesso enganoso). Resultado: import de boleto avulso (resolve por nome) falhava com "cliente não encontrado" até o sync diário reconciliar. Caso real: cliente 13060 (Daniele).
  - `sienge-webhook` (`handleCadastro`, ramo cliente): agora **tenta o GET até 3x com backoff de 1,5s**; se ainda não houver dados, **não grava nulos por cima** (não cria stub) e registra honestamente na auditoria (`note: cadastro Sienge indisponível … aguardando reconciliação`). Cobre `customer_created` e `customer_updated`.
- **2026-06-12 — Fix: JSON de `status_cobranca` vazava para o cliente.**
  - O modelo às vezes emitia os campos de atualização de conversa como TEXTO (ex.: `{"status_cobranca":"comprovante_confirmado"}`) em vez de chamar a tool `atualizar_conversa` — e esse JSON ia junto na mensagem do WhatsApp (3 conversas afetadas; clientes leram). O `stripInternalTokens` só pegava `identificador_snake { … }`, não um JSON puro `{ … }`.
  - `ai-responder` ganhou `stripInternalJson`: detecta objeto `{…}` contendo chave interna conhecida (keys de `chat_conversation_update_defs` + `status`/`cw_status`), **aplica a intenção** via `handleAtualizarConversa` e **remove o bloco** antes de enviar. Salvaguarda: se a resposta ficar vazia após a limpeza, não envia balão vazio.
- **2026-06-11 — Campanhas: editar, excluir + histórico por cliente.**
  - **Editar** (`/campaigns/[id]/edit`): reusa o `CampaignWizard` pré-preenchido (nome/inbox/template/mapping/agendamento/filtro). Persiste via `PATCH /api/campaigns/[id]` — nome sempre; config só em draft/scheduled/paused. Botão "Editar" no detalhe aparece só nesses status. Audience route passou a aceitar `scheduled` também.
  - **Excluir = SOFT-DELETE** (`chat_campaigns.deleted_at`, migration 044): `DELETE /api/campaigns/[id]`. Some da lista/detalhe (filtro `deleted_at is null`) e o `dispatch-campaign` ignora excluídas (para uma campanha em andamento). **Não é hard-delete** de propósito: preserva o nome p/ o histórico do cliente.
  - **Histórico por cliente** (Central, seção "Campanhas recebidas"): view `vw_campanhas_cliente` (migration 044) = `chat_messages` com `metadata.campaign_id` → conversa → contato, join campanha+template. Mostra nome da campanha, data/hora, status (sent/delivered/read) e a **mensagem real enviada**. Robusto: ancorado no contato pela conversa (o `wa_id` em `chat_campaign_recipients` tem inconsistência de normalização — trunk 0/9º dígito — então NÃO serve de chave).
- **2026-06-11 — Excluir lote de boletos (admin/manager).**
  - `/boletos`: lixeira na linha do lote (visível só p/ admin/manager) → `DELETE /api/boletos/lotes/[id]` (valida o role de novo no servidor; agent recebe 403). Apaga os PDFs do bucket `boletos`, os `boletos_emitidos` do lote e o registro em `boleto_lotes`. Desfaz carregamento errado; re-upload do ZIP recria tudo (upsert idempotente). A baixa de pagamento vive em `sienge_boletos`, então excluir o boleto emitido não apaga histórico de pagamento.
- **2026-06-11 — Aviso de carga tardia no editor da régua.**
  - Ao ligar "Disparar no dia do carregamento", se já passou das **18h** (BRT) ou é **fim de semana**, o editor mostra um aviso âmbar dizendo que as cargas de agora não saem hoje e em que dia útil sairão (`avisoCargaTardia()` em `ReguaClient.tsx`, espelha `load_dispatch_date`). Só UI — a regra de data já estava na view; isto dá visibilidade (explica o "0 disparos hoje" quando a carga foi depois das 18h).
- **2026-06-11 — Regra legal de dias úteis (régua + SGL) + janela 18h na carga.**
  - **Nenhuma cobrança automática sai em sábado/domingo.** `cobranca-regua` pula o run no fim de semana (`force=true` é o único override) e, na **segunda**, os passos de offset cobrem também os alvos que cairiam no sábado e no domingo (`.in('due_date', targetDues)`; a UNIQUE do log deduplica). `sgl-dispatch` idem: segura a fila no fim de semana (registros acumulam em `app_dispatched_at IS NULL`) e a segunda processa.
  - **Disparo de carregamento com janela de 18h:** `vw_cobranca_boletos.load_dispatch_date` (migration 043) = carregado até 18h BRT → mesmo dia; após 18h → dia seguinte; sáb/dom → segunda. O passo `on_load` passou a usar essa coluna.
  - **SGL classifica pela data de ENTRADA** (`created_at` BRT), não pela de processamento — sem isso, um registro de sábado (`vencida_3_dias`) processado na segunda viraria `vencida_5_dias` → sem mapa em `sgl_regua_map` → cobrança silenciosamente descartada.
  - Preview da régua espelha as regras (fim de semana → "postergado para segunda").
- **2026-06-11 — Régua: disparo "no dia do carregamento".**
  - Flag na régua (`/regua`): liga um passo especial (sempre o **Disparo 1**, sem o campo "Dias do vencimento") que cobra o cliente **no mesmo dia em que o boleto entra no sistema** (upload do ZIP ou captura via `sienge-webhook`).
  - Schema: `cobranca_regua_step.on_load` (migration 042) + `vw_cobranca_boletos.loaded_date` (data BRT de `boletos_emitidos.created_at`; upsert não muda `created_at` → re-upload não redispara).
  - Edge `cobranca-regua`: passo `on_load` mira `loaded_date = hoje` e o horário é "**a partir de**" — cron horário roda o passo em toda passada com hora >= `send_time` (boleto que entra à tarde dispara no mesmo dia), e a UNIQUE do log deduplica 1 envio por boleto (`offset_days=999` é sentinela desses passos).
  - API `POST/PATCH /api/regua` + `preview` aceitam `onLoad`; preview mostra "N boleto(s) carregado(s) hoje".
- **2026-06-11 — Captura automática do boleto Sienge (`PAYMENT_SLIP_REGISTERED`).**
  - `sienge-webhook` ganhou `handlePaymentSlip`: ao receber o evento de boleto/carnê registrado (gated SÓ pelo header `x-sienge-event`, p/ não colidir com `RECEIPT_PROCESSED`), resolve `client_id`+`vencimento`+`valor` (`sienge_boletos` → fallback Sienge 1x) → busca a 2ª via (`fetchSegundaVia`, novo helper em `_shared/sienge.ts`: `payment-slip-notification` → `urlReport`+`digitableNumber`) → baixa o PDF → bucket `boletos` (`{client_id}/{venc}.pdf`) → **upsert idempotente** em `boletos_emitidos` `(client_id,vencimento)` com `lote='sienge-webhook'`, preservando status se já `pago/cancelado`. Convive com o ZIP (o que chegar por último vence). Boletos que não vêm no ZIP entram sozinhos, com PDF + linha digitável. **Sem migration.**
  - **Hook registrado via API** (`POST /hooks`, id `560c92b8`) usando edge function one-off (credenciais Sienge são secrets do edge; função apagada após o uso). **Validado end-to-end** com simulação de título real (bill 141/inst 1 → boleto capturado com PDF + linha digitável). Título sem cobrança registrada → Sienge 422 "cobrança não existente" (esperado; no fluxo real o evento só dispara quando o slip existe). Shape do payload real será confirmado no 1º evento via `sienge_webhook_events`.
  - Tabela `sienge_contratos` (migration 039) + view `vw_cliente_contrato`; edge `sienge-sync-contratos` (pagina `GET /sales-contracts`, 133). Traz empreendimento + unidade (Quadra/Lote) + vínculo cliente/título.
  - Views de boleto (`vw_boletos_central`, `vw_cobranca_boletos`) repontadas: empreendimento/quadra/lote agora vêm do **contrato** (fallback `sienge_boletos`), parseando "Quadra X / Lote Y" — migration 040. Clientes novos já mostram unidade.
  - **Webhooks de cadastro**: `sienge-webhook` passou a rotear `customer_*` e `sales_contract_*` (push, tempo real) → upsert em `sienge_clientes`/`sienge_contratos`. Sync completo virou **mensal** (migration 041) só como reconciliação. Helpers em `_shared/sienge.ts`.
- **2026-06-11 — Sync de clientes direto do Sienge + ZIP formato novo.**
  - Edge `sienge-sync-clientes` (cron diário 05:00 BRT): pagina `GET /customers` e faz upsert do CADASTRO completo em `sienge_clientes` (111 → **1.226** clientes) + backfill de telefone nos boletos emitidos. Substitui o caminho do n8n que derivava clientes das parcelas — com boleto vindo do ZIP e baixa via webhook, só o cadastro importa.
  - Import do ZIP aceita **2 formatos** de nome: `"{clientId} - {nome} - {lote}"` (lote CAIXA) e `"{nome}_{título}_{parcela}_{ddmmaaaa}"` (avulso — resolve o cliente pelo NOME no cadastro; vencimento do filename como fallback; linha digitável com fallback genérico de 47 dígitos além do layout CAIXA).
- **2026-06-09 — Ordem de busca de boleto: emitido → SGL → Sienge.**
  - O bot procurava Sienge antes do SGL; cliente em ambas as bases (parcelas Sienge futuras sem boleto gerado) travava na 2ª via Sienge e nunca chegava ao SGL (que tinha o link real). Reordenado: `loadSglBoletos` é tentado antes das parcelas `sienge_boletos`. SGL deduplicado por parcela.
- **2026-06-09 — Webhook Sienge propaga baixa para `boletos_emitidos` + fallback.**
  - `sienge-webhook`: além de `sienge_boletos`, agora marca também o `boletos_emitidos` correspondente (casa por `client_id`+`vencimento`) como pago/cancelado — fecha o gap entre as duas bases. Backfill dos já pagos.
  - Fallback: se o recebimento não casar nenhum boleto (título não sincronizado), busca o título no Sienge **1x** (cota), grava em `sienge_boletos` como pago e propaga. Só quando `matched=0`.
- **2026-06-09 — Comprovante SGL marca a parcela + sai da régua.**
  - `process-media`: comprovante de cliente SGL agora atualiza `mensagens_cobranca.status='comprovante_recebido'` (casa a parcela por **vencimento → valor**), aparecendo como "Comprovante" no painel/Central.
  - `sgl-dispatch`: pula novas cobranças de parcela que já tem comprovante/baixa (chave telefone+parcela) — parcela paga sai da régua; outras parcelas em aberto seguem normais.
- **2026-06-09 — Boletos organizados em lotes.**
  - Tabela `boleto_lotes` (data, usuário, arquivo, contagens, valor total) + `boletos_emitidos.upload_id` (migration 037). `/api/boletos/import` registra um lote por upload; a tela `/boletos` lista lotes que expandem para os boletos. Backfill dos boletos existentes.
- **2026-06-09 — Debounce do bot ("espera, junta e responde").**
  - `ai-responder` espera 8s e, se chegou mensagem nova do cliente (contagem de `in`), aborta — só a última invocação responde, lendo o histórico inteiro. Acaba a resposta múltipla a mensagens em sequência. Também re-checa `handled_by` pós-espera.
- **2026-06-09 — Troca de senha obrigatória no 1º acesso.**
  - Criar usuário e resetar senha marcam `must_change_password` no metadata do Auth.
  - `middleware.ts` redireciona para **`/change-password`** enquanto a flag estiver ligada; a tela define a senha e limpa a flag.
- **2026-06-09 — Usuários: excluir + resetar senha.**
  - Excluir = soft-delete (`chat_attendants.deleted_at`, migration 036) + revoga login no Auth; preserva histórico. Se há conversas abertas, pede **transferir** (mesma equipe) ou **arquivar**.
  - Resetar senha gera senha forte e exibe uma vez. `DELETE`/`PATCH(action)` em `app/api/attendants`.
- **2026-06-09 — Segurança + resiliência (auditoria sênior).**
  - `chat-media` virou **bucket privado**; mídia/comprovantes servidos por proxy autenticado `/api/media` (signed URL); Meta/OpenAI recebem signed URLs direto.
  - **`auto-return-bot`** (cron horário): conversa com humano que deixou o cliente esperando 4–22h volta ao bot, que responde/re-escala.
- **2026-06-09 — Boletos: banco como fonte de verdade + Central reformulada.**
  - Upload do ZIP no sistema (`/boletos` + `/api/boletos/import`, `pdf-parse@1.1.1`) — fim do Drive/n8n. Bucket `boletos`.
  - Views `vw_boleto_chat`, `vw_boletos_central`, `vw_comprovantes`; `vw_clientes_boletos` passou a usar o valor do boleto (fix do disparo de campanha que saía com valor da parcela).
  - Bot envia 2ª via do banco (PDF + linha digitável); validação de comprovante pelo valor do boleto; gate de identidade (avulso pede nome+CPF); antecipação → escalar.
  - Conversas: filtros em dropdown (Status multi) + tag/filtro "Validação de comprovante" (`receipt_validation`).
  - Central: Boletos (Abrir PDF + Encaminhar c/ checagem de janela 24h) × Resumo de parcelas + Histórico de comprovantes.
  - `GET /api/templates` liberado a atendentes.
- **Anteriores:** núcleo do chat, campanhas, régua multi-step, SGL dispatch + cutover, boletos emitidos + régua Sienge, Central de Clientes, subagent ops, tool `api_call` + agente Contato Inteligente, roteamento por origem, webhook Sienge.

---

## 16. Backlog / pendências

- Fase 2 do Contato Inteligente: 2ª via para não-cliente, **Lead no CVCRM**, CNPJ na quitação.
- Boleto PDF em **template de mídia** (campanha proativa com anexo — requer aprovação Meta).
- Sincronizar **baixa Sienge → `boletos_emitidos`** (hoje o webhook marca só `sienge_boletos`).
- Confiabilidade da extração de comprovante (valor/cpf às vezes "não especificado").
- Desativar workflows antigos do n8n; rotacionar senha vazada (segurança).
- Issues abertas: #3–#10 (ver `docs/ROADMAP.md`).
