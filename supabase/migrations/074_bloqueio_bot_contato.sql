-- ─────────────────────────────────────────────────────────────────────────────
-- 074 — Lista negra do bot: contato bloqueado não recebe resposta da IA
--
-- Não havia como calar a IA para um número específico. O único recurso era
-- handled_by='human' na conversa — que NÃO serve como bloqueio: o
-- auto-return-bot devolve para o bot sozinho depois de algumas horas, e
-- "Resolver"/"Arquivar" também forçam handled_by='bot'. Qualquer tentativa de
-- silenciar o bot hoje se desfaz sozinha.
--
-- Casos reais: cliente que pediu para não falar com robô, caso jurídico, número
-- interno/de teste, contato que dispara loop.
--
-- O bloqueio mora no CONTATO (chat_contacts.wa_id é único global), então vale
-- para qualquer conversa daquele número, em qualquer caixa de entrada — e
-- sobrevive a resolver/arquivar.
--
-- ESCOPO É SÓ A IA. Régua de cobrança, lembretes e campanhas continuam enviando
-- normalmente; quem quer parar cobrança usa distrato (068/069) ou o interruptor
-- da campanha (073). A mensagem do cliente continua sendo salva e aparece na
-- lista para atendimento humano — só a RESPOSTA automática morre.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.chat_contacts
  ADD COLUMN IF NOT EXISTS bot_bloqueado     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bot_bloqueado_em  timestamptz,
  ADD COLUMN IF NOT EXISTS bot_bloqueado_por uuid REFERENCES public.chat_attendants(id);

COMMENT ON COLUMN public.chat_contacts.bot_bloqueado IS
  'true = o ai-responder nunca responde a este contato (lista negra do bot). '
  'NÃO afeta régua de cobrança, lembretes nem campanhas — só a IA.';
COMMENT ON COLUMN public.chat_contacts.bot_bloqueado_em IS
  'Quando o bloqueio foi ligado. Preenchido por trigger; NULL quando desbloqueado.';
COMMENT ON COLUMN public.chat_contacts.bot_bloqueado_por IS
  'Atendente que ligou o bloqueio. Preenchido por trigger a partir de auth.uid(); '
  'NULL quando desbloqueado.';

-- Listar "quem está bloqueado" sem varrer a tabela inteira.
CREATE INDEX IF NOT EXISTS idx_chat_contacts_bloqueados
  ON public.chat_contacts (bot_bloqueado_em DESC) WHERE bot_bloqueado;

-- ── Autoria vem do banco, não do browser ────────────────────────────────────
-- O projeto não tem tabela de auditoria, e a policy "authenticated manage
-- contacts" é FOR ALL USING(true): qualquer atendente pode bloquear (é o
-- desejado) — mas também poderia mandar um autor falso no update. O trigger
-- fecha isso e deixa a UI enviar só o boolean.
--
-- O subselect (em vez de auth.uid() direto) evita violar a FK quando o update
-- vier do service role ou de um uid sem linha em chat_attendants.
CREATE OR REPLACE FUNCTION public.chat_contacts_bloqueio_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.bot_bloqueado IS DISTINCT FROM OLD.bot_bloqueado THEN
    IF NEW.bot_bloqueado THEN
      NEW.bot_bloqueado_em  := now();
      NEW.bot_bloqueado_por := (SELECT a.id FROM public.chat_attendants a WHERE a.id = auth.uid());
    ELSE
      NEW.bot_bloqueado_em  := NULL;
      NEW.bot_bloqueado_por := NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.chat_contacts_bloqueio_audit() IS
  'Preenche bot_bloqueado_em/_por quando o bloqueio muda — ver migration 074.';

DROP TRIGGER IF EXISTS trg_chat_contacts_bloqueio_audit ON public.chat_contacts;
CREATE TRIGGER trg_chat_contacts_bloqueio_audit
  BEFORE UPDATE ON public.chat_contacts
  FOR EACH ROW EXECUTE FUNCTION public.chat_contacts_bloqueio_audit();
