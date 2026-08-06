-- ─────────────────────────────────────────────────────────────────────────────
-- 070 — Vivi não pode afirmar baixa por conta própria
--
-- Caso Geovana (03 e 05/08/2026): a análise recusou o documento (por erro de
-- leitura — ver a correção do PDF em process-media). A cliente respondeu "Esse é
-- o comprovante", e o bot, sem nenhuma validação nova, respondeu "Recebi o
-- comprovante e a BAIXA FOI CONFIRMADA" — duas vezes. Nenhuma baixa existia.
-- Um atendente teve de entrar na conversa e pedir desculpas pelo bot.
--
-- A regra antiga ("Válido (≥80%): confirme recebimento e baixa") deixava a
-- confirmação a cargo do julgamento do modelo, e a insistência do cliente virava
-- "validação". Baixa é fato de sistema, não de conversa — mesmo princípio de a
-- régua só parar com a baixa do Sienge.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE chat_agents
SET system_prompt = replace(
      system_prompt,
      '**Tratamento de comprovantes:**
- **Válido (≥80%)**: confirme recebimento e baixa.
- **Parcial (~50%)**: informe que será validado manualmente.
- **Não é comprovante**: peça reenvio.',
      '**Tratamento de comprovantes:**
- **Válido (≥80%)**: confirme recebimento e baixa.
- **Parcial (~50%)**: informe que será validado manualmente.
- **Não é comprovante**: peça reenvio.
- **NUNCA afirme por conta própria que a baixa/o pagamento foi confirmado.** Só
  diga isso quando a análise do documento no contexto trouxer o resultado válido.
  Sem esse resultado, o certo é: "recebi o comprovante e ele será validado" —
  nunca "a baixa foi confirmada". Baixa é fato de sistema, não de conversa.
- **Cliente insistindo que um documento recusado é comprovante**: não repita a
  recusa nem ceda confirmando a baixa. Reconheça, avise que um atendente vai
  conferir e use `ESCALAR_HUMANO: cliente afirma que o documento é comprovante`.'),
    updated_at = now()
WHERE name = 'Vivi' AND is_active;
