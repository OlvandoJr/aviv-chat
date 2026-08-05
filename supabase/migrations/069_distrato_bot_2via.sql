-- ─────────────────────────────────────────────────────────────────────────────
-- 069 — Distrato: fechar também a 2ª via do bot
--
-- A 068 protegeu a régua/lembretes (vw_cobranca_boletos), mas o bot busca o
-- boleto em OUTRA view (vw_boleto_chat) — sem a proteção, um cliente que já
-- distratou pediria "quero meu boleto" e o bot entregaria.
--
-- Mesma regra: cliente com contrato(s) e nenhum ativo não tem boleto a receber.
-- Sem resultado, o bot cai no fluxo de "não encontrei" e chama um humano — que
-- é o desfecho correto para quem distratou.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.vw_boleto_chat AS
 SELECT DISTINCT ON (be.id) be.id AS emitido_id,
    be.phone_norm,
    be.customer_name,
    be.client_id,
    be.vencimento AS due_date,
    be.valor AS amount,
    be.linha_digitavel,
    be.pdf_path,
    be.status,
    sb.customer_cpf,
    COALESCE(NULLIF(sb.parcela_descricao::text, ''::text), 'Boleto venc. '::text || to_char(be.vencimento::timestamp with time zone, 'DD/MM/YYYY'::text)) AS parcela_descricao,
    sb.receivable_bill_id,
    sb.installment_id
   FROM boletos_emitidos be
     LEFT JOIN sienge_boletos sb ON sb.customer_id = be.client_id AND sb.due_date = be.vencimento
  WHERE be.phone_norm IS NOT NULL
    AND (lower(COALESCE(be.status, 'aberto'::text)) <> ALL (ARRAY['pago'::text, 'cancelado'::text]))
    AND (sb.status IS NULL OR (lower(TRIM(BOTH FROM sb.status)) <> ALL (ARRAY['pago'::text, 'cancelado'::text])))
    -- DISTRATO: cliente sem nenhum contrato ativo não recebe boleto.
    AND NOT (
      EXISTS (SELECT 1 FROM sienge_contratos sc WHERE sc.client_id = be.client_id)
      AND NOT EXISTS (
        SELECT 1 FROM sienge_contratos sc
        WHERE sc.client_id = be.client_id AND sc.situation !~* 'cancel|distrat'
      )
    )
  ORDER BY be.id, sb.due_date;

COMMENT ON VIEW public.vw_boleto_chat IS
  'Boletos que o bot pode entregar (2ª via). Exclui pagos, cancelados e clientes '
  'sem nenhum contrato ativo (distrato) — ver migrations 068/069.';
