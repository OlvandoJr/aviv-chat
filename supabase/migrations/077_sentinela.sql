-- ─────────────────────────────────────────────────────────────────────────────
-- 077 — Sentinela: verificação diária dos invariantes do sistema
--
-- Todos os incidentes de agosto tiveram o mesmo formato: QUEBROU EM SILÊNCIO e
-- só apareceu quando o cliente reclamou. O webhook de contrato ficou 2 meses
-- mudo por uma letra na grafia do evento; as baixas encalharam 6 dias; uma
-- regressão de prompt rodou 3 dias classificando comprovante como boleto.
--
-- A sentinela roda todo dia de manhã (cron) e grava UMA LINHA POR INVARIANTE
-- nesta tabela. ok=false = algo precisa de atenção. Consulta do dia:
--   select invariante, ok, valor, detalhe from sentinela_log
--   where run_date = current_date order by ok, invariante;
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.sentinela_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_date   date NOT NULL DEFAULT (now() AT TIME ZONE 'America/Sao_Paulo')::date,
  invariante text NOT NULL,
  ok         boolean NOT NULL,
  valor      numeric,
  limite     numeric,
  detalhe    text,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.sentinela_log IS
  'Resultado diário da edge function sentinela (migration 077). ok=false = '
  'invariante violado — investigar no mesmo dia, não esperar reclamação.';

CREATE INDEX IF NOT EXISTS idx_sentinela_log_run ON public.sentinela_log (run_date DESC, ok);

ALTER TABLE public.sentinela_log ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "authenticated read sentinela" ON public.sentinela_log
    FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Cron diário: 10:00 UTC = 07:00 BRT, antes do expediente ──────────────────
SELECT cron.schedule(
  'sentinela-diaria',
  '0 10 * * *',
  $$ SELECT net.http_post(
       url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='edge_base_url') || '/functions/v1/sentinela',
       headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='edge_cron_key')),
       body := '{}'::jsonb
     ); $$
);

-- ── RPCs dos checks com join (mais simples e rápido do que via PostgREST) ────
CREATE OR REPLACE FUNCTION public.sentinela_abertos_com_parcela_paga() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(*)::int
  FROM boletos_emitidos be
  JOIN sienge_boletos sb
    ON sb.receivable_bill_id = be.receivable_bill_id AND sb.due_date = be.vencimento
  WHERE lower(coalesce(be.status,'aberto')) = 'aberto'
    AND lower(trim(sb.status)) = 'pago'
$$;

CREATE OR REPLACE FUNCTION public.sentinela_distratado_cobravel() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(DISTINCT be.id)::int
  FROM vw_cobranca_boletos v
  JOIN boletos_emitidos be ON be.id = v.emitido_id
  WHERE EXISTS (SELECT 1 FROM sienge_contratos sc WHERE sc.client_id = be.client_id)
    AND NOT EXISTS (SELECT 1 FROM sienge_contratos sc
                    WHERE sc.client_id = be.client_id AND sc.situation !~* 'cancel|distrat')
$$;

GRANT EXECUTE ON FUNCTION public.sentinela_abertos_com_parcela_paga() TO service_role;
GRANT EXECUTE ON FUNCTION public.sentinela_distratado_cobravel()      TO service_role;
