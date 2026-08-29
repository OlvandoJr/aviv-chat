-- 082_meta_signup_log.sql
-- Jornada do Cadastro Incorporado (Embedded Signup) da Meta.
--
-- O popup da Meta reporta a sessão por postMessage (WA_EMBEDDED_SIGNUP):
-- FINISH / FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING (coexistência) concluem;
-- CANCEL traz current_step (a TELA em que a pessoa desistiu) e ERROR traz
-- error_message. Sem registrar isso, "não consegui conectar" vira chute —
-- com o log, o suporte sabe exatamente onde travou.

CREATE TABLE IF NOT EXISTS public.meta_signup_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evento       text NOT NULL,           -- finish | finish_coexistence | cancel | error | backend_ok | backend_erro
  dados        jsonb,                   -- current_step, error_message, waba_id/phone_number_id...
  attendant_id uuid REFERENCES public.chat_attendants(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_meta_signup_log_created ON public.meta_signup_log (created_at DESC);

ALTER TABLE public.meta_signup_log ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "authenticated read signup log" ON public.meta_signup_log
    FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Escrita só via rota (service role): o browser não insere direto.
