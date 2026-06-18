-- 046_central_clientes_empreendimento.sql
-- vw_central_clientes ganha a coluna `empreendimento` (ao final, p/ CREATE OR REPLACE),
-- vinda do contrato Sienge (vw_cliente_contrato.enterprise_name — join já existente).

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
            vw_clientes_boletos.customer_name AS boleto_nome, vw_clientes_boletos.due_date AS proximo_venc, vw_clientes_boletos.amount AS boleto_valor
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
    cc2.enterprise_name AS empreendimento
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
