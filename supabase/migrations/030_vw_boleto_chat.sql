-- 030_vw_boleto_chat.sql
-- Fonte do BOT (ai-responder) e da validação de comprovante: o boleto EMITIDO
-- (boletos_emitidos, com valor real + linha digitável + PDF), enriquecido com os
-- IDs do Sienge (receivable_bill_id/installment_id) via join por client_id+vencimento.
-- Exclui pagos/cancelados (na própria base emitida E na parcela Sienge correspondente).
-- O Sienge passa a ser só FALLBACK quando o cliente não tem boleto emitido.

DROP VIEW IF EXISTS public.vw_boleto_chat;
CREATE VIEW public.vw_boleto_chat
WITH (security_invoker = true) AS
SELECT DISTINCT ON (be.id)
  be.id                   AS emitido_id,
  be.phone_norm,
  be.customer_name,
  be.client_id,
  be.vencimento           AS due_date,
  be.valor                AS amount,
  be.linha_digitavel,
  be.pdf_path,
  be.status,
  sb.customer_cpf,
  COALESCE(NULLIF(sb.parcela_descricao, ''),
           'Boleto venc. ' || to_char(be.vencimento, 'DD/MM/YYYY')) AS parcela_descricao,
  sb.receivable_bill_id,
  sb.installment_id
FROM public.boletos_emitidos be
LEFT JOIN public.sienge_boletos sb
  ON sb.customer_id = be.client_id AND sb.due_date = be.vencimento
WHERE be.phone_norm IS NOT NULL
  AND lower(coalesce(be.status, 'aberto')) NOT IN ('pago', 'cancelado')
  AND (sb.status IS NULL OR lower(trim(sb.status)) NOT IN ('pago', 'cancelado'))
ORDER BY be.id, sb.due_date NULLS LAST;

GRANT SELECT ON public.vw_boleto_chat TO authenticated, service_role;
