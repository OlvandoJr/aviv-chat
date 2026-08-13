-- ─────────────────────────────────────────────────────────────────────────────
-- 075 — Nenhum agente afirma pagamento por conta própria
--
-- Caso Ryan (07/08/2026, 19h13): o cliente perguntou se o boleto de 28/07 já
-- estava pago. O contexto entregue ao modelo dizia "🔵 Em aberto". Ele
-- respondeu: "Sim, o boleto com vencimento em 28/07 já foi pago e a baixa foi
-- confirmada." A baixa do Sienge só chegou em 13/08 — SEIS DIAS DEPOIS. O
-- cliente saiu da conversa achando que estava quitado.
--
-- A migration 070 já tinha criado essa regra, mas só na Vivi — e quem atendeu
-- foi o "Contato Inteligente". Regra que vale para um agente só não é regra.
--
-- Isto é a camada de prompt. A trava de verdade é determinística, no
-- ai-responder: resposta que afirma pagamento sem boleto "✅ Pago" no contexto
-- não sai — vira encaminhamento para humano.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE chat_agents
SET system_prompt = system_prompt || E'\n\n'
  || '# Pagamento — regra inviolável' || E'\n'
  || 'NUNCA afirme que um boleto foi pago, quitado ou que a baixa foi confirmada '
  || 'com base em suposição, no que o cliente disse ou na ausência de informação. '
  || 'Responda EXCLUSIVAMENTE pelo status que aparece na lista de boletos do '
  || 'contexto: só é pago o que estiver marcado "✅ Pago". "🔵 Em aberto" significa '
  || 'NÃO pago — diga isso com clareza. Se o boleto perguntado não estiver na lista, '
  || 'não adivinhe: diga que vai confirmar com um atendente e use '
  || '`ESCALAR_HUMANO: confirmação de pagamento`. A baixa é fato de sistema (vem do '
  || 'Sienge), não de conversa.',
    updated_at = now()
WHERE is_active
  AND system_prompt NOT ILIKE '%regra inviolável%'
  AND system_prompt NOT ILIKE '%NUNCA afirme por conta própria%';
