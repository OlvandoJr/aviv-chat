-- 022_boletos_emitidos.sql
-- Boletos efetivamente EMITIDOS no banco (CAIXA), vindos do PDF de segunda via.
-- Fonte real para a cobrança Sienge (têm linha digitável). Alimentada pelo n8n
-- (Drive Trigger → extrai PDF → POST import-boletos). client_id vem do nome do arquivo.

CREATE TABLE IF NOT EXISTS public.boletos_emitidos (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       integer NOT NULL,                 -- Sienge client_id (do nome do arquivo)
  customer_name   text,
  vencimento      date NOT NULL,
  valor           numeric,
  linha_digitavel text,
  nosso_numero    text,
  telefone        text,                             -- wa_id limpo (casado por client_id)
  phone_norm      text GENERATED ALWAYS AS (public.normalize_phone(telefone)) STORED,
  pdf_path        text,                             -- caminho no Storage (fase 2)
  lote            text,                             -- referência da remessa (ex: 5704575265)
  status          text NOT NULL DEFAULT 'aberto',   -- aberto | pago | cancelado
  app_dispatched  boolean NOT NULL DEFAULT false,   -- (reservado) controle futuro
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, vencimento)
);

CREATE INDEX IF NOT EXISTS boletos_emitidos_phone_idx ON public.boletos_emitidos (phone_norm);
CREATE INDEX IF NOT EXISTS boletos_emitidos_venc_idx  ON public.boletos_emitidos (vencimento);

ALTER TABLE public.boletos_emitidos ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  BEGIN CREATE POLICY auth_select ON public.boletos_emitidos FOR SELECT TO authenticated USING (true);
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN CREATE POLICY auth_insert ON public.boletos_emitidos FOR INSERT TO authenticated WITH CHECK (true);
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN CREATE POLICY auth_update ON public.boletos_emitidos FOR UPDATE TO authenticated USING (true);
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN CREATE POLICY auth_delete ON public.boletos_emitidos FOR DELETE TO authenticated USING (true);
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;
