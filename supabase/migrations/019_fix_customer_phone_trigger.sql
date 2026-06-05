-- 019_fix_customer_phone_trigger.sql
-- Corrige bug no trigger BEFORE INSERT da sienge_boletos: a função referenciava
-- NEW.client_id (coluna inexistente) em vez de NEW.customer_id, quebrando TODO
-- INSERT novo com "record \"new\" has no field \"client_id\"". Isso bloqueava
-- silenciosamente o sync de boletos do Sienge (n8n "Sienge A — Sync Boletos").

CREATE OR REPLACE FUNCTION public.preencher_customer_phone_sienge_boletos()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.customer_phone IS NULL OR trim(NEW.customer_phone) = '' THEN
    SELECT c.telefone
    INTO NEW.customer_phone
    FROM public.sienge_clientes c
    WHERE c.client_id = NEW.customer_id   -- corrigido: customer_id (era client_id)
    LIMIT 1;
  END IF;

  RETURN NEW;
END;
$function$;
