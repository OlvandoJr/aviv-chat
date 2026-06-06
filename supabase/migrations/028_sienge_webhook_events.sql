-- Auditoria dos webhooks recebidos do Sienge (situação de título + baixa/recebimento).
-- Guarda o payload bruto e os headers para confirmar o formato do token no 1º disparo
-- e dar rastreabilidade às baixas que marcam um boleto como pago.
CREATE TABLE IF NOT EXISTS public.sienge_webhook_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event         text,                       -- RECEIPT_PROCESSED | UPDATE_RECEIVABLE_BILL_SITUATION | ...
  receivable_bill_id integer,
  installment_id     integer,
  situation     text,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  headers       jsonb NOT NULL DEFAULT '{}'::jsonb,
  matched       integer NOT NULL DEFAULT 0, -- quantos sienge_boletos foram atualizados
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sienge_webhook_events_bill
  ON public.sienge_webhook_events (receivable_bill_id, installment_id);
CREATE INDEX IF NOT EXISTS idx_sienge_webhook_events_created
  ON public.sienge_webhook_events (created_at DESC);

ALTER TABLE public.sienge_webhook_events ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY auth_read ON public.sienge_webhook_events FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY service_all ON public.sienge_webhook_events FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
