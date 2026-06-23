-- 050_boleto_public_token.sql
-- Link público e estável do boleto: cada boleto ganha um token aleatório (não
-- enumerável). A edge `boleto-link?t=<token>` resolve o PDF (signed URL fresca) e
-- redireciona — funciona quando o CLIENTE abrir (sem login), mesmo dias depois.
-- A URL base é a do Supabase (estável), não depende do domínio do app.

ALTER TABLE public.boletos_emitidos
  ADD COLUMN IF NOT EXISTS public_token uuid NOT NULL DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS boletos_emitidos_public_token_idx
  ON public.boletos_emitidos (public_token);
