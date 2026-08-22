-- 078_cron_sync_clientes_diario.sql
-- Registro em repo da migration aplicada via MCP em 22/08/2026
-- (schema_migrations: 20260822160054_sienge_sync_clientes_cron_diario).
--
-- Clientes: mensal → diário. A 041 tinha deixado o sync mensal apostando no PUSH
-- (webhooks customer_*), mas o CUSTOMER_CREATED chega ANTES de o cadastro estar
-- disponível em GET /customers/{id} — o handler registra "aguardando reconciliação
-- (sync)" e desiste. Com reconciliação mensal, esses clientes ficavam até 30 dias
-- fora do espelho (caso GABRIELLI, 13202). Contratos já era diário desde a 072.
--
-- Custo: ~7 req/dia (1 por página de 200 clientes) na cota de 100/dia do plano Free.
-- Horário: 06:00 UTC, meia hora ANTES do sienge-sync-contratos-daily (06:30), para
-- os contratos já encontrarem o cliente sincronizado.

SELECT cron.unschedule('sienge-sync-clientes-monthly')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sienge-sync-clientes-monthly');
SELECT cron.unschedule('sienge-sync-clientes-daily')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sienge-sync-clientes-daily');
SELECT cron.schedule(
  'sienge-sync-clientes-daily', '0 6 * * *',
  $$ SELECT net.http_post(
       url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='edge_base_url') || '/functions/v1/sienge-sync-clientes',
       headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='edge_cron_key')),
       body := '{}'::jsonb); $$
);
