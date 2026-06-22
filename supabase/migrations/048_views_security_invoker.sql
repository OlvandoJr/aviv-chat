-- 048_views_security_invoker.sql
-- Restaura/define security_invoker=true nas views da Central/boletos. As recriações
-- 045/046/047 (CREATE OR REPLACE sem a cláusula WITH) regrediram vw_central_clientes
-- e vw_boletos_central para SECURITY DEFINER; vw_clientes_boletos já era definer (032).
-- Advisor: security_definer_view (ERROR). Seguro: nenhuma tabela-base está sem policy
-- (todas têm policy authenticated USING(true)); consumidores via service role (edge)
-- não são afetados. Convém manter invoker (convenção do projeto).

ALTER VIEW public.vw_central_clientes SET (security_invoker = true);
ALTER VIEW public.vw_boletos_central  SET (security_invoker = true);
ALTER VIEW public.vw_clientes_boletos SET (security_invoker = true);
