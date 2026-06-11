-- 043_regua_dias_uteis.sql
-- Regra legal: cobrança automática não sai em sábado/domingo (posterga p/ segunda).
-- vw_cobranca_boletos ganha `load_dispatch_date`: a data EFETIVA do disparo de
-- carregamento — boleto carregado até 18h (BRT) dispara no mesmo dia; depois das
-- 18h, no dia seguinte; se cair em sáb/dom, vai para a segunda-feira.
-- (isodow: sáb=6 → +2 dias, dom=7 → +1 dia.)

CREATE OR REPLACE VIEW public.vw_cobranca_boletos
WITH (security_invoker = true) AS
SELECT DISTINCT ON (be.id)
  be.phone_norm,
  'sienge'::text AS source,
  be.customer_name,
  be.telefone AS customer_phone,
  COALESCE(ct.enterprise_name, sb.empreendimento) AS empreendimento,
  COALESCE(
    NULLIF(regexp_replace(COALESCE(sb.quadra, ''), '^\s*quadra\s*', '', 'i'), ''),
    substring(ct.unidade FROM 'Quadra\s*(\S+)')
  ) AS quadra,
  COALESCE(
    NULLIF(regexp_replace(COALESCE(sb.lote, ''), '^\s*lote\s*', '', 'i'), ''),
    substring(ct.unidade FROM 'Lote\s*(\S+)')
  ) AS lote,
  COALESCE(sb.parcela_descricao, '') AS parcela,
  be.vencimento AS due_date,
  be.valor AS amount,
  be.linha_digitavel AS link_boleto,
  sb.receivable_bill_id,
  sb.installment_id,
  (be.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS loaded_date,
  (
    SELECT d0 + CASE EXTRACT(isodow FROM d0) WHEN 6 THEN 2 WHEN 7 THEN 1 ELSE 0 END
    FROM (
      SELECT (be.created_at AT TIME ZONE 'America/Sao_Paulo')::date
           + CASE WHEN EXTRACT(hour FROM be.created_at AT TIME ZONE 'America/Sao_Paulo') >= 18 THEN 1 ELSE 0 END AS d0
    ) x
  ) AS load_dispatch_date
FROM boletos_emitidos be
LEFT JOIN sienge_boletos sb ON sb.customer_id = be.client_id AND sb.due_date = be.vencimento
LEFT JOIN vw_cliente_contrato ct ON ct.client_id = be.client_id
WHERE be.phone_norm IS NOT NULL
  AND lower(COALESCE(be.status, 'aberto')) = 'aberto'
  AND (sb.status IS NULL OR lower(TRIM(BOTH FROM sb.status)) = 'aberto');
