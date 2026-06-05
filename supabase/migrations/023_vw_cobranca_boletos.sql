-- 023_vw_cobranca_boletos.sql
-- Fonte da RÉGUA SIENGE: boletos efetivamente emitidos (boletos_emitidos, com linha
-- digitável), enriquecidos com dados cadastrais do sienge_boletos (casados por
-- client_id + vencimento). É POR BOLETO (não deduplicado) — a régua acerta cada
-- boleto no seu vencimento. {{8}} do template = linha digitável.
-- (A vw_clientes_boletos deduplicada segue para o bot e campanhas.)
DROP VIEW IF EXISTS public.vw_cobranca_boletos;
CREATE VIEW public.vw_cobranca_boletos
WITH (security_invoker = true) AS
SELECT DISTINCT ON (be.id)
  be.phone_norm,
  'sienge'::text          AS source,
  be.customer_name,
  be.telefone             AS customer_phone,
  sb.empreendimento,
  sb.quadra,
  sb.lote,
  COALESCE(sb.parcela_descricao, '') AS parcela,
  be.vencimento           AS due_date,
  be.valor                AS amount,
  be.linha_digitavel      AS link_boleto,
  sb.receivable_bill_id,
  sb.installment_id
FROM public.boletos_emitidos be
LEFT JOIN public.sienge_boletos sb
  ON sb.customer_id = be.client_id AND sb.due_date = be.vencimento
WHERE be.phone_norm IS NOT NULL
  AND lower(coalesce(be.status, 'aberto')) = 'aberto'
  -- ciente de pagamento: se a parcela correspondente no Sienge já foi paga, exclui
  AND (sb.status IS NULL OR lower(trim(sb.status)) = 'aberto');

GRANT SELECT ON public.vw_cobranca_boletos TO authenticated, service_role;
