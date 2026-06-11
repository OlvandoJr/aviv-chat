# HANDOFF — continuação do projeto aviv-chat

> Para a PRÓXIMA sessão. Leia **este arquivo** + **`docs/ARQUITETURA.md`** (visão completa + changelog
> datado) antes de mexer em qualquer coisa. Tudo abaixo está **no ar** salvo onde indicado.
> Última atualização: **2026-06-11**.

---

## 0. COMO OPERAR (crítico — uma sessão nova não sabe disso)

- **Working dir:** `/Users/macbookair/aviv-chat`. Repo: `github.com/OlvandoJr/aviv-chat`.
- **Supabase project ref:** `jpxlczmbxfcnujemlxzq` (use nos MCP tools e no CLI).
- **Deploy do app (Next):** automático no **merge para `main`** (Vercel). Páginas + `app/api/*`.
- **Edge Functions e migrations NÃO sobem no merge** — são manuais:
  - Edge: `npx --no-install supabase functions deploy <nome> --project-ref jpxlczmbxfcnujemlxzq`
    (+ `--no-verify-jwt` para as protegidas por token: `sienge-webhook`).
  - Migrations: MCP `apply_migration` / `execute_sql` (project_id acima). Sempre criar o arquivo
    em `supabase/migrations/NNN_*.sql` também (numeração sequencial; última é **041**).
- **PR + merge SOZINHO (gh NÃO está instalado):** reutilizar o token do Keychain:
  ```bash
  TOKEN=$(printf "protocol=https\nhost=github.com\n\n" | git credential fill 2>/dev/null | sed -n 's/^password=//p')
  REPO="OlvandoJr/aviv-chat"
  # cria branch de origin/main, commita, push -u; depois:
  api(){ curl -s -H "Authorization: token $TOKEN" -H "Accept: application/vnd.github+json" "$@"; }
  NUM=$(api -X POST "https://api.github.com/repos/$REPO/pulls" -d "$(jq -n '{title:"...",head:"<branch>",base:"main",body:"..."}')" | grep -m1 '"number":' | grep -o '[0-9]\+')
  api -X PUT "https://api.github.com/repos/$REPO/pulls/$NUM/merge" -d '{"merge_method":"squash"}'
  ```
  Padrão: branch novo de `origin/main` por feature → commit (Co-Authored-By: Claude Opus 4.8) →
  push → PR → **squash-merge** → `git checkout main && git pull`.
- **tsc:** `npx tsc --noEmit` (lado Next). Deno é validado pelo próprio deploy.
- **Credenciais Sienge** (`SIENGE_USER`/`SIENGE_PASSWORD`) são **secrets do edge**, NÃO estão no
  `.env.local`. Para chamar a API Sienge a partir daqui, use uma edge function com `dryRun` (padrão
  usado em `sienge-sync-clientes`/`sienge-sync-contratos`).
- `.env.local` tem `NEXT_PUBLIC_SUPABASE_URL/ANON_KEY` + `SUPABASE_SERVICE_ROLE_KEY` (uso em scripts/curl).
- **Memória do projeto:** há um ponteiro em `MEMORY.md` apontando para este handoff.

---

## 1. ARQUITETURA EM 1 PARÁGRAFO
Atendimento + cobrança WhatsApp da Aviv Construtora. Next 16 (App Router) + Supabase (DB/Auth/Storage/
Realtime) + Edge Functions (Deno) + OpenAI + Meta WhatsApp Cloud API + ERP **Sienge** (plano **Free** =
cota baixa) + legado **SGL**. Dois bots no mesmo número: **Vivi** (`ead82b93-84c8-49bf-98bb-53d395b49ba7`,
default, cobrança/comprovante/2ª via) e **Contato Inteligente** (`1f054c3f-97f0-4cee-9a1a-ceede21e9943`,
jornada). Detalhes completos em `docs/ARQUITETURA.md`.

## 2. PIPELINE DE BOLETOS / SIENGE (estado atual — TUDO no ar)
**Fonte de verdade do boleto = `boletos_emitidos`** (valor real c/ juros + linha digitável + PDF).
- **Boleto entra por:** upload de ZIP em `/boletos` → `app/api/boletos/import/route.ts` (Node;
  `jszip` + `pdf-parse@1.1.1` — MESMA lib/regex do n8n). Aceita **2 formatos de nome**:
  `"{clientId} - {nome} - {lote}.pdf"` e `"{nome}_{titulo}_{parcela}_{ddmmaaaa}.pdf"` (resolve cliente
  por NOME no `sienge_clientes`). Sobe PDF no bucket **privado `boletos`**; upsert idempotente
  `(client_id,vencimento)`. Lotes registrados em `boleto_lotes` (`upload_id` em cada boleto).
