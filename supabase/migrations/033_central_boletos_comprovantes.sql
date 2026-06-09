-- 033_central_boletos_comprovantes.sql
-- Central de Clientes: separa BOLETOS (boletos_emitidos) das PARCELAS (sienge/SGL),
-- + histórico de comprovantes consultável.

-- 1) paid_at em boletos_emitidos (faltava — torna o updateBoletoDB seguro e mostra a baixa)
ALTER TABLE public.boletos_emitidos ADD COLUMN IF NOT EXISTS paid_at timestamptz;

-- 2) vw_boletos_central: boleto emitido + status/cadastro do Sienge (por client_id+vencimento)
DROP VIEW IF EXISTS public.vw_boletos_central;
CREATE VIEW public.vw_boletos_central
WITH (security_invoker = true) AS
SELECT DISTINCT ON (be.id)
  be.id                       AS emitido_id,
  be.phone_norm,
  be.client_id,
  be.customer_name,
  be.vencimento               AS due_date,
  be.valor                    AS amount,
  be.linha_digitavel,
  be.pdf_path,
  be.lote,
  be.created_at,
  sb.empreendimento,
  sb.quadra,
  sb.lote                     AS unidade_lote,
  sb.parcela_descricao,
  COALESCE(be.paid_at, sb.paid_at) AS paid_at,
  CASE
    WHEN lower(coalesce(be.status,'')) = 'pago'
      OR lower(trim(coalesce(sb.status,''))) = 'pago'
      OR be.paid_at IS NOT NULL OR sb.paid_at IS NOT NULL THEN 'pago'
    WHEN lower(coalesce(be.status,'')) = 'comprovante_recebido' THEN 'comprovante_recebido'
    WHEN lower(coalesce(be.status,'')) = 'cancelado' THEN 'cancelado'
    ELSE 'aberto'
  END AS status
FROM public.boletos_emitidos be
LEFT JOIN public.sienge_boletos sb
  ON sb.customer_id = be.client_id AND sb.due_date = be.vencimento
WHERE be.phone_norm IS NOT NULL
ORDER BY be.id, sb.due_date NULLS LAST;

GRANT SELECT ON public.vw_boletos_central TO authenticated, service_role;

-- 3) vw_comprovantes: comprovantes enviados (chat_messages analisados) por telefone
DROP VIEW IF EXISTS public.vw_comprovantes;
CREATE VIEW public.vw_comprovantes
WITH (security_invoker = true) AS
SELECT
  public.normalize_phone(ct.wa_id) AS phone_norm,
  m.id                AS message_id,
  m.conversation_id,
  m.created_at,
  m.type,
  m.media_url,
  m.media_filename,
  (m.ai_analysis->>'verdict')       AS verdict,
  (m.ai_analysis->>'sienge_status') AS sienge_status
FROM public.chat_messages m
JOIN public.chat_conversations cv ON cv.id = m.conversation_id
JOIN public.chat_contacts ct      ON ct.id = cv.contact_id
WHERE m.direction = 'in'
  AND m.type IN ('image','document')
  AND m.ai_analysis ? 'verdict'
  AND coalesce(m.ai_analysis->>'nao_comprovante','') <> 'true';

GRANT SELECT ON public.vw_comprovantes TO authenticated, service_role;
