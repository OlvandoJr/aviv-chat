-- 051_link_boleto_url.sql
-- A variável {{Boleto}} da régua/campanha mapeia para a coluna `link_boleto`. Decisão:
-- substituir a linha digitável pelo LINK público do boleto (edge boleto-link). Então
-- basta trocar o conteúdo de `link_boleto` nas views de cobrança — sem mexer no template
-- nem no mapeamento. SGL mantém seu próprio link (mensagens_cobranca.linkboleto).
-- IMPORTANTE: manter WITH (security_invoker = true) nas duas (regressão pega no #60).

CREATE OR REPLACE VIEW public.vw_cobranca_boletos
WITH (security_invoker = true) AS
SELECT DISTINCT ON (be.id)
  be.phone_norm, 'sienge'::text AS source, be.customer_name, be.telefone AS customer_phone,
  COALESCE(be.empreendimento, ct.enterprise_name, sb.empreendimento) AS empreendimento,
  COALESCE(NULLIF(regexp_replace(COALESCE(sb.quadra, ''), '^\s*quadra\s*', '', 'i'), ''), substring(ct.unidade FROM 'Quadra\s*(\S+)')) AS quadra,
  COALESCE(NULLIF(regexp_replace(COALESCE(sb.lote, ''), '^\s*lote\s*', '', 'i'), ''), substring(ct.unidade FROM 'Lote\s*(\S+)')) AS lote,
  COALESCE(sb.parcela_descricao, '') AS parcela,
  be.vencimento AS due_date, be.valor AS amount,
  'https://jpxlczmbxfcnujemlxzq.supabase.co/functions/v1/boleto-link?t=' || be.public_token AS link_boleto,
  sb.receivable_bill_id, sb.installment_id,
  (be.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS loaded_date,
  ( SELECT d0 + CASE EXTRACT(isodow FROM d0) WHEN 6 THEN 2 WHEN 7 THEN 1 ELSE 0 END
    FROM ( SELECT (be.created_at AT TIME ZONE 'America/Sao_Paulo')::date
                + CASE WHEN EXTRACT(hour FROM be.created_at AT TIME ZONE 'America/Sao_Paulo') >= 18 THEN 1 ELSE 0 END AS d0 ) x
  ) AS load_dispatch_date
FROM boletos_emitidos be
LEFT JOIN sienge_boletos sb ON sb.customer_id = be.client_id AND sb.due_date = be.vencimento
LEFT JOIN vw_cliente_contrato ct ON ct.client_id = be.client_id
WHERE be.phone_norm IS NOT NULL
  AND lower(COALESCE(be.status, 'aberto')) = 'aberto'
  AND (sb.status IS NULL OR lower(TRIM(BOTH FROM sb.status)) = 'aberto');

CREATE OR REPLACE VIEW public.vw_clientes_boletos
WITH (security_invoker = true) AS
 WITH sienge AS (
         SELECT DISTINCT ON (sb.phone_norm) sb.phone_norm, 'sienge'::text AS source, sb.customer_name, sb.customer_phone,
            COALESCE(be.empreendimento, sb.empreendimento) AS empreendimento, sb.parcela_descricao AS parcela,
            COALESCE(be.vencimento, sb.due_date) AS due_date, COALESCE(be.valor, sb.amount) AS amount,
            CASE WHEN be.public_token IS NOT NULL
                 THEN 'https://jpxlczmbxfcnujemlxzq.supabase.co/functions/v1/boleto-link?t=' || be.public_token
                 ELSE NULL END AS link_boleto,
            sb.receivable_bill_id, sb.installment_id, sb.quadra, sb.lote
           FROM sienge_boletos sb
             LEFT JOIN boletos_emitidos be ON be.client_id = sb.customer_id AND be.vencimento = sb.due_date AND lower(COALESCE(be.status, 'aberto'::text)) = 'aberto'::text
          WHERE lower(TRIM(BOTH FROM sb.status)) = 'aberto'::text AND sb.phone_norm IS NOT NULL
          ORDER BY sb.phone_norm, (be.id IS NULL), sb.due_date
        ), sgl AS (
         SELECT DISTINCT ON (mensagens_cobranca.phone_norm) mensagens_cobranca.phone_norm, 'sgl'::text AS source,
            mensagens_cobranca.pessoanomecompleto AS customer_name, mensagens_cobranca.phone AS customer_phone,
            mensagens_cobranca.unidadeempreendimento AS empreendimento, mensagens_cobranca.contasreceberparcela AS parcela,
            mensagens_cobranca.contasrecebervencimento AS due_date,
                CASE WHEN replace(replace(COALESCE(mensagens_cobranca.contasrecebervalor, ''::text), '.'::text, ''::text), ','::text, '.'::text) ~ '^\d+(\.\d+)?$'::text
                    THEN replace(replace(mensagens_cobranca.contasrecebervalor, '.'::text, ''::text), ','::text, '.'::text)::numeric ELSE NULL::numeric END AS amount,
            mensagens_cobranca.linkboleto AS link_boleto, NULL::integer AS receivable_bill_id, NULL::integer AS installment_id,
            mensagens_cobranca.unidadequadraandar AS quadra, mensagens_cobranca.unidadeloteapartamento AS lote
           FROM mensagens_cobranca WHERE mensagens_cobranca.phone_norm IS NOT NULL
          ORDER BY mensagens_cobranca.phone_norm, mensagens_cobranca.contasrecebervencimento DESC NULLS LAST
        )
 SELECT phone_norm, source, customer_name, customer_phone, empreendimento, parcela, due_date, amount, link_boleto, receivable_bill_id, installment_id, quadra, lote FROM sienge
 UNION ALL
 SELECT s.phone_norm, s.source, s.customer_name, s.customer_phone, s.empreendimento, s.parcela, s.due_date, s.amount, s.link_boleto, s.receivable_bill_id, s.installment_id, s.quadra, s.lote
   FROM sgl s WHERE NOT (EXISTS ( SELECT 1 FROM sienge si WHERE si.phone_norm = s.phone_norm));
