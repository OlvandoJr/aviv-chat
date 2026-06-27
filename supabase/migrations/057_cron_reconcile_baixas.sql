-- 057_cron_reconcile_baixas.sql
-- Rede de segurança da baixa: reprocessa, a cada 30 min, os eventos de baixa
-- (RECEIPT_PROCESSED) que não casaram em tempo real. Mesmo padrão dos demais
-- crons (vault: edge_base_url + edge_cron_key; service role fica na função).
-- Normalmente a fila está vazia (o webhook casa offline pela chave do Sienge);
-- só processa quando um webhook falhou no momento (cota/queda).
SELECT cron.unschedule('reconcile-baixas-30min')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'reconcile-baixas-30min');

SELECT cron.schedule(
  'reconcile-baixas-30min',
  '20,50 * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='edge_base_url') || '/functions/v1/reconcile-baixas',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='edge_cron_key')),
    body := '{}'::jsonb
  );
  $$
);
