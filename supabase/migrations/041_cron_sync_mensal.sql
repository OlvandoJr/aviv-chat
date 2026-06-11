-- 041_cron_sync_mensal.sql
-- Atualização do cadastro Sienge agora é PUSH (webhooks customer_*/sales_contract_*).
-- O sync completo vira só MENSAL (reconciliação): reagenda o de clientes (era diário,
-- migration 038) e adiciona o de contratos. Padrão vault dos demais crons.

-- Clientes: diário → mensal
SELECT cron.unschedule('sienge-sync-clientes-daily')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sienge-sync-clientes-daily');
SELECT cron.unschedule('sienge-sync-clientes-monthly')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sienge-sync-clientes-monthly');
SELECT cron.schedule(
  'sienge-sync-clientes-monthly', '0 6 1 * *',   -- dia 1, 06:00 UTC
  $$ SELECT net.http_post(
       url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='edge_base_url') || '/functions/v1/sienge-sync-clientes',
       headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='edge_cron_key')),
       body := '{}'::jsonb); $$
);

-- Contratos: mensal
SELECT cron.unschedule('sienge-sync-contratos-monthly')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sienge-sync-contratos-monthly');
SELECT cron.schedule(
  'sienge-sync-contratos-monthly', '30 6 1 * *',  -- dia 1, 06:30 UTC
  $$ SELECT net.http_post(
       url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='edge_base_url') || '/functions/v1/sienge-sync-contratos',
       headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='edge_cron_key')),
       body := '{}'::jsonb); $$
);
