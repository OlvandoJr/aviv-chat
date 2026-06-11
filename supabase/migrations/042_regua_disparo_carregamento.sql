-- 042_regua_disparo_carregamento.sql
-- Régua: disparo "no dia do carregamento" — dispara quando o boleto ENTRA no sistema
-- (upload do ZIP ou captura via sienge-webhook), em vez de offset do vencimento.
--
-- • cobranca_regua_step.on_load: marca o passo como disparo de carregamento.
--   O passo guarda offset_days=999 (sentinela) só para a UNIQUE do log continuar
--   deduplicando 1x por boleto (regua_id, offset_days, phone_norm, due_date).
-- • vw_cobranca_boletos.loaded_date: data BRT em que o boleto entrou
--   (boletos_emitidos.created_at) — audiência do passo on_load. created_at não muda
--   no upsert (re-upload do ZIP não redispara).

ALTER TABLE public.cobranca_regua_step
  ADD COLUMN IF NOT EXISTS on_load boolean NOT NULL DEFAULT false;

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
  (be.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS loaded_date
FROM boletos_emitidos be
LEFT JOIN sienge_boletos sb ON sb.customer_id = be.client_id AND sb.due_date = be.vencimento
LEFT JOIN vw_cliente_contrato ct ON ct.client_id = be.client_id
WHERE be.phone_norm IS NOT NULL
  AND lower(COALESCE(be.status, 'aberto')) = 'aberto'
  AND (sb.status IS NULL OR lower(TRIM(BOTH FROM sb.status)) = 'aberto');
