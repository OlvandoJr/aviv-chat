-- ─────────────────────────────────────────────────────────────────────────────
-- 071 — Baixas: completar a chave dos emitidos + permitir RETRY de eventos
--
-- Janela 01–06/08: ~0 baixas aplicadas enquanto 500+ eventos RECEIPT_PROCESSED
-- chegavam. Resultado medido: até 171 clientes receberam 325 cobranças (172
-- "boleto vencido") entre 03 e 07/08 com a baixa presa no encalhe.
--
-- Elos da falha:
--   1. boletos_emitidos com receivable_bill_id preenchido (backfill 068) mas
--      SEM installment_id — o matcher offline usa a chave completa e não casa.
--   2. reconcile-baixas marcava falha TRANSITÓRIA da API (429/queda) como
--      reconciled_at definitivo → o evento morria para sempre (1071 mortos).
--
-- Esta migration cobre o lado do banco; o retry em si é código (reconcile).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Completar installment_id onde (título, vencimento) aponta para UMA parcela
WITH unico AS (
  SELECT be.id, min(sb.installment_id) AS inst
  FROM boletos_emitidos be
  JOIN sienge_boletos sb
    ON sb.receivable_bill_id = be.receivable_bill_id AND sb.due_date = be.vencimento
  WHERE be.installment_id IS NULL AND sb.installment_id IS NOT NULL
  GROUP BY be.id
  HAVING count(DISTINCT sb.installment_id) = 1
)
UPDATE boletos_emitidos be
SET installment_id = u.inst
FROM unico u WHERE be.id = u.id;

-- 2. Contabilidade de retry nos eventos de webhook
ALTER TABLE public.sienge_webhook_events
  ADD COLUMN IF NOT EXISTS attempts        int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;

COMMENT ON COLUMN public.sienge_webhook_events.attempts IS
  'Tentativas de reconciliação. Falha transitória (API fora/cota) NÃO grava '
  'reconciled_at — o evento volta amanhã, até o teto do reconcile (5).';
