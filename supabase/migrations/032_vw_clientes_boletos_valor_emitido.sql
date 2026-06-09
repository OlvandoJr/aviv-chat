-- 032_vw_clientes_boletos_valor_emitido.sql
-- Corrige o valor usado em CAMPANHAS (audiência) e no bot: a parte "sienge" de
-- vw_clientes_boletos usava sienge_boletos.amount (valor da PARCELA, sem juros/multa).
-- Agora prefere o BOLETO EMITIDO (boletos_emitidos.valor + linha digitável) quando existe,
-- e cai no valor da parcela só quando não há boleto emitido carregado (sem perder clientes).
-- A deduplicação por telefone prioriza o boleto que TEM emitido.
-- Mantém as MESMAS colunas/ordem → CREATE OR REPLACE não quebra dependentes.

CREATE OR REPLACE VIEW public.vw_clientes_boletos AS
WITH sienge AS (
  SELECT DISTINCT ON (sb.phone_norm)
    sb.phone_norm,
    'sienge'::text AS source,
    sb.customer_name,
    sb.customer_phone,
    sb.empreendimento,
    sb.parcela_descricao AS parcela,
    COALESCE(be.vencimento, sb.due_date) AS due_date,
    COALESCE(be.valor, sb.amount)        AS amount,        -- valor do BOLETO quando existe
    be.linha_digitavel                   AS link_boleto,   -- linha digitável do banco
    sb.receivable_bill_id,
    sb.installment_id,
    sb.quadra,
    sb.lote
  FROM public.sienge_boletos sb
  LEFT JOIN public.boletos_emitidos be
    ON be.client_id = sb.customer_id
   AND be.vencimento = sb.due_date
   AND lower(COALESCE(be.status, 'aberto')) = 'aberto'
  WHERE lower(TRIM(BOTH FROM sb.status)) = 'aberto'
    AND sb.phone_norm IS NOT NULL
  ORDER BY sb.phone_norm, (be.id IS NULL), sb.due_date   -- prioriza o que tem boleto emitido
), sgl AS (
  SELECT DISTINCT ON (mensagens_cobranca.phone_norm) mensagens_cobranca.phone_norm,
    'sgl'::text AS source,
    mensagens_cobranca.pessoanomecompleto AS customer_name,
    mensagens_cobranca.phone AS customer_phone,
    mensagens_cobranca.unidadeempreendimento AS empreendimento,
    mensagens_cobranca.contasreceberparcela AS parcela,
    mensagens_cobranca.contasrecebervencimento AS due_date,
    CASE
      WHEN (replace(replace(COALESCE(mensagens_cobranca.contasrecebervalor, ''::text), '.'::text, ''::text), ','::text, '.'::text) ~ '^\d+(\.\d+)?$'::text)
        THEN (replace(replace(mensagens_cobranca.contasrecebervalor, '.'::text, ''::text), ','::text, '.'::text))::numeric
      ELSE NULL::numeric
    END AS amount,
    mensagens_cobranca.linkboleto AS link_boleto,
    NULL::integer AS receivable_bill_id,
    NULL::integer AS installment_id,
    mensagens_cobranca.unidadequadraandar AS quadra,
    mensagens_cobranca.unidadeloteapartamento AS lote
  FROM mensagens_cobranca
  WHERE (mensagens_cobranca.phone_norm IS NOT NULL)
  ORDER BY mensagens_cobranca.phone_norm, mensagens_cobranca.contasrecebervencimento DESC NULLS LAST
)
SELECT sienge.phone_norm, sienge.source, sienge.customer_name, sienge.customer_phone,
       sienge.empreendimento, sienge.parcela, sienge.due_date, sienge.amount,
       sienge.link_boleto, sienge.receivable_bill_id, sienge.installment_id,
       sienge.quadra, sienge.lote
  FROM sienge
UNION ALL
SELECT s.phone_norm, s.source, s.customer_name, s.customer_phone,
       s.empreendimento, s.parcela, s.due_date, s.amount,
       s.link_boleto, s.receivable_bill_id, s.installment_id,
       s.quadra, s.lote
  FROM sgl s
  WHERE NOT (EXISTS (SELECT 1 FROM sienge si WHERE si.phone_norm = s.phone_norm));
