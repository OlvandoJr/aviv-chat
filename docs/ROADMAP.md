# Roadmap — aviv-chat

Mapa do produto: ideias e features, agrupadas por área. Os itens acionáveis viram
**GitHub Issues** (link ao lado); este arquivo é a visão geral.

> **Como usar:** ideia nova → adicione um item aqui e/ou abra uma issue. Ao implementar,
> referencie a issue no PR (`Closes #N`) para fechar sozinha. O Claude Code lê e mantém
> este arquivo.

---

## 🟡 Em aberto

### Cobrança (Sienge / SGL)
- [ ] **Webhook de mudança de status do boleto (Sienge)** → grava `sienge_boletos.status='pago'` + `paid_at`
      para fechar o ciclo do **PAGO (🟢)** na Central — [#11](https://github.com/OlvandoJr/aviv-chat/issues/11).
      A UI já renderiza verde a partir desses campos; falta só receber o evento.
      *(SGL não tem API de pagamento — fica no 🟡 comprovante recebido.)*
- [ ] **Ativar a Régua Sienge** e desativar a régua antiga no n8n — [#4](https://github.com/OlvandoJr/aviv-chat/issues/4)
- [ ] **UI para o mapa SGL** (`sgl_regua_map`) — [#6](https://github.com/OlvandoJr/aviv-chat/issues/6)
- [ ] **Template `vence_hoje`** (criar/aprovar na Meta para o passo D0) — [#7](https://github.com/OlvandoJr/aviv-chat/issues/7)
- [ ] **Boleto PDF como documento no WhatsApp** (template de mídia) — [#8](https://github.com/OlvandoJr/aviv-chat/issues/8)

### Central de Clientes
- [ ] **PDF dos boletos na Central** (Storage + upload n8n + URL assinada) — [#3](https://github.com/OlvandoJr/aviv-chat/issues/3)
- [ ] **Fase 2 — ações no detalhe** (Enviar template, Adicionar à régua) — [#5](https://github.com/OlvandoJr/aviv-chat/issues/5)

### Segurança & Infra
- [ ] **Proteção de senha vazada + upgrade Postgres** (painel Supabase) — [#9](https://github.com/OlvandoJr/aviv-chat/issues/9)
- [ ] **Limpar workflows Sienge antigos** no n8n — [#10](https://github.com/OlvandoJr/aviv-chat/issues/10)
- [ ] Rotacionar senha Sienge ✅ *(feito — Supabase + n8n validados)*

---

## ✅ Concluído

### Disparo de cobrança no sistema (direto na Meta)
- Núcleo de envio compartilhado (`lib/whatsapp/*` + `_shared/whatsapp.ts`).
- **Campanhas em massa** (tabelas + `dispatch-campaign` + UI `/campaigns`).
- **Régua de cobrança** multi-disparo configurável (UI `/regua` + `cobranca-regua`).
- **SGL event-driven** (`sgl-dispatch`): reage a cada inserção, com retry; cutover feito.
- **Sienge via boletos emitidos**: PDF de segunda via → n8n (Drive → extrai) →
  `import-boletos` → `boletos_emitidos`; régua usa a linha digitável (resolve a quota).
- Crons (`pg_cron` + Vault), preview de template, runbook de segurança.

### Alimentação Sienge
- Fix do trigger `sienge_boletos` (`NEW.client_id` → `customer_id`) que travava o sync.
- Telefone dos boletos **self-healing** (trigger de propagação + backfill).
- Remoção da estrutura órfã do resumo (perf + menos PII).

### Central de Clientes
- View `vw_central_clientes` (360 por telefone) + lista com filtros + detalhe (boletos,
  cobrança, conversa) — origem Sienge/SGL/Ambos/Contato.
- Fix de RLS (leitura `authenticated` em `sienge_clientes` e `mensagens_cobranca`).

---

## 💡 Ideias soltas (sem issue ainda)
- *(adicione aqui ideias futuras antes de promovê-las a issue)*
