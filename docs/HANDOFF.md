# HANDOFF — continuação do projeto aviv-chat

> Para a PRÓXIMA sessão. Leia **este arquivo** + **`docs/ARQUITETURA.md`** antes de mexer.
> Tudo abaixo está **no ar** salvo onde indicado. Última atualização: **2026-08-22**
> (fim da temporada de agosto: PRs #115–#137, migrations 067–077).
> Memória persistente do Claude: índice em `~/.claude/projects/-Users-macbookair-SIENGE/memory/MEMORY.md`
> — os arquivos de memória têm o "porquê" de cada decisão; este handoff tem o "o quê/onde".

---

## 0. COMO OPERAR (crítico — uma sessão nova não sabe disso)

- **Working dir:** `/Users/macbookair/aviv-chat`. Repo: `github.com/OlvandoJr/aviv-chat`.
- **Supabase project ref:** `jpxlczmbxfcnujemlxzq` (MCP tools e CLI).
- **Deploy do app (Next):** automático no **merge para `main`** (Vercel).
- **Edge Functions e migrations NÃO sobem no merge** — são manuais:
  - Edge: `export SUPABASE_ACCESS_TOKEN=$(grep '^SUPABASE_ACCESS_TOKEN=' .env.local | cut -d= -f2)`
    e `npx supabase functions deploy <nome> --project-ref jpxlczmbxfcnujemlxzq`
    (+ `--no-verify-jwt` para `sienge-webhook`). NUNCA reconstruir função inline via MCP — o CLI lê do disco.
  - Migrations: MCP `apply_migration` **e** criar o arquivo em `supabase/migrations/NNN_*.sql`.
    **Última é 077.** (065/066 nunca existiram no repo — `can_view_conversation` e colunas `access_*`
    vivem só em produção; drift conhecido.)
- **PR + merge sozinho** (gh não instalado): token via
  `git credential fill` (protocol=https/host=github.com → password=). Padrão: branch de `origin/main`
  → commit (`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`) → push → PR via API → squash-merge
  → apagar branch → `git checkout main && git pull`.
- **tsc:** `npx tsc --noEmit` (lado Next). **Deno para testes**: instalar no scratchpad
  (`curl -fsSL https://deno.land/install.sh | sh`) e rodar
  `deno test --allow-net supabase/functions/_shared/comprovante.test.ts` (24 testes).
  `deno check` do process-media acusa **2 erros de tipo pré-existentes** (typing supabase-js:
  TS2589 em runWriteOps, `.catch` ~L606) — não são regressão.
- **Chamadas autenticadas a APIs externas sem expor credencial:** edge `test-api-call` executa uma
  config inline e resolve `{{env.X}}`. CV CRM: `CV_BASE_URL`(=https://aviv.cvcrm.com.br)/`CV_EMAIL`/`CV_TOKEN`
  (headers email/token). Sienge: `SIENGE_USER`/`SIENGE_PASSWORD` (basic), base
  `https://api.sienge.com.br/avivconstrutora/public/api/v1`. **Cota Sienge Free: 100 req/DIA no total.**
- **Testar comprovante/bot SEM falar com cliente:** nunca reprocessar mensagem original (dispara
  `ai-responder` → WhatsApp real). Subir edge function isolada, testar, apagar
  (`yes | npx supabase functions delete <nome> ...`). Cliente de TESTE: Paulo Henrique Sanches,
  `client_id=1` (distratado; conversa `55b7d984-39db-46ae-a8fa-989392e5d1cc`, contato `04a0cf8a-…`).
- `.env.local`: `NEXT_PUBLIC_SUPABASE_URL/ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ACCESS_TOKEN`.

---

## 1. O QUE FOI FEITO NA TEMPORADA DE AGOSTO (PRs #115–#137)

Cada item tem PR com o caso real no corpo. Ordem cronológica:

| PR | O quê | Onde |
|---|---|---|
| #115 | Busca dentro das conversas (nome/telefone/conteúdo, RPC `search_conversations`, pg_trgm) | mig 067, ConversationList |
| #116 | **Distrato — rede de segurança**: cliente com contrato(s) e NENHUM ativo sai de `vw_cobranca_boletos` e `vw_boleto_chat`; backfill `receivable_bill_id` | migs 068/069 |
| #117 | Régua: reposição de fim de semana cede a vez ao passo exato do dia + 1 msg/boleto/dia | cobranca-regua |
| #118 | **PDF de imagem**: `analyzePdf` via `/v1/responses` `input_file` (chat/completions não renderiza → modelo inventava) | process-media |
| #119 | Saudação pelo horário: `agoraBRT()` injeta data/hora/saudação nos 2 prompts | ai-responder |
| #120 | Rotação de foto no `analyzeImage` (dígito verificador como sinal forte) | process-media |
| #121 | Despedida ("🙏","obrigada") não gera resposta — portão 1d determinístico | ai-responder |
| #122 | **Baixas**: retry de falha transitória (attempts≤5), relevância = título→cliente→tem boleto aberto; resgate de 61 eventos | mig 071, reconcile, _shared/sienge |
| #123 | 2º sync de contratos 08:30 BRT (pré-régua) | mig 072, cron |
| #124→#125 | CV CRM webhook distrato criado e **removido**: a raiz era grafia — Sienge emite `SALES_CONTRACT_CANCELED` (**um L**) e não valida nome no POST /hooks; assinatura corrigida; **cancelado ≠ removido** no handler (cancelado NÃO apaga a linha) | sienge-webhook, hooks Sienge |
| #126 | Régua SGL não cobra distratado (ponte = telefone; telefone pode ter VÁRIOS clientes — bloquear só se NENHUM ativo) | sgl-dispatch |
| #127 | Campanhas: distratado fora da audiência (filtro na rota que materializa; `incluir_distratados` como escape) | mig 073, audience/route |
| #128 | **Bloquear contato** (lista negra SÓ da IA): `chat_contacts.bot_bloqueado/_em/_por` + trigger autoria; portão ANTES do debounce e do routeSubagentFlow; auto-return-bot pula | mig 074, UI |
| #129 | **Bot não afirma pagamento sem prova**: trava `AFIRMA_PAGAMENTO` por VENCIMENTO CITADO antes do envio; pagos recentes (120d, máx 3) no contexto | ai-responder, mig 075 (regra em TODOS os agentes) |
| #130 | Debounce **janela rolante** (15s silêncio, teto 45s) + última checagem antes de enviar (estado mudou? outra execução respondeu?) | ai-responder |
| #131 | **Agendamento** = 3ª categoria de documento (nem boleto, nem comprovante; sem baixa) | process-media, ai-responder, prompts |
| #132 | **Plano 3 etapas — passo 1**: `_shared/comprovante.ts` (LER→CASAR→DECIDIR; 9 regras, baixa SÓ na 1; regra 3 = "parcela já paga") | + comprovante.test.ts |
| #133 | Histórico agregado ("quantas parcelas paguei") → atendente; lista parcial se declara parcial | ai-responder |
| #134 | Prompt de classificação **v3** (prioridades + lista negativa + `__HOJE__` runtime) + `extraction_model` **gpt-4o** | prompts em chat_subagents, process-media |
| #135 | Rotação não gira imagem legível em pé (CPF mascarado nunca fecha o "sinal forte"; alucinação vence por completude) | process-media |
| #136 | **Âncora linha digitável**: DVs mod10+mod11, decodifica valor/venc, casa por `linha_norm` (coluna gerada) incl. PAGOS; `repararLinha` (1 dígito, só com unicidade+valor) | mig 076, comprovante.ts, process-media |
| #137 | **Sentinela diária** 07:00 BRT: 8 invariantes → `sentinela_log` (registro passivo, sem mensagem) | mig 077, edge sentinela |

**Estado vivo fora do código (importante!):**
- Prompts de extração em `chat_subagents` (imagem `fd4101fe-490f-4a2a-8e9f-bdccba8502d4`,
  PDF `22e4dc8a-422d-4d0a-a334-d2c4a95753e4`), `extraction_model='gpt-4o'`, contêm `__HOJE__` e o campo
  `linha_digitavel`. **REGRA: qualquer edição nos prompts roda a bateria dos 8 documentos reais** (§3).
- Regras anti-invenção nos prompts dos agentes `Vivi` (mig 070) e `Contato Inteligente` (mig 075).
- Hooks no Sienge (GET /hooks): nossos = PAYMENT_SLIP_REGISTERED | RECEIPT_PROCESSED+UPDATE_RECEIVABLE_BILL_SITUATION
  | SALES_CONTRACT_{CANCELED,CREATED,UPDATED,ISSUED,REMOVED} | CUSTOMER_*. CV CRM: **nenhum webhook nosso**
  (removidos); terceiros lá: Rauzee ×16 (duplicados, projeto externo), Simulador ×3, n8n ×2 — não tocar.
- Crons: regua hourly 0*, sgl+campaign 5min, reconcile 20,50*, reminders 5*, auto-return 15*,
  sync-contratos 6:30+11:30 UTC, sync-clientes **diário 6:00 UTC** (mig 078, ~7 req/dia — era mensal;
  o CUSTOMER_CREATED chega antes de o cadastro existir no GET /customers/{id}), **sentinela 10:00 UTC**.
- **PR #139 (22/08, veio de outra sessão)**: `test-api-call` endurecido — portão de role
  (authenticated/service_role; anon → 403), `{{env.X}}` só resolve `SIENGE_*`/`CV_*`, guarda SSRF.
  Deployado e verificado. O `_shared/apiExec.ts` é compartilhado com o `ai-responder` (compatível;
  pega a allowlist no próximo deploy dele — feito em 25/08 junto do #141).
- **PR #143 (25/08): conversas por caixa** — seletor discreto ao lado do título (só as
  caixas que o usuário atende; admin/gerente veem todas; escondido com uma só), escolha
  lembrada em cookie lido no server component, e a caixa vira escopo (lista + 3 contadores
  + busca). Etiquetas aguardando/comprovante/internas viraram ponto+texto abaixo dos
  filtros; os chips "Filtrando: …" foram aposentados (comprovante/internas alternam).
- **PR #141 (25/08): IA por campanha** (mig 079) — `chat_campaigns.bot_ativo` (interruptor,
  default true) + `agent_id` (especialista). No ai-responder, o ÚLTIMO template out até 7 dias
  decide: campanha com IA desligada → `handled_by='human'` e bot mudo; especialista → ele
  responde; sem especialista → janela de 24h (Vivi) como sempre. Vínculo editável no wizard
  da campanha E no editor do agente (seção Roteamento). Bônus: corrigido `header_media_mode`
  ausente no select do dispatch (modo "boleto de cada cliente" nunca funcionava).

---

## 2. PENDÊNCIAS (em ordem)

1. **Passos 3-4 do plano de comprovantes** (`docs/PLANO-validacao-comprovantes.md`, aprovado):
   ligar CASAR+DECIDIR no process-media (aposentar a cascata legada + `valueGuardVerdict` +
   `receiptNeedsHuman`) e `ai-responder` entregar `decisao.mensagem`. A âncora (#136) já convive
   cirurgicamente com o legado. **Combinado: deixar assentar uns dias com a sentinela antes.**
2. **Número da parcela — BLOQUEADO NO USUÁRIO**: perguntar ao financeiro como o Sienge numera
   (atendente disse "004/005"; espelho diz que a parcela de agosto da Andréia é a 5ª mensal do título 341).
   Sem isso, passo 2 (bot não inventa parcela) e 5 (trazer nº real) saem errados.
3. **Observar o 1º comprovante real pós-âncora**: `select ... from chat_messages where ai_analysis->>'linha_valida'='true'`
   (0 até 22/08). A sentinela pega quebras.
4. Conferir visualmente o **checkbox de campanhas** (tela exige login — nunca foi visto renderizado).
5. **Caso Mayke** (5544999388590, título 217): disse que pagou 10/08; Sienge sem baixa — financeiro conferir.
6. Fila do reconcile: ~217 eventos antigos drenando a 20 req/dia (normal; sentinela vigia).
7. SGL: 77 telefones sem vínculo Sienge ficam fora da trava de distrato (limitação aceita e documentada).
8. **Pós-endurecimento do `test-api-call` (PR #139)**: com o dashboard logado, clicar "Testar" uma vez
   numa API cadastrada — tem de funcionar (chamadores mandam JWT de sessão; anon pura agora leva 403).
9. **`ai-responder` é chamável com a anon key** (`verify_jwt` não segura — a anon key é um JWT válido
   e pública). Não vaza credencial nem aceita URL arbitrária, mas permite acionar o bot de fora com um
   `conversationId` válido. Avaliar portão de role igual ao do test-api-call (cuidado: crons e invocações
   internas usam service_role/edge_cron_key — mapear antes).
10. Registro órfão `client_id=999999` em `sienge_clientes` (não existe na API; sobra de teste antigo) —
   limpar se o usuário quiser.
11. **Seletor de caixa nas conversas (PR #143)**: hoje TODOS os atendentes têm exatamente
   1 caixa vinculada, então só o admin vê o seletor. Se um atendente passar a atender 2+
   caixas, conferir com ele. A preferência vai no cookie `conversas_inbox` (lido no
   layout server) — limpar o cookie volta para "Todas as caixas".
12. **IA por campanha (PR #141)**: conferir a UI logado (bloco "Atendimento por IA" no wizard;
   "Campanhas respondidas por este agente" no editor) e fazer o teste real controlado com
   audiência = só o número do Olvando: especialista responde texto livre; campanha com IA
   desligada fica muda e cai na fila humana; cobrança normal segue com a Vivi.

---

## 3. BATERIA DE DOCUMENTOS REAIS (regressão de prompts/extração)

Storage `chat-media` (salvo indicação), todos com caso real por trás. Esperado entre parênteses:

| Doc | Path |
|---|---|
| Boner PDF (comprovante Caixa IB) | `chat/902ad1a9-95f2-49cd-9942-831732c7c557/28ec521a-3753-476e-8a27-42b53ddd4a40.pdf` |
| Geovana PDF (comprovante Caixa) | `chat/5f84949c-ba93-4f3c-8eea-cb55ac69fba2/f0c2ba64-dafd-4a45-9c35-3eb583784a9e.pdf` |
| Andréia PDF (comprovante Bradesco) | `chat/ac0f428c-411d-478a-8d05-e390ca433b4d/308c8c22-d72f-4c2d-b0f7-2f68fa404845.pdf` |
| Andréia IMG (**agendamento** Bradesco) | `chat/ac0f428c-411d-478a-8d05-e390ca433b4d/cb8197ae-97b2-4bc5-9d24-9ee8b6c40851.jpg` |
| Dirceu IMG (comprovante lotérica, foto deitada) | `chat/24b09a44-7405-4eed-80d2-8a98d58cf928/4c8379e5-5ffd-4aba-a074-4c99dfeafa2b.jpg` |
| Boner IMG (extrato com débito) | `chat/902ad1a9-95f2-49cd-9942-831732c7c557/0e37fd04-1c0d-491f-9e6b-d6e53275a19b.jpg` |
| José Vitor IMG (screenshot comprovante) | `chat/8b51cdda-4c65-4ae8-b2e4-76ee94c91df6/d1e0a680-747e-4888-b708-132ed34718bc.jpg` |
| **Boleto real** (anti-boleto → 'boleto') | bucket `boletos`: `93/2026-08-20-t341p5.pdf` |

Harness: edge temporária que baixa do storage e chama a extração com o prompt do banco
(pdf via `/v1/responses` `input_file`; imagem via chat/completions `detail:high`) — criar, rodar, **apagar**.
Linhas digitáveis reais p/ testes de decode: José Vitor `10491.25733 95000.100040 00000.018051 1 15470000062820`
(628,20 · 23/08/2026), Andréia `10491 24918 94000.100043 00000.001305 7 15440000060349` (603,49 · 20/08/2026).

---

## 4. INVARIANTES / ONDE OLHAR PRIMEIRO

- **Sentinela**: `select invariante, ok, valor, limite, detalhe from sentinela_log where run_date = current_date order by ok;`
  — SEMPRE olhar antes de investigar suspeita de quebra.
- "Cliente diz que pagou": conferir evento `RECEIPT_PROCESSED` do título/parcela; individual quase nunca
  é bug; em massa, comparar chegada de eventos × baixas aplicadas por dia.
- "Bot respondeu N vezes": intervalo entre mensagens × janela (15s) + corrida na geração.
- "Bot não respondeu": pode ser `reason: 'farewell'` (despedida) ou contato bloqueado — não é bug.
- "Bot disse X errado": se `type='template'`, o texto não veio do modelo (template da Meta — usuário edita/sincroniza).
- Régua/2ª via/SGL/campanhas: todas as 4 vias têm trava de distrato; caminho NOVO de envio precisa herdar.
