-- 047_boleto_empreendimento.sql
-- Empreendimento correto POR BOLETO: o empreendimento vinha do CONTRATO do cliente,
-- errado quando o cliente tem mais de uma unidade/empreendimento (ou o contrato do
-- boleto não está sincronizado). Ex.: Paulo (client 1) contrato "Por do Sol", mas o
-- boleto é "Jardim das Palmeiras". Agora o import grava o Beneficiário do PDF em
-- boletos_emitidos.empreendimento e as views preferem esse valor (fallback contrato/parcela).
-- "Só daqui pra frente": boletos antigos ficam NULL → seguem no fallback (sem backfill).

ALTER TABLE public.boletos_emitidos ADD COLUMN IF NOT EXISTS empreendimento text;

-- 1) vw_boletos_central (detalhe do cliente — seção Boletos)
CREATE OR REPLACE VIEW public.vw_boletos_central AS
 SELECT DISTINCT ON (be.id) be.id AS emitido_id, be.phone_norm, be.client_id, be.customer_name,
    be.vencimento AS due_date, be.valor AS amount, be.linha_digitavel, be.pdf_path, be.lote, be.created_at,
    COALESCE(be.empreendimento, ct.enterprise_name, sb.empreendimento) AS empreendimento,
    COALESCE(NULLIF(regexp_replace(COALESCE(sb.quadra, ''::text), '^\s*quadra\s*'::text, ''::text, 'i'::text), ''::text), "substring"(ct.unidade, 'Quadra\s*(\S+)'::text)) AS quadra,
    COALESCE(NULLIF(regexp_replace(COALESCE(sb.lote, ''::text), '^\s*lote\s*'::text, ''::text, 'i'::text), ''::text), "substring"(ct.unidade, 'Lote\s*(\S+)'::text)) AS unidade_lote,
    sb.parcela_descricao, COALESCE(be.paid_at, sb.paid_at) AS paid_at,
        CASE
            WHEN lower(COALESCE(be.status, ''::text)) = 'pago'::text OR lower(TRIM(BOTH FROM COALESCE(sb.status, ''::character varying))) = 'pago'::text OR be.paid_at IS NOT NULL OR sb.paid_at IS NOT NULL THEN 'pago'::text
            WHEN lower(COALESCE(be.status, ''::text)) = 'comprovante_recebido'::text THEN 'comprovante_recebido'::text
            WHEN lower(COALESCE(be.status, ''::text)) = 'cancelado'::text THEN 'cancelado'::text
            ELSE 'aberto'::text
        END AS status
   FROM boletos_emitidos be
     LEFT JOIN sienge_boletos sb ON sb.customer_id = be.client_id AND sb.due_date = be.vencimento
     LEFT JOIN vw_cliente_contrato ct ON ct.client_id = be.client_id
  WHERE be.phone_norm IS NOT NULL
  ORDER BY be.id, sb.due_date;

-- 2) vw_cobranca_boletos (régua) — mantém load_dispatch_date (migration 043)
CREATE OR REPLACE VIEW public.vw_cobranca_boletos
WITH (security_invoker = true) AS
SELECT DISTINCT ON (be.id)
  be.phone_norm, 'sienge'::text AS source, be.customer_name, be.telefone AS customer_phone,
  COALESCE(be.empreendimento, ct.enterprise_name, sb.empreendimento) AS empreendimento,
  COALESCE(NULLIF(regexp_replace(COALESCE(sb.quadra, ''), '^\s*quadra\s*', '', 'i'), ''), substring(ct.unidade FROM 'Quadra\s*(\S+)')) AS quadra,
  COALESCE(NULLIF(regexp_replace(COALESCE(sb.lote, ''), '^\s*lote\s*', '', 'i'), ''), substring(ct.unidade FROM 'Lote\s*(\S+)')) AS lote,
  COALESCE(sb.parcela_descricao, '') AS parcela,
  be.vencimento AS due_date, be.valor AS amount, be.linha_digitavel AS link_boleto,
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

