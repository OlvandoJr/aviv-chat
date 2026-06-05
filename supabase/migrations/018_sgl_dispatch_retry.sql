-- 018_sgl_dispatch_retry.sql
-- Robustez do sgl-dispatch: em falha de envio (erro transitório da Meta), não marca
-- como tratado — tenta de novo no próximo ciclo, até um limite. Evita perder cobrança
-- silenciosamente, sem entrar em loop infinito.

ALTER TABLE public.mensagens_cobranca
  ADD COLUMN IF NOT EXISTS app_dispatch_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS app_dispatch_error    text;
