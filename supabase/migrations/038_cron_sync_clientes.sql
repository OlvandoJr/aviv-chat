-- 038_cron_sync_clientes.sql
-- Cron diário do sync de clientes direto do Sienge (GET /customers, paginado).
-- Substitui o caminho do n8n que derivava clientes das parcelas (receivable-bills):
-- agora que os boletos vêm do ZIP e a baixa vem do webhook, só o CADASTRO importa.
-- ~7 requisições/dia (1 por página de 200) — ok para o plano Free.
SELECT cron.unschedule('sienge-sync-clientes-daily')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sienge-sync-clientes-daily');

SELECT cron.schedule(
  'sienge-sync-clientes-daily',
  '0 8 * * *',   -- 08:00 UTC = 05:00 BRT
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='edge_base_url') || '/functions/v1/sienge-sync-clientes',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='edge_cron_key')),
    body := '{}'::jsonb
  );
  $$
);
