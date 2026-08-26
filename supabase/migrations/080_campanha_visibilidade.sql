-- 080_campanha_visibilidade.sql
-- Quem pode acompanhar cada campanha.
--
-- Até aqui a aba Campanhas era fechada para admin/gerente e a proteção existia
-- só na TELA: as rotas /api/campaigns/* conferiam apenas se havia sessão, e a
-- RLS da tabela liberava qualquer autenticado. Agora:
--   • cada campanha lista os atendentes liberados (visivel_para);
--   • a RLS passa a ser a fonte da verdade da leitura;
--   • escrita fica restrita a admin/gerente (o disparo continua sendo deles).
-- Quem for liberado acompanha e pode reenviar falhas — nada mais (a rota de
-- retry aplica essa regra; as demais exigem admin/gerente).

ALTER TABLE public.chat_campaigns
  ADD COLUMN IF NOT EXISTS visivel_para uuid[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.chat_campaigns.visivel_para IS
  'Atendentes (chat_attendants.id) liberados para ACOMPANHAR esta campanha e '
  'reenviar falhas. Admin/gerente veem todas independentemente desta lista.';

CREATE INDEX IF NOT EXISTS idx_chat_campaigns_visivel
  ON public.chat_campaigns USING gin (visivel_para);

-- ── RLS: leitura por liberação, escrita só para supervisor ───────────────────
DO $$
DECLARE t text; p text;
BEGIN
  FOREACH t IN ARRAY ARRAY['chat_campaigns','chat_campaign_recipients'] LOOP
    FOREACH p IN ARRAY ARRAY['auth_select','auth_insert','auth_update','auth_delete'] LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', p, t);
    END LOOP;
  END LOOP;
END $$;

CREATE POLICY "campanha visivel por liberacao" ON public.chat_campaigns
  FOR SELECT TO authenticated
  USING (public.is_supervisor() OR auth.uid() = ANY (visivel_para));

CREATE POLICY "campanha escrita supervisor" ON public.chat_campaigns
  FOR ALL TO authenticated
  USING (public.is_supervisor()) WITH CHECK (public.is_supervisor());

-- Destinatários seguem a visibilidade da campanha (a tela de detalhe os lê).
CREATE POLICY "destinatario segue campanha" ON public.chat_campaign_recipients
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.chat_campaigns c
    WHERE c.id = campaign_id
      AND (public.is_supervisor() OR auth.uid() = ANY (c.visivel_para))));

CREATE POLICY "destinatario escrita supervisor" ON public.chat_campaign_recipients
  FOR ALL TO authenticated
  USING (public.is_supervisor()) WITH CHECK (public.is_supervisor());

-- ── Nome da campanha no chat ────────────────────────────────────────────────
-- A conversa mostra "Campanha: X" nas mensagens de template, e QUALQUER atendente
-- que atende aquela conversa precisa desse rótulo — mas ele não deve, por isso,
-- enxergar a campanha inteira. Esta função devolve só id+nome.
CREATE OR REPLACE FUNCTION public.campanha_nomes(_ids uuid[])
RETURNS TABLE (id uuid, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id, c.name FROM public.chat_campaigns c WHERE c.id = ANY(_ids)
$$;

GRANT EXECUTE ON FUNCTION public.campanha_nomes(uuid[]) TO authenticated;