-- 3) vw_clientes_boletos (campanhas + alimenta a Central) — sienge prefere be.empreendimento
CREATE OR REPLACE VIEW public.vw_clientes_boletos AS
 WITH sienge AS (
         SELECT DISTINCT ON (sb.phone_norm) sb.phone_norm, 'sienge'::text AS source, sb.customer_name, sb.customer_phone,
            COALESCE(be.empreendimento, sb.empreendimento) AS empreendimento, sb.parcela_descricao AS parcela,
            COALESCE(be.vencimento, sb.due_date) AS due_date, COALESCE(be.valor, sb.amount) AS amount,
            be.linha_digitavel AS link_boleto, sb.receivable_bill_id, sb.installment_id, sb.quadra, sb.lote
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

-- 4) vw_central_clientes — coluna empreendimento passa a preferir a do boleto
CREATE OR REPLACE VIEW public.vw_central_clientes AS
 WITH phones AS (
         SELECT u.phone_norm
           FROM ( SELECT normalize_phone(chat_contacts.wa_id) AS phone_norm FROM chat_contacts
                UNION SELECT sienge_clientes.phone_norm FROM sienge_clientes WHERE sienge_clientes.phone_norm IS NOT NULL
                UNION SELECT mensagens_cobranca.phone_norm FROM mensagens_cobranca WHERE mensagens_cobranca.phone_norm IS NOT NULL) u
          WHERE u.phone_norm IS NOT NULL AND u.phone_norm <> ''::text
        ), contato AS (
         SELECT DISTINCT ON ((normalize_phone(chat_contacts.wa_id))) normalize_phone(chat_contacts.wa_id) AS phone_norm,
            chat_contacts.id AS contact_id, chat_contacts.name, chat_contacts.wa_id, chat_contacts.profile_picture_url
           FROM chat_contacts WHERE normalize_phone(chat_contacts.wa_id) IS NOT NULL
          ORDER BY (normalize_phone(chat_contacts.wa_id)), chat_contacts.created_at
        ), sienge AS (
         SELECT DISTINCT ON (sienge_clientes.phone_norm) sienge_clientes.phone_norm,
            sienge_clientes.client_id, sienge_clientes.nome, sienge_clientes.cpf, sienge_clientes.telefone, sienge_clientes.email
           FROM sienge_clientes WHERE sienge_clientes.phone_norm IS NOT NULL
          ORDER BY sienge_clientes.phone_norm, sienge_clientes.updated_at DESC NULLS LAST
        ), conv AS (
         SELECT normalize_phone(cc.wa_id) AS phone_norm, bool_or(co.status = 'open'::text) AS conversa_aberta,
            count(DISTINCT co.id) AS conversas, max(co.last_message_at) AS last_message_at,
            (array_agg(co.id ORDER BY co.last_message_at DESC NULLS LAST))[1] AS conversation_id
           FROM chat_contacts cc JOIN chat_conversations co ON co.contact_id = cc.id GROUP BY (normalize_phone(cc.wa_id))
        ), msgs AS (
         SELECT normalize_phone(cc.wa_id) AS phone_norm,
            count(*) FILTER (WHERE m.direction = 'out'::text) AS msgs_enviadas, count(*) AS msgs_total
           FROM chat_contacts cc JOIN chat_conversations co ON co.contact_id = cc.id JOIN chat_messages m ON m.conversation_id = co.id
          GROUP BY (normalize_phone(cc.wa_id))
        ), boleto AS (
         SELECT vw_clientes_boletos.phone_norm, vw_clientes_boletos.source AS boleto_source,
            vw_clientes_boletos.customer_name AS boleto_nome, vw_clientes_boletos.due_date AS proximo_venc,
            vw_clientes_boletos.amount AS boleto_valor, vw_clientes_boletos.empreendimento AS boleto_empreendimento
           FROM vw_clientes_boletos
        ), sgl AS (
         SELECT mensagens_cobranca.phone_norm, max(mensagens_cobranca.pessoanomecompleto) AS sgl_nome, count(*) AS sgl_registros,
            max(mensagens_cobranca.app_dispatched_at) AS ultima_sgl, count(*) FILTER (WHERE mensagens_cobranca.app_dispatched_at IS NOT NULL) AS sgl_enviadas
           FROM mensagens_cobranca WHERE mensagens_cobranca.phone_norm IS NOT NULL GROUP BY mensagens_cobranca.phone_norm
        ), regua AS (
         SELECT cobranca_regua_log.phone_norm, max(cobranca_regua_log.run_date) AS ultima_regua, count(*) AS regua_envios
           FROM cobranca_regua_log GROUP BY cobranca_regua_log.phone_norm
        ), camp AS (
         SELECT normalize_phone(chat_campaign_recipients.wa_id) AS phone_norm,
            count(*) FILTER (WHERE chat_campaign_recipients.status = ANY (ARRAY['sent'::text,'delivered'::text,'read'::text])) AS camp_enviadas,
            max(chat_campaign_recipients.sent_at) AS ultima_camp
           FROM chat_campaign_recipients GROUP BY (normalize_phone(chat_campaign_recipients.wa_id))
        ), pago AS (
         SELECT x.phone_norm, max(x.paid_at) AS ultimo_pago FROM (
                SELECT phone_norm, paid_at FROM boletos_emitidos WHERE lower(COALESCE(status,'')) = 'pago' AND paid_at IS NOT NULL
                UNION ALL SELECT phone_norm, paid_at FROM sienge_boletos WHERE lower(COALESCE(status,'')) = 'pago' AND paid_at IS NOT NULL
              ) x WHERE x.phone_norm IS NOT NULL GROUP BY x.phone_norm
        ), em AS (
         SELECT phone_norm,
            bool_or(lower(COALESCE(status,'aberto')) = 'aberto') AS tem_aberto,
            bool_or(lower(COALESCE(status,'aberto')) = 'aberto' AND vencimento < (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date) AS vencido
           FROM boletos_emitidos WHERE phone_norm IS NOT NULL GROUP BY phone_norm
        )
 SELECT p.phone_norm,
    COALESCE(s.nome, ct.name, sg.sgl_nome, b.boleto_nome::text) AS nome,
    s.cpf, COALESCE(s.telefone, ct.wa_id) AS telefone, ct.contact_id, ct.profile_picture_url,
        CASE WHEN s.phone_norm IS NOT NULL AND sg.phone_norm IS NOT NULL THEN 'ambos'::text
            WHEN s.phone_norm IS NOT NULL THEN 'sienge'::text
            WHEN sg.phone_norm IS NOT NULL THEN 'sgl'::text ELSE 'contato'::text END AS origem,
    s.phone_norm IS NOT NULL AS is_sienge, sg.phone_norm IS NOT NULL AS is_sgl,
    COALESCE(cv.conversa_aberta, false) AS conversa_aberta, cv.conversation_id,
    COALESCE(cv.conversas, 0::bigint) AS conversas, cv.last_message_at,
    COALESCE(mg.msgs_enviadas, 0::bigint) AS msgs_enviadas, COALESCE(mg.msgs_total, 0::bigint) AS msgs_total,
    b.phone_norm IS NOT NULL AS tem_boleto, b.boleto_source, b.proximo_venc, b.boleto_valor,
    b.proximo_venc IS NOT NULL AND b.proximo_venc < (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date AS boleto_vencido,
    GREATEST(rg.ultima_regua::timestamp with time zone, sg.ultima_sgl, cp.ultima_camp) AS ultima_cobranca,
    COALESCE(rg.regua_envios, 0::bigint) + COALESCE(sg.sgl_enviadas, 0::bigint) + COALESCE(cp.camp_enviadas, 0::bigint) AS total_cobrancas,
    (COALESCE(rg.regua_envios, 0::bigint) + COALESCE(sg.sgl_enviadas, 0::bigint) + COALESCE(cp.camp_enviadas, 0::bigint)) > 0 AS ja_cobrado,
    GREATEST(cv.last_message_at, rg.ultima_regua::timestamp with time zone, sg.ultima_sgl, cp.ultima_camp) AS ultima_atividade,
    s.email, cc2.situation AS contrato_situacao,
    CASE
        WHEN (b.proximo_venc < (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date) OR em.vencido THEN 'vencido'::text
        WHEN (b.phone_norm IS NOT NULL OR em.tem_aberto)
             AND (COALESCE(rg.regua_envios,0) + COALESCE(sg.sgl_enviadas,0) + COALESCE(cp.camp_enviadas,0)) > 0 THEN 'enviado'::text
        WHEN (b.phone_norm IS NOT NULL OR em.tem_aberto) THEN 'a_enviar'::text
        WHEN pg.ultimo_pago IS NOT NULL AND pg.ultimo_pago >= (now() - interval '40 days') THEN 'pago'::text
        ELSE 'sem_boleto'::text
    END AS boleto_status,
    COALESCE(b.boleto_empreendimento, cc2.enterprise_name) AS empreendimento
   FROM phones p
     LEFT JOIN contato ct ON ct.phone_norm = p.phone_norm
     LEFT JOIN sienge s ON s.phone_norm = p.phone_norm
     LEFT JOIN conv cv ON cv.phone_norm = p.phone_norm
     LEFT JOIN msgs mg ON mg.phone_norm = p.phone_norm
     LEFT JOIN boleto b ON b.phone_norm = p.phone_norm
     LEFT JOIN sgl sg ON sg.phone_norm = p.phone_norm
     LEFT JOIN regua rg ON rg.phone_norm = p.phone_norm
     LEFT JOIN camp cp ON cp.phone_norm = p.phone_norm
     LEFT JOIN pago pg ON pg.phone_norm = p.phone_norm
     LEFT JOIN em ON em.phone_norm = p.phone_norm
     LEFT JOIN vw_cliente_contrato cc2 ON cc2.client_id = s.client_id;