- **Baixa (pago) = webhook Sienge** `RECEIPT_PROCESSED` → `sienge-webhook` marca `sienge_boletos`
  **e** `boletos_emitidos` (propaga por client_id+vencimento) + **fallback** que busca o título 1x se
  não casar. `UPDATE_RECEIVABLE_BILL_SITUATION` também tratado.
- **Cadastro in-house (substitui o n8n "Sienge A"):**
  - `sienge-sync-clientes` (GET /customers, paginado) → `sienge_clientes` (telefone/CPF/nome; ~1.226).
  - `sienge-sync-contratos` (GET /sales-contracts) → `sienge_contratos` (empreendimento/unidade/título;
    133) + view `vw_cliente_contrato` (1/cliente).
  - **Atualização = PUSH por webhook** (`sienge-webhook` roteia `customer_*` e `sales_contract_*`);
    sync completo é só **MENSAL** (crons, migration 041). **Evento vem no HEADER `x-sienge-event`;
    o body traz só `{customerId:N}`/`{salesContractId:N}` (id).** Validado: CUSTOMER_UPDATED atualizou
    o cliente 1 (Paulo H. Sanches).
- **Views (qual usa o quê):** `vw_boleto_chat` (bot), `vw_cobranca_boletos` (régua), `vw_clientes_boletos`
  (campanhas), `vw_boletos_central` (Central), `vw_comprovantes`, `vw_cliente_contrato`. **Empreendimento/
  quadra/lote agora vêm do CONTRATO** (fallback `sienge_boletos`) — migration 040, parseia "Quadra X / Lote Y".
- **Ordem de busca de boleto no `ai-responder`: emitido → SGL → Sienge** (SGL tem link real; Sienge são
  só parcelas, 2ª via via API é fallback raro).

## 3. OUTROS PONTOS NO AR (recentes)
- **Bucket `chat-media` PRIVADO** + proxy autenticado `/api/media` (signed URL). Meta/OpenAI recebem
  signed URLs direto. `mediaSrc()` em `lib/utils.ts`.
- **Debounce do bot (8s)** no `ai-responder` (espera, junta e responde; conta msgs `in`).
- **`auto-return-bot`** (cron horário): conversa com humano que deixou cliente esperando **4–22h** volta
  ao bot.
- **Comprovante SGL** marca a parcela em `mensagens_cobranca` (casa por vencimento→valor) e o
  `sgl-dispatch` suprime cobrança de parcela com comprovante.
- **Usuários** (`/settings/attendants`): excluir (soft-delete + revoga login + transfere/arquiva
  conversas abertas), resetar senha, troca obrigatória no 1º acesso (middleware).
- **Conversas:** filtros em dropdown (Status multi) + tag/filtro **"Validação de comprovante"**
  (`chat_conversations.receipt_validation`).
- **Central de Clientes** (`/clients/[phone]`): Boletos (Abrir PDF + Encaminhar c/ checagem janela 24h),
  Resumo de parcelas, Histórico de cobrança, Comprovantes.

---

## 4. ⭐ PRÓXIMA TAREFA (o que o usuário pediu para começar)
**Capturar o boleto Sienge automaticamente, MANTENDO o upload manual do ZIP — os dois funcionam juntos.**

- Existe o evento Sienge **`PAYMENT_SLIP_REGISTERED`** (boleto/carnê registrado no banco). Hoje ele vai
  só pro n8n (hook `d4ff9cb7` → `bot-evo-n8n.../sienge-boleto-emitido`). Queremos **também** capturar.
- **Plano:** registrar `PAYMENT_SLIP_REGISTERED` apontando para a nossa `sienge-webhook` (mesma URL/token).
  No handler, ao receber o evento (provável payload `{billId, installmentId}` ou `{receivableBillId,...}`
  — **CONFIRMAR pelo header/auditoria no 1º evento**, como fizemos com os outros):
  1. Buscar a 2ª via no Sienge: `GET payment-slip-notification?billReceivableId={bill}&installmentId={inst}`
     → `urlReport` (PDF) + `digitableNumber` (linha digitável). (1 req cota; evento é pontual.)
  2. Resolver `client_id` + `vencimento`: por `sienge_contratos.receivable_bill_id` (tem o vínculo) e/ou
     `sienge_boletos` (rbid+inst → customer_id+due_date); telefone via `sienge_clientes`.
  3. Baixar o PDF → subir no bucket **`boletos`** → **upsert em `boletos_emitidos`** (mesma chave
     `client_id,vencimento`, set `linha_digitavel`/`pdf_path`/`valor`). **Idempotente** → convive com o ZIP
     (o que chegar por último vence; mesma chave). Marcar a origem (ex.: `lote='sienge-webhook'` ou um
     campo). Auditar em `sienge_webhook_events`.
