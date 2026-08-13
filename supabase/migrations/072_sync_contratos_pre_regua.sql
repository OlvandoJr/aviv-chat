-- ─────────────────────────────────────────────────────────────────────────────
-- 072 — Segundo sync de contratos às 08:30 BRT, meia hora antes da régua
--
-- Caso Luiz Felipe (12–13/08): distrato registrado no Sienge DURANTE o dia 12;
-- a régua das 09:00 de 12/08 cobrou (contrato ainda constava ativo) e o sync
-- das 03:30 de 13/08 cancelou tudo 1 segundo depois de enxergar o "Cancelado".
-- A proteção funciona — a janela dela é que era de até 24h.
--
-- Este job encolhe a janela para a régua das 09:00: contratos re-sincronizados
-- às 08:30 BRT (11:30 UTC). Custo: 3 requisições/dia da cota de 100 do Sienge
-- (461 contratos ÷ 200 por página) — orçado conforme a regra da cota Free.
-- ─────────────────────────────────────────────────────────────────────────────

SELECT cron.schedule(
  'sienge-sync-contratos-pre-regua',
  '30 11 * * *',   -- 11:30 UTC = 08:30 BRT, 30min antes da régua das 09:00
  $$ SELECT net.http_post(
       url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='edge_base_url') || '/functions/v1/sienge-sync-contratos',
       headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='edge_cron_key')),
       body := '{}'::jsonb
     ); $$
);
