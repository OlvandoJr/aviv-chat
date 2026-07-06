-- 059_multi_boletos_por_vencimento.sql
-- Suporta N boletos por (cliente, vencimento) — caso real: duas parcelas do
-- mesmo título vencendo no mesmo dia (Iraci, título 58, parcelas 3 e 4).
--
-- Identidade do boleto: `boleto_ref`, determinística entre canais:
--   't{rbid}p{inst}'  quando título+parcela conhecidos (webhook, import formato B)
--   'n{nosso_numero}' (só dígitos) senão (formato A / edge n8n)
--   ''                em último caso
-- A única (client_id, vencimento) vira (client_id, vencimento, boleto_ref).
-- O claim da régua passa a ser POR BOLETO (2 boletos = 2 mensagens — decisão de produto).
--
-- ATENÇÃO deploy: os upserts com onConflict antigo quebram após esta migration —
-- aplicar em sequência imediata com o deploy dos edges (ver PR).

-- ── 1. boletos_emitidos: boleto_ref + troca da única ─────────────────────────
ALTER TABLE public.boletos_emitidos
  ADD COLUMN IF NOT EXISTS boleto_ref text NOT NULL DEFAULT '';

UPDATE public.boletos_emitidos SET boleto_ref = CASE
    WHEN receivable_bill_id IS NOT NULL AND installment_id IS NOT NULL
      THEN 't' || receivable_bill_id || 'p' || installment_id
    WHEN COALESCE(regexp_replace(nosso_numero, '\D', '', 'g'), '') <> ''
      THEN 'n' || regexp_replace(nosso_numero, '\D', '', 'g')
    ELSE ''
  END
WHERE boleto_ref = '';

ALTER TABLE public.boletos_emitidos
  DROP CONSTRAINT IF EXISTS boletos_emitidos_client_id_vencimento_key;

DO $$ BEGIN
  ALTER TABLE public.boletos_emitidos
    ADD CONSTRAINT boletos_emitidos_client_venc_ref_key UNIQUE (client_id, vencimento, boleto_ref);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2. cobranca_regua_log: claim por boleto ───────────────────────────────────
ALTER TABLE public.cobranca_regua_log
  ADD COLUMN IF NOT EXISTS boleto_ref text NOT NULL DEFAULT '';

-- Backfill: pré-migração havia no máx. 1 boleto por (phone, venc) — casa direto.
UPDATE public.cobranca_regua_log l SET boleto_ref = be.boleto_ref
FROM public.boletos_emitidos be
WHERE l.boleto_ref = '' AND be.phone_norm = l.phone_norm AND be.vencimento = l.due_date;

ALTER TABLE public.cobranca_regua_log
  DROP CONSTRAINT IF EXISTS cobranca_regua_log_regua_id_offset_days_phone_norm_due_date_key;

DO $$ BEGIN
  ALTER TABLE public.cobranca_regua_log
    ADD CONSTRAINT cobranca_regua_log_claim_key
    UNIQUE (regua_id, offset_days, phone_norm, due_date, boleto_ref);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 3. vw_cobranca_boletos: expõe emitido_id/pdf_path/boleto_ref ─────────────
-- (colunas novas só no FIM — exigência do CREATE OR REPLACE VIEW)
-- IMPORTANTE: manter WITH (security_invoker = true) — regressão pega no #60.
CREATE OR REPLACE VIEW public.vw_cobranca_boletos
WITH (security_invoker = true) AS
SELECT DISTINCT ON (be.id)
  be.phone_norm, 'sienge'::text AS source, be.customer_name, be.telefone AS customer_phone,
  COALESCE(be.empreendimento, ct.enterprise_name, sb.empreendimento) AS empreendimento,
  COALESCE(NULLIF(regexp_replace(COALESCE(sb.quadra, ''), '^\s*quadra\s*', '', 'i'), ''), substring(ct.unidade FROM 'Quadra\s*(\S+)')) AS quadra,
  COALESCE(NULLIF(regexp_replace(COALESCE(sb.lote, ''), '^\s*lote\s*', '', 'i'), ''), substring(ct.unidade FROM 'Lote\s*(\S+)')) AS lote,
  COALESCE(sb.parcela_descricao, '') AS parcela,
  be.vencimento AS due_date, be.valor AS amount,
  'https://jpxlczmbxfcnujemlxzq.supabase.co/functions/v1/b?c=' || be.short_code AS link_boleto,
  sb.receivable_bill_id, sb.installment_id,
  (be.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS loaded_date,
  ( SELECT d0 + CASE EXTRACT(isodow FROM d0) WHEN 6 THEN 2 WHEN 7 THEN 1 ELSE 0 END
    FROM ( SELECT (be.created_at AT TIME ZONE 'America/Sao_Paulo')::date
                + CASE WHEN EXTRACT(hour FROM be.created_at AT TIME ZONE 'America/Sao_Paulo') >= 18 THEN 1 ELSE 0 END AS d0 ) x
  ) AS load_dispatch_date,
  be.id AS emitido_id,
  be.pdf_path,
  be.boleto_ref
FROM boletos_emitidos be
LEFT JOIN sienge_boletos sb ON sb.customer_id = be.client_id AND sb.due_date = be.vencimento
LEFT JOIN vw_cliente_contrato ct ON ct.client_id = be.client_id
WHERE be.phone_norm IS NOT NULL
  AND lower(COALESCE(be.status, 'aberto')) = 'aberto'
  AND (sb.status IS NULL OR lower(TRIM(BOTH FROM sb.status)) = 'aberto');
