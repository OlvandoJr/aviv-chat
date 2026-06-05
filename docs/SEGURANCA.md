# Runbook de Segurança — aviv-chat

Última revisão: 2026-06-05

Este documento registra a postura de segurança do sistema, as ações pendentes que
exigem acesso a painéis externos, e notas operacionais dos fluxos de cobrança.

---

## 1. Estado atual (verificado)

- **Advisor de segurança do Supabase: 0 erros.**
- **RLS ativo** em todas as tabelas de dados, incluindo as novas de cobrança
  (`chat_campaigns`, `chat_campaign_recipients`, `cobranca_regua`,
  `cobranca_regua_step`, `cobranca_regua_log`, `sgl_regua_map`). Sem acesso anônimo.
- **Storage `chat-media`**: políticas apenas para `authenticated` (boletos/comprovantes
  não acessíveis sem login).
- **Webhooks de cobrança SGL**: enviados pelo nosso sistema, sem duplo-envio (ver §4).

### WARNs aceitos (não são vulnerabilidade)
- `rls_policy_always_true`: por design. É uma ferramenta interna — todo atendente
  autenticado enxerga os dados; anon não enxerga nada. Mesmo padrão das tabelas legadas.
- `anon_security_definer_function_executable`: funções de **outra feature** (landing de
  evento `expoamoreira_2025`), não da cobrança.
- `extension_in_public` (`vector`, `pg_net`): best-practice, risco baixo.

---

## 2. Ações pendentes — exigem painel externo (somente o responsável pode fazer)

### 2.1 Rotacionar a senha do Sienge  ⚠️ prioridade
- **Onde:** painel do Sienge → usuário de API → trocar senha.
- **Por quê:** a senha antiga ficou no histórico do git
  (`scripts/registrar_webhooks_sienge.sh`, antes da correção que passou a usar variáveis
  de ambiente). Enquanto não rotacionar, está exposta no histórico.
- **Depois:** atualizar o secret `SIENGE_PASSWORD` em
  Supabase → Edge Functions → Secrets (usado por `ai-responder` / `process-media`).

### 2.2 Ativar proteção de senha vazada
- **Onde:** Supabase Dashboard → Authentication → Policies (ou Providers → Password) →
  ligar **"Leaked password protection"**.
- **Por quê:** advisor `auth_leaked_password_protection`. Bloqueia senhas presentes em
  vazamentos conhecidos.

### 2.3 Atualizar versão do Postgres
- **Onde:** Supabase Dashboard → Settings → Infrastructure → Upgrade Postgres.
- **Por quê:** advisor `vulnerable_postgres_version` (patches de segurança). Fazer em
  horário de baixo movimento (downtime curto).

---

## 3. Credenciais e segredos — onde ficam

| Segredo | Local | Sensível? |
|---|---|---|
| Token Meta / WhatsApp | `chat_inboxes.access_token` (DB) | **Sim** — texto puro (lido só via service role). |
| `SIENGE_USER` / `SIENGE_PASSWORD` | Supabase Edge Functions → Secrets | Sim |
| `OPENAI_API_KEY` | Edge Functions → Secrets | Sim |
| Service role key | Ambiente das Edge Functions (injetado pelo Supabase) | Sim — nunca exposto no cron. |
| Anon key (Vault: `edge_cron_key`) | `vault.secrets` | **Não** — chave pública. Usada pelo cron só p/ `verify_jwt`. |
| URL base (Vault: `edge_base_url`) | `vault.secrets` | Não |

- **Nunca** commitar credenciais. Scripts usam variáveis de ambiente.
- Os crons (pg_cron) chamam as funções com a **anon key pública**; a inteligência de
  service role fica dentro da função (env injetado). Nenhum segredo no `cron.job`.

---

## 4. Operação dos fluxos de cobrança (referência)

### Crons ativos (`cron.job`)
| Job | Agenda | Função |
|---|---|---|
| `dispatch-campaign-5min` | a cada 5 min | campanhas em massa (agendadas / retomada) |
| `cobranca-regua-hourly` | de hora em hora | régua Sienge (cada passo dispara na sua hora) |
| `sgl-dispatch-5min` | a cada 5 min | cobrança SGL orientada a evento |

### SGL (event-driven) — como funciona
- O SGL roda a régua **dele** e, para cada cliente **em aberto**, dispara um webhook ao
  n8n. O n8n permanece **só como ponte**: recebe → parseia → grava em `mensagens_cobranca`.
  **Os nós de envio do n8n foram desativados.**
- `sgl-dispatch` (poller, 5 min) lê registros novos (`app_dispatched_at IS NULL`),
  classifica pelo vencimento, escolhe o template via `sgl_regua_map` e envia pelo núcleo
  (`ensureConversation` + `sendTemplateMessage`). Herda do SGL a inteligência de quem pagou.
- **Idempotência:** `app_dispatched_at` marca o registro como tratado.
- **Robustez:** em falha **síncrona** da Meta (429/401/5xx), não marca — incrementa
  `app_dispatch_attempts` e tenta de novo no próximo ciclo; após 5 tentativas desiste e
  grava `app_dispatch_error` (não loopa).

### ⚠️ Baseline — cuidado operacional crítico
`mensagens_cobranca` tem milhares de registros históricos. Antes de **ativar** o
`sgl-dispatch` (ou ao reativar após pausa), **sempre** rodar o baseline para não reenviar
o histórico:

```sql
UPDATE mensagens_cobranca SET app_dispatched_at = now() WHERE app_dispatched_at IS NULL;
```

Isso marca tudo que já existe como tratado; só registros inseridos **depois** são enviados.

### Sienge (régua-pull) — estado
- A régua Sienge (`cobranca_regua` + `cobranca-regua`) está **construída e pronta**, mas
  **sem regras ativas** → o cron roda e não envia nada. O envio Sienge ainda é feito pelos
  workflows n8n `Sienge 01/03/B`.
- Para migrar: configurar a régua na UI (`/regua`), validar via dry-run, e então desativar
  os workflows Sienge no n8n. **Não desativar antes da paridade** (evita lacuna).

---

## 5. Reativar / pausar o envio do nosso lado

- **Pausar SGL:** `SELECT cron.unschedule('sgl-dispatch-5min');`
- **Reativar SGL:** rodar o **baseline** (§4) e reagendar o cron (ver migration/handoff).
- **Pausar campanhas/régua:** `cron.unschedule('dispatch-campaign-5min' | 'cobranca-regua-hourly')`.