- **Resultado:** boletos Sienge que NÃO vêm no ZIP (ex.: o caso do cliente 13009) entram **sozinhos**,
  com PDF + linha digitável, e o bot consegue enviá-los. Resolve o buraco que vimos.
- **Reuso:** `_shared/sienge.ts` (auth/base); lógica de download+upload de PDF já existe em
  `enviarBoletoPDF` (`ai-responder`) e na rota `forward`; padrão de roteamento por header já no
  `sienge-webhook` (`handleCadastro`). `siengeSegundaVia` (no `ai-responder`) já chama o
  `payment-slip-notification` — mesma chamada serve aqui.
- **Confirmar antes de codar:** o nome exato do header do evento e o shape do payload do
  `PAYMENT_SLIP_REGISTERED` (registrar o hook, disparar/observar 1 evento em `sienge_webhook_events`).

---

## 5. AÇÕES PENDENTES DO USUÁRIO (painel — não consigo fazer)
- **Registrar `PAYMENT_SLIP_REGISTERED`** na nossa `sienge-webhook` (para a tarefa acima). Curl no padrão
  dos outros (URL `.../functions/v1/sienge-webhook?token=avivwh_...` + `token` no body).
- **Deletar o hook duplicado de baixa do n8n** (`48b9cf19` → `sienge-boleto-pago`) quando aposentar o n8n.
- **Aposentar o n8n "Sienge A" (parcelas)** quando confortável (já fora do caminho crítico).
- **Testar `SALES_CONTRACT_UPDATED`** (alterar um contrato no Sienge) — mecanismo idêntico ao de cliente.
- **Segurança (backlog da auditoria sênior):** rotacionar senha Sienge (vazou no histórico git), ligar
  MFA nos logins, leaked-password protection, upgrade do Postgres, confirmar PITR/backup. Ver `docs/SEGURANCA.md`.
- **Domínio Vercel:** trocar o link de preview por um fixo (`avivchat-aviv.vercel.app` ou domínio próprio).

## 6. GOTCHAS / APRENDIZADOS (não repetir erros)
- **Webhook Sienge:** evento no **header `x-sienge-event`**; body só com o id. Token aceito tanto em
  `?token=` quanto no body. Vários hooks na **mesma URL coexistem** (chave = id do hook).
- **Hooks ativos hoje (3 nossos):** `69881d0c` (baixa: RECEIPT_PROCESSED + UPDATE_RECEIVABLE_BILL_SITUATION),
  `ffe111bb` (CUSTOMER_*), `6235832a` (SALES_CONTRACT_*). Há vários hooks do CVCRM (`aviv.cvcrm.com.br`) —
  **não mexer**.
- **pdf-parse fixado em 1.1.1** (paridade n8n; v2 quebra o subpath). Import via `pdf-parse/lib/pdf-parse.js`.
- **Cota Sienge Free é baixa** — nunca varrer boleto a boleto na API; preferir push/ZIP.
- **`unaccent` não existe** no DB (usar `lower()` + normalização no código).
- Telefone Sienge vem como `"(043)996731869"` → normalizar (remove 0 de tronco, prefixa 55) →
  `5543996731869` (helper `bestPhone` em `_shared/sienge.ts`).
- Edge function de cron chama com a **anon key** (vault `edge_cron_key`); service role fica dentro da função.
- Ao mexer numa VIEW consumida por outras, conferir dependências; usar `security_invoker=true`.
- `mensagens_cobranca` é log de eventos (1 linha por cobrança), não registro de parcela.

## 7. MIGRATIONS (últimas) e EDGE FUNCTIONS
- Migrations até **041** (029 bucket boletos, 030 vw_boleto_chat, 031 receipt_validation, 032
  vw_clientes_boletos valor, 033 central, 034 chat-media privado, 035 cron auto-return, 036 attendant
  soft-delete, 037 boleto_lotes, 038→041 sync clientes/contratos + crons mensais + views contrato).
- Edge functions: ai-responder, process-media, whatsapp-webhook, send-message, dispatch-campaign,
  cobranca-regua, sgl-dispatch, import-boletos (legado), sienge-webhook, sienge-sync-clientes,
  sienge-sync-contratos, auto-return-bot, test-api-call, analyze-comprovante, send-reminders, list-models.
  `_shared/`: whatsapp.ts, apiExec.ts, sienge.ts.
