-- 056_boletos_emitidos_sienge_key.sql
-- Baixa garantida: o webhook RECEIPT_PROCESSED só traz { billId, installmentId }.
-- Para casar a baixa com o boleto que enviamos (boletos_emitidos) SEM depender da
-- API do Sienge, persistimos a chave do Sienge no próprio boleto.
-- Também marcamos os eventos de webhook já reconciliados, para o replay/cron.

ALTER TABLE public.boletos_emitidos
  ADD COLUMN IF NOT EXISTS receivable_bill_id integer,
  ADD COLUMN IF NOT EXISTS installment_id     integer;

CREATE INDEX IF NOT EXISTS idx_boletos_emitidos_sienge_key
  ON public.boletos_emitidos(receivable_bill_id, installment_id);

ALTER TABLE public.sienge_webhook_events
  ADD COLUMN IF NOT EXISTS reconciled_at timestamptz;
