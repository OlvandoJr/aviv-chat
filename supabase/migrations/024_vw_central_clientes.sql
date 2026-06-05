-- 024_vw_central_clientes.sql
-- Central de Clientes (Customer 360): 1 linha por phone_norm, união de
-- Sienge + SGL + contatos WhatsApp. Agrega identidade, origem, conversa,
-- mensagens, boleto (resumo), cobrança enviada e última atividade.
CREATE OR REPLACE VIEW public.vw_central_clientes
WITH (security_invoker = true) AS
WITH phones AS (
  SELECT phone_norm FROM (
    SELECT normalize_phone(wa_id) AS phone_norm FROM public.chat_contacts
    UNION
    SELECT phone_norm FROM public.sienge_clientes WHERE phone_norm IS NOT NULL
    UNION
    SELECT phone_norm FROM public.mensagens_cobranca WHERE phone_norm IS NOT NULL
  ) u WHERE phone_norm IS NOT NULL AND phone_norm <> ''
),
contato AS (
  SELECT DISTINCT ON (normalize_phone(wa_id))
    normalize_phone(wa_id) AS phone_norm, id AS contact_id, name, wa_id, profile_picture_url
  FROM public.chat_contacts
  WHERE normalize_phone(wa_id) IS NOT NULL
  ORDER BY normalize_phone(wa_id), created_at
),
sienge AS (
  SELECT DISTINCT ON (phone_norm) phone_norm, nome, cpf, telefone
  FROM public.sienge_clientes WHERE phone_norm IS NOT NULL
  ORDER BY phone_norm, updated_at DESC NULLS LAST
),
conv AS (
  SELECT normalize_phone(cc.wa_id) AS phone_norm,
    bool_or(co.status = 'open') AS conversa_aberta,
    count(DISTINCT co.id) AS conversas,
    max(co.last_message_at) AS last_message_at,
    (array_agg(co.id ORDER BY co.last_message_at DESC NULLS LAST))[1] AS conversation_id
  FROM public.chat_contacts cc
  JOIN public.chat_conversations co ON co.contact_id = cc.id
  GROUP BY normalize_phone(cc.wa_id)
),
msgs AS (
  SELECT normalize_phone(cc.wa_id) AS phone_norm,
    count(*) FILTER (WHERE m.direction = 'out') AS msgs_enviadas,
    count(*) AS msgs_total
  FROM public.chat_contacts cc
  JOIN public.chat_conversations co ON co.contact_id = cc.id
  JOIN public.chat_messages m ON m.conversation_id = co.id
  GROUP BY normalize_phone(cc.wa_id)
),
boleto AS (
  SELECT phone_norm, source AS boleto_source, customer_name AS boleto_nome,
         due_date AS proximo_venc, amount AS boleto_valor
  FROM public.vw_clientes_boletos
),
sgl AS (
  SELECT phone_norm, max(pessoanomecompleto) AS sgl_nome, count(*) AS sgl_registros,
    max(app_dispatched_at) AS ultima_sgl,
    count(*) FILTER (WHERE app_dispatched_at IS NOT NULL) AS sgl_enviadas
  FROM public.mensagens_cobranca WHERE phone_norm IS NOT NULL
  GROUP BY phone_norm
),
regua AS (
  SELECT phone_norm, max(run_date) AS ultima_regua, count(*) AS regua_envios
  FROM public.cobranca_regua_log GROUP BY phone_norm
),
camp AS (
  SELECT normalize_phone(wa_id) AS phone_norm,
    count(*) FILTER (WHERE status IN ('sent','delivered','read')) AS camp_enviadas,
    max(sent_at) AS ultima_camp
  FROM public.chat_campaign_recipients GROUP BY normalize_phone(wa_id)
)
SELECT
  p.phone_norm,
  coalesce(s.nome, ct.name, sg.sgl_nome, b.boleto_nome) AS nome,
  s.cpf,
  coalesce(s.telefone, ct.wa_id) AS telefone,
  ct.contact_id,
  ct.profile_picture_url,
  CASE
    WHEN s.phone_norm IS NOT NULL AND sg.phone_norm IS NOT NULL THEN 'ambos'
    WHEN s.phone_norm IS NOT NULL THEN 'sienge'
    WHEN sg.phone_norm IS NOT NULL THEN 'sgl'
    ELSE 'contato'
  END AS origem,
  (s.phone_norm IS NOT NULL) AS is_sienge,
  (sg.phone_norm IS NOT NULL) AS is_sgl,
  coalesce(cv.conversa_aberta, false) AS conversa_aberta,
  cv.conversation_id,
  coalesce(cv.conversas, 0) AS conversas,
  cv.last_message_at,
  coalesce(mg.msgs_enviadas, 0) AS msgs_enviadas,
  coalesce(mg.msgs_total, 0) AS msgs_total,
  (b.phone_norm IS NOT NULL) AS tem_boleto,
  b.boleto_source,
  b.proximo_venc,
  b.boleto_valor,
  (b.proximo_venc IS NOT NULL AND b.proximo_venc < (now() AT TIME ZONE 'America/Sao_Paulo')::date) AS boleto_vencido,
  greatest(rg.ultima_regua::timestamptz, sg.ultima_sgl, cp.ultima_camp) AS ultima_cobranca,
  (coalesce(rg.regua_envios,0) + coalesce(sg.sgl_enviadas,0) + coalesce(cp.camp_enviadas,0)) AS total_cobrancas,
  (coalesce(rg.regua_envios,0) + coalesce(sg.sgl_enviadas,0) + coalesce(cp.camp_enviadas,0)) > 0 AS ja_cobrado,
  greatest(cv.last_message_at, rg.ultima_regua::timestamptz, sg.ultima_sgl, cp.ultima_camp) AS ultima_atividade
FROM phones p
LEFT JOIN contato ct ON ct.phone_norm = p.phone_norm
LEFT JOIN sienge  s  ON s.phone_norm  = p.phone_norm
LEFT JOIN conv    cv ON cv.phone_norm = p.phone_norm
LEFT JOIN msgs    mg ON mg.phone_norm = p.phone_norm
LEFT JOIN boleto  b  ON b.phone_norm  = p.phone_norm
LEFT JOIN sgl     sg ON sg.phone_norm = p.phone_norm
LEFT JOIN regua   rg ON rg.phone_norm = p.phone_norm
LEFT JOIN camp    cp ON cp.phone_norm = p.phone_norm;

GRANT SELECT ON public.vw_central_clientes TO authenticated, service_role;
