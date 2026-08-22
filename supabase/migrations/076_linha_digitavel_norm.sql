-- ─────────────────────────────────────────────────────────────────────────────
-- 076 — Linha digitável normalizada: a âncora determinística do comprovante
--
-- Todo boleto e todo comprovante de boleto imprimem a linha digitável (47 díg.)
-- ou o código de barras (44 díg.). Ela é AUTOVALIDÁVEL (DVs módulo 10 + módulo
-- 11) e CODIFICA valor e vencimento. O process-media passou a casar comprovante
-- → boleto por IGUALDADE de linha (ver _shared/comprovante.ts), acabando com o
-- casamento por adivinhação (telefone + valor mais próximo) que fez um
-- comprovante de julho "quitar" agosto (caso Andréia) e um valor mal lido virar
-- validação manual (caso José Vitor: modelo leu 528,20 num boleto de 628,20).
--
-- A coluna linha_digitavel guarda o formato impresso ("104-0 10491.25733 …");
-- esta coluna GERADA guarda só os 47 dígitos do sufixo, com índice para o
-- casamento exato ser O(1).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.boletos_emitidos
  ADD COLUMN IF NOT EXISTS linha_norm text
  GENERATED ALWAYS AS (right(regexp_replace(coalesce(linha_digitavel, ''), '\D', '', 'g'), 47)) STORED;

COMMENT ON COLUMN public.boletos_emitidos.linha_norm IS
  'Os 47 dígitos da linha digitável (sufixo, sem formatação). Gerada — casamento '
  'exato comprovante → boleto no process-media. Ver migration 076.';

CREATE INDEX IF NOT EXISTS idx_boletos_emitidos_linha_norm
  ON public.boletos_emitidos (linha_norm) WHERE linha_norm <> '';
