-- 060_inbox_membership_visibilidade.sql
-- Visibilidade por caixa de entrada + proprietário de campanha.
--   • chat_attendant_inboxes: vínculo usuário↔inbox (multi).
--   • chat_campaigns.owner_id: proprietário dos disparos (obrigatório na aplicação).
--   • RLS: agent vê, das caixas vinculadas, as conversas DELE + as SEM dono;
--     admin/manager veem tudo (is_supervisor()). Edges/rotas server usam
--     service role e não são afetados.
-- ATENÇÃO: a policy antiga "authenticated manage conversations" era FOR ALL
-- (inclui SELECT) — precisa ser dividida, senão a restrição não vale.

-- ── 1. Vínculo usuário ↔ caixa de entrada ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.chat_attendant_inboxes (
  attendant_id uuid NOT NULL REFERENCES public.chat_attendants(id) ON DELETE CASCADE,
  inbox_id     uuid NOT NULL REFERENCES public.chat_inboxes(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (attendant_id, inbox_id)
);
ALTER TABLE public.chat_attendant_inboxes ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "authenticated read attendant_inboxes"
    ON public.chat_attendant_inboxes FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Backfill: agents ativos vinculados a todas as inboxes ativas (preserva o
-- comportamento atual; o admin ajusta os vínculos depois).
INSERT INTO public.chat_attendant_inboxes (attendant_id, inbox_id)
SELECT a.id, i.id
FROM public.chat_attendants a CROSS JOIN public.chat_inboxes i
WHERE a.role = 'agent' AND a.deleted_at IS NULL AND a.is_active AND i.is_active
ON CONFLICT DO NOTHING;

-- ── 2. Proprietário da campanha ───────────────────────────────────────────────
ALTER TABLE public.chat_campaigns
  ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES public.chat_attendants(id);

-- ── 3. Helper: admin/manager enxergam tudo ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_supervisor() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM chat_attendants a
    WHERE a.id = auth.uid() AND a.role IN ('admin','manager')
      AND a.deleted_at IS NULL AND a.is_active
  )
$$;

-- ── 4. RLS de conversas/mensagens ─────────────────────────────────────────────
DROP POLICY IF EXISTS "authenticated read conversations"   ON public.chat_conversations;
DROP POLICY IF EXISTS "authenticated manage conversations" ON public.chat_conversations;

DO $$ BEGIN
  CREATE POLICY "conversas visiveis por vinculo"
    ON public.chat_conversations FOR SELECT TO authenticated
    USING (
      public.is_supervisor()
      OR (
        inbox_id IN (SELECT inbox_id FROM public.chat_attendant_inboxes WHERE attendant_id = auth.uid())
        AND (assignee_id IS NULL OR assignee_id = auth.uid())
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "authenticated insert conversations"
    ON public.chat_conversations FOR INSERT TO authenticated WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "authenticated update conversations"
    ON public.chat_conversations FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "authenticated delete conversations"
    ON public.chat_conversations FOR DELETE TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DROP POLICY IF EXISTS "authenticated read messages" ON public.chat_messages;
DO $$ BEGIN
  CREATE POLICY "mensagens visiveis pela conversa"
    ON public.chat_messages FOR SELECT TO authenticated
    USING ( EXISTS (SELECT 1 FROM public.chat_conversations c WHERE c.id = chat_messages.conversation_id) );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
