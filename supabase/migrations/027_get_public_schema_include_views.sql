-- get_public_schema(): incluir VIEWS além de BASE TABLE, para que views como
-- vw_clientes_boletos apareçam no seletor de tabela das operações do subagente.
CREATE OR REPLACE FUNCTION public.get_public_schema()
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(jsonb_object_agg(table_name, cols), '{}'::jsonb)
  FROM (
    SELECT c.table_name,
           jsonb_agg(c.column_name ORDER BY c.ordinal_position) AS cols
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND t.table_type IN ('BASE TABLE', 'VIEW')
    GROUP BY c.table_name
  ) sub;
$function$;
