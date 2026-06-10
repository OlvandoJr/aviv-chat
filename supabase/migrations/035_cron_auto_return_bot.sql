-- 035_cron_auto_return_bot.sql
-- Agenda o cron horário que devolve ao bot conversas em que o atendente assumiu e
-- deixou o cliente esperando (entre 4h e 22h). Mesmo padrão dos demais crons
-- (vault: edge_base_url + edge_cron_key; service role fica dentro da função).
SELECT cron.unschedule('auto-return-bot-hourly')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'auto-return-bot-hourly');

SELECT cron.schedule(
  'auto-return-bot-hourly',
  '15 * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='edge_base_url') || '/functions/v1/auto-return-bot',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='edge_cron_key')),
    body := '{}'::jsonb
  );
  $$
);
