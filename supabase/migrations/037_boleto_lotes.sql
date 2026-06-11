-- 037_boleto_lotes.sql
-- Organiza os carregamentos de boletos em LOTES (1 upload = 1 lote). Cada lote guarda
-- quem subiu, quando, o arquivo e as contagens. Cada boleto aponta para o lote (upload_id).

CREATE TABLE IF NOT EXISTS public.boleto_lotes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  uploaded_by      uuid,            -- chat_attendants.id (sem FK rígida p/ não travar exclusão)
  uploaded_by_name text,            -- denormalizado p/ exibir mesmo se o usuário for excluído
  filename         text,            -- nome do ZIP enviado
  lote             text,            -- remessa (do nome dos arquivos)
  recebidos        integer NOT NULL DEFAULT 0,
  gravados         integer NOT NULL DEFAULT 0,
  com_pdf          integer NOT NULL DEFAULT 0,
  sem_telefone     integer NOT NULL DEFAULT 0,
  falhas           integer NOT NULL DEFAULT 0,
  valor_total      numeric NOT NULL DEFAULT 0
);

ALTER TABLE public.boletos_emitidos ADD COLUMN IF NOT EXISTS upload_id uuid;
CREATE INDEX IF NOT EXISTS boletos_emitidos_upload_idx ON public.boletos_emitidos (upload_id);

ALTER TABLE public.boleto_lotes ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  BEGIN CREATE POLICY auth_all ON public.boleto_lotes FOR ALL TO authenticated USING (true) WITH CHECK (true);
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.boleto_lotes TO authenticated, service_role;

-- Backfill: agrupa os boletos já existentes (sem upload_id) por remessa em lotes sintéticos.
DO $$
DECLARE r record; v_id uuid;
BEGIN
  FOR r IN
    SELECT coalesce(lote, '(sem lote)') AS g, min(created_at) AS dt, count(*) AS n,
           count(pdf_path) AS cpdf, coalesce(sum(coalesce(valor,0)),0) AS val
    FROM public.boletos_emitidos WHERE upload_id IS NULL
    GROUP BY coalesce(lote, '(sem lote)')
  LOOP
    INSERT INTO public.boleto_lotes(created_at, uploaded_by_name, lote, recebidos, gravados, com_pdf, valor_total)
    VALUES (r.dt, 'Importação anterior', NULLIF(r.g, '(sem lote)'), r.n, r.n, r.cpdf, r.val)
    RETURNING id INTO v_id;
    UPDATE public.boletos_emitidos SET upload_id = v_id
      WHERE upload_id IS NULL AND coalesce(lote, '(sem lote)') = r.g;
  END LOOP;
END $$;
