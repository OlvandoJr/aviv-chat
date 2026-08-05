-- ─────────────────────────────────────────────────────────────────────────────
-- 068 — Distrato: fechar as duas brechas que deixavam a régua cobrar distratado
--
-- O sync diário de contratos roda e funciona, mas o cancelamento das cobranças
-- (cancelBills) casa os boletos pelo NÚMERO DO TÍTULO (receivable_bill_id).
-- Quem não tem esse número gravado escapa: `.in('receivable_bill_id', ...)`
-- nunca casa NULL. Resultado: cliente distratado seguia recebendo cobrança e
-- lembrete de vencido (ex.: régua de 30 dias disparada em 20/07, 30/07 e 03/08).
--
-- Duas camadas:
--   1. Preencher o número do título onde dá para deduzir com segurança — assim
--      o cancelBills passa a alcançar esses boletos (e a baixa também melhora).
--   2. Rede de segurança na view: se o cliente TEM contrato(s) e NENHUM está
--      ativo, nenhuma cobrança sai — independente de número de título.
--
-- A rede é por CLIENTE SEM CONTRATO ATIVO, não por "tem algum distrato": quem
-- distratou um lote e comprou outro (LUAN, ANA PAULA, MONICA) continua sendo
-- cobrado normalmente pelo contrato vigente. Cliente que não tem contrato
-- nenhum na base (ainda não sincronizado) também não é afetado.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Preencher o nº do título onde o par (cliente, vencimento) é inequívoco ──
WITH unico AS (
  SELECT be.id, min(sb.receivable_bill_id) AS bill_id
  FROM boletos_emitidos be
  JOIN sienge_boletos sb
    ON sb.customer_id = be.client_id AND sb.due_date = be.vencimento
  WHERE be.receivable_bill_id IS NULL AND sb.receivable_bill_id IS NOT NULL
  GROUP BY be.id
  HAVING count(DISTINCT sb.receivable_bill_id) = 1   -- ambíguo fica como está
)
UPDATE boletos_emitidos be
SET receivable_bill_id = u.bill_id
FROM unico u
WHERE be.id = u.id;

-- ── 2. Rede de segurança na view que alimenta régua, bot e lembretes ─────────
CREATE OR REPLACE VIEW public.vw_cobranca_boletos AS
 SELECT DISTINCT ON (be.id) be.phone_norm,
    'sienge'::text AS source,
    be.customer_name,
    be.telefone AS customer_phone,
    COALESCE(be.empreendimento, ct.enterprise_name, sb.empreendimento) AS empreendimento,
    COALESCE(NULLIF(regexp_replace(COALESCE(sb.quadra, ''::text), '^\s*quadra\s*'::text, ''::text, 'i'::text), ''::text), "substring"(ct.unidade, 'Quadra\s*(\S+)'::text)) AS quadra,
    COALESCE(NULLIF(regexp_replace(COALESCE(sb.lote, ''::text), '^\s*lote\s*'::text, ''::text, 'i'::text), ''::text), "substring"(ct.unidade, 'Lote\s*(\S+)'::text)) AS lote,
    COALESCE(sb.parcela_descricao, ''::character varying) AS parcela,
    be.vencimento AS due_date,
    be.valor AS amount,
    'https://jpxlczmbxfcnujemlxzq.supabase.co/functions/v1/b?c='::text || be.short_code AS link_boleto,
    sb.receivable_bill_id,
    sb.installment_id,
    (be.created_at AT TIME ZONE 'America/Sao_Paulo'::text)::date AS loaded_date,
    ( SELECT x.d0 +
                CASE EXTRACT(isodow FROM x.d0)
                    WHEN 6 THEN 2
                    WHEN 7 THEN 1
                    ELSE 0
                END
           FROM ( SELECT (be.created_at AT TIME ZONE 'America/Sao_Paulo'::text)::date +
                        CASE
                            WHEN EXTRACT(hour FROM (be.created_at AT TIME ZONE 'America/Sao_Paulo'::text)) >= 18::numeric THEN 1
                            ELSE 0
                        END AS d0) x) AS load_dispatch_date,
    be.id AS emitido_id,
    be.pdf_path,
    be.boleto_ref
   FROM boletos_emitidos be
     LEFT JOIN sienge_boletos sb ON sb.customer_id = be.client_id AND sb.due_date = be.vencimento
     LEFT JOIN vw_cliente_contrato ct ON ct.client_id = be.client_id
  WHERE be.phone_norm IS NOT NULL
    AND lower(COALESCE(be.status, 'aberto'::text)) = 'aberto'::text
    AND (sb.status IS NULL OR lower(TRIM(BOTH FROM sb.status)) = 'aberto'::text)
    -- DISTRATO: cliente com contrato(s) e nenhum ativo não recebe cobrança.
    AND NOT (
      EXISTS (SELECT 1 FROM sienge_contratos sc WHERE sc.client_id = be.client_id)
      AND NOT EXISTS (
        SELECT 1 FROM sienge_contratos sc
        WHERE sc.client_id = be.client_id AND sc.situation !~* 'cancel|distrat'
      )
    );

COMMENT ON VIEW public.vw_cobranca_boletos IS
  'Boletos cobráveis (régua, bot 2ª via, lembretes). Exclui pagos, cancelados e '
  'clientes sem nenhum contrato ativo (distrato) — ver migration 068.';
