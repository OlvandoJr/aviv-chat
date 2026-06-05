-- 021_drop_resumo_orfao.sql
-- Remove a estrutura ÓRFÃ do "resumo de boletos por cliente", substituída pela
-- view vw_clientes_boletos. Confirmado sem leitores (0 views, 0 datasources,
-- 0 FKs, 0 realtime, 0 referências em código/n8n) e sem outros callers.
--
-- Benefícios:
--  * elimina write-amplification: o trigger rodava em TODA escrita de sienge_boletos
--    (inclusive nos milhares de linhas do sync Sienge A) mantendo tabela que ninguém lê.
--  * reduz duplicação de PII (a tabela guardava CPF/telefone/cliente_data redundantes).

DROP TRIGGER IF EXISTS trg_resumo_boletos ON public.sienge_boletos;
DROP FUNCTION IF EXISTS public.trg_resumo_boletos();
DROP FUNCTION IF EXISTS public.recalc_resumo_cliente(integer);
DROP FUNCTION IF EXISTS public.atualizar_sienge_clientes_boletos_resumo();
DROP TABLE IF EXISTS public.sienge_clientes_boletos_resumo;
