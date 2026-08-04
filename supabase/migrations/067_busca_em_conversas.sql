-- ─────────────────────────────────────────────────────────────────────────────
-- 067 — Busca DENTRO das conversas (conteúdo das mensagens), além de nome/telefone
--
-- Problema: o nome do WhatsApp raramente é o nome do cadastro ("suflair" =
-- ALESANDRO APARECIDO DE OLIVEIRA, "🤪" = ALINE TRINDADE ARRUDA SOARES). Buscando
-- só por contato, o atendente não achava a conversa pelo nome completo do cliente
-- — que ESTÁ no texto dos templates de boleto que enviamos.
--
-- Solução: função de busca que varre nome, telefone e o CONTEÚDO das mensagens,
-- devolvendo o trecho que casou. SECURITY INVOKER (padrão) → a RLS do usuário
-- continua valendo: ninguém passa a ver conversa que já não podia ver.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Índices trigram: tornam ILIKE '%termo%' rápido (sem eles seria varredura total).
CREATE INDEX IF NOT EXISTS idx_chat_messages_content_trgm
  ON public.chat_messages USING gin (content gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_chat_contacts_name_trgm
  ON public.chat_contacts USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_chat_contacts_wa_id_trgm
  ON public.chat_contacts USING gin (wa_id gin_trgm_ops);

DROP FUNCTION IF EXISTS public.search_conversations(text, int);

CREATE FUNCTION public.search_conversations(_q text, _limit int DEFAULT 50)
RETURNS TABLE (
  conversation_id uuid,
  match_kind      text,   -- 'nome' | 'telefone' | 'mensagem'
  match_snippet   text,   -- trecho da mensagem que casou (para o atendente entender o motivo)
  match_at        timestamptz
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH q AS (
    -- Só dígitos: se o usuário digitou um telefone, casamos por número também.
    SELECT btrim(_q) AS termo, nullif(regexp_replace(coalesce(_q, ''), '\D', '', 'g'), '') AS digitos
  ),
  -- 1) Contato (nome ou telefone) — o comportamento que já existia.
  por_contato AS (
    SELECT c.id AS conversation_id,
           CASE WHEN ct.name ILIKE '%' || (SELECT termo FROM q) || '%' THEN 'nome' ELSE 'telefone' END AS match_kind,
           NULL::text AS match_snippet,
           c.last_message_at AS match_at
    FROM chat_conversations c
    JOIN chat_contacts ct ON ct.id = c.contact_id
    WHERE (SELECT termo FROM q) <> ''
      AND (
        ct.name ILIKE '%' || (SELECT termo FROM q) || '%'
        OR ((SELECT digitos FROM q) IS NOT NULL AND ct.wa_id ILIKE '%' || (SELECT digitos FROM q) || '%')
      )
  ),
  -- 2) Conteúdo das mensagens — acha o cliente pelo nome completo do boleto,
  -- por um valor, uma parcela, um trecho do que foi conversado…
  por_mensagem AS (
    SELECT DISTINCT ON (m.conversation_id)
           m.conversation_id,
           'mensagem'::text AS match_kind,
           -- trecho ao redor do termo (até ~90 chars), com reticências
           CASE
             WHEN length(m.content) <= 110 THEN m.content
             ELSE '…' || substr(
                    m.content,
                    greatest(1, position(lower((SELECT termo FROM q)) in lower(m.content)) - 35),
                    110
                  ) || '…'
           END AS match_snippet,
           m.created_at AS match_at
    FROM chat_messages m
    WHERE (SELECT termo FROM q) <> ''
      AND m.content ILIKE '%' || (SELECT termo FROM q) || '%'
    ORDER BY m.conversation_id, m.created_at DESC
  ),
  unidos AS (
    SELECT * FROM por_contato
    UNION ALL
    SELECT * FROM por_mensagem
  )
  -- Uma linha por conversa: o contato tem prioridade (match mais forte que o texto).
  SELECT DISTINCT ON (u.conversation_id)
         u.conversation_id, u.match_kind, u.match_snippet, u.match_at
  FROM unidos u
  ORDER BY u.conversation_id,
           CASE u.match_kind WHEN 'nome' THEN 1 WHEN 'telefone' THEN 2 ELSE 3 END,
           u.match_at DESC NULLS LAST
  LIMIT _limit;
$$;

COMMENT ON FUNCTION public.search_conversations(text, int) IS
  'Busca conversas por nome do contato, telefone OU conteúdo das mensagens. '
  'Respeita a RLS do usuário (SECURITY INVOKER). Devolve o trecho que casou.';

GRANT EXECUTE ON FUNCTION public.search_conversations(text, int) TO authenticated;
