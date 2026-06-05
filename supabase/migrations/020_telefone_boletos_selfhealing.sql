-- 020_telefone_boletos_selfhealing.sql
-- Fecha o gap de telefone nos boletos Sienge de forma robusta (self-healing).
--
-- Contexto: a sienge_clientes é o cache de telefone (preenchido pelo Sienge C).
-- O telefone chegava ao boleto só via trigger BEFORE INSERT — frágil pela ordem
-- (Sienge A 5h insere antes do Sienge C 6h cachear), deixando boletos com telefone
-- NULL que nunca eram corrigidos.
--
-- Solução: um trigger na sienge_clientes propaga o telefone para TODOS os boletos
-- do cliente sempre que ele é cacheado/alterado. Assim o denormalizado fica sempre
-- em sincronia com o cache, sem depender de ordem nem de backfill recorrente.

-- 1) Trigger de propagação (cache de clientes → boletos)
CREATE OR REPLACE FUNCTION public.propagar_telefone_para_boletos()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.telefone IS NOT NULL AND NEW.telefone <> '' THEN
    UPDATE public.sienge_boletos b
    SET customer_phone = NEW.telefone
    WHERE b.customer_id = NEW.client_id
      AND b.customer_phone IS DISTINCT FROM NEW.telefone;   -- só toca o que muda
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_propagar_telefone_boletos ON public.sienge_clientes;
CREATE TRIGGER trg_propagar_telefone_boletos
  AFTER INSERT OR UPDATE OF telefone ON public.sienge_clientes
  FOR EACH ROW EXECUTE FUNCTION public.propagar_telefone_para_boletos();

-- 2) Backfill imediato dos boletos que ficaram sem telefone
UPDATE public.sienge_boletos b
SET customer_phone = c.telefone
FROM public.sienge_clientes c
WHERE c.client_id = b.customer_id
  AND c.telefone IS NOT NULL AND c.telefone <> ''
  AND b.customer_phone IS DISTINCT FROM c.telefone;
