-- 040_views_empreendimento_contrato.sql
-- Repontar o enriquecimento cadastral (empreendimento/quadra/lote) das views de boleto
-- para os CONTRATOS (vw_cliente_contrato), com fallback no sienge_boletos. Assim clientes
-- novos (que ainda não estão no sienge_boletos) já mostram empreendimento/unidade.
-- Mantém as MESMAS colunas → frontend inalterado. Parseia "Quadra X / Lote Y" do contrato.

-- ── Central ──────────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.vw_boletos_central;
CREATE VIEW public.vw_boletos_central WITH (security_invoker = true) AS
SELECT DISTINCT ON (be.id)
  be.id                   AS emitido_id,
  be.phone_norm,
  be.client_id,
  be.customer_name,
  be.vencimento           AS due_date,
  be.valor                AS amount,
  be.linha_digitavel,
  be.pdf_path,
  be.lote,
  be.created_at,
  COALESCE(ct.enterprise_name, sb.empreendimento)                              AS empreendimento,
  COALESCE(NULLIF(regexp_replace(COALESCE(sb.quadra, ''), '^\s*quadra\s*', '', 'i'), ''), substring(ct.unidade from 'Quadra\s*(\S+)')) AS quadra,
  COALESCE(NULLIF(regexp_replace(COALESCE(sb.lote,   ''), '^\s*lote\s*',   '', 'i'), ''), substring(ct.unidade from 'Lote\s*(\S+)'))   AS unidade_lote,
  sb.parcela_descricao,
  COALESCE(be.paid_at, sb.paid_at) AS paid_at,
  CASE
    WHEN lower(COALESCE(be.status, '')) = 'pago'
      OR lower(TRIM(BOTH FROM COALESCE(sb.status, ''))) = 'pago'
      OR be.paid_at IS NOT NULL OR sb.paid_at IS NOT NULL THEN 'pago'
    WHEN lower(COALESCE(be.status, '')) = 'comprovante_recebido' THEN 'comprovante_recebido'
    WHEN lower(COALESCE(be.status, '')) = 'cancelado' THEN 'cancelado'
    ELSE 'aberto'
  END AS status
FROM public.boletos_emitidos be
LEFT JOIN public.sienge_boletos sb ON sb.customer_id = be.client_id AND sb.due_date = be.vencimento
LEFT JOIN public.vw_cliente_contrato ct ON ct.client_id = be.client_id
WHERE be.phone_norm IS NOT NULL
ORDER BY be.id, sb.due_date;
GRANT SELECT ON public.vw_boletos_central TO authenticated, service_role;

-- ── Régua ────────────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.vw_cobranca_boletos;
CREATE VIEW public.vw_cobranca_boletos WITH (security_invoker = true) AS
SELECT DISTINCT ON (be.id)
  be.phone_norm,
  'sienge'::text AS source,
  be.customer_name,
  be.telefone    AS customer_phone,
  COALESCE(ct.enterprise_name, sb.empreendimento)                              AS empreendimento,
  COALESCE(NULLIF(regexp_replace(COALESCE(sb.quadra, ''), '^\s*quadra\s*', '', 'i'), ''), substring(ct.unidade from 'Quadra\s*(\S+)')) AS quadra,
  COALESCE(NULLIF(regexp_replace(COALESCE(sb.lote,   ''), '^\s*lote\s*',   '', 'i'), ''), substring(ct.unidade from 'Lote\s*(\S+)'))   AS lote,
  COALESCE(sb.parcela_descricao, '') AS parcela,
  be.vencimento  AS due_date,
  be.valor       AS amount,
  be.linha_digitavel AS link_boleto,
  sb.receivable_bill_id,
  sb.installment_id
FROM public.boletos_emitidos be
LEFT JOIN public.sienge_boletos sb ON sb.customer_id = be.client_id AND sb.due_date = be.vencimento
LEFT JOIN public.vw_cliente_contrato ct ON ct.client_id = be.client_id
WHERE be.phone_norm IS NOT NULL
  AND lower(COALESCE(be.status, 'aberto')) = 'aberto'
  AND (sb.status IS NULL OR lower(TRIM(BOTH FROM sb.status)) = 'aberto');
GRANT SELECT ON public.vw_cobranca_boletos TO authenticated, service_role;
