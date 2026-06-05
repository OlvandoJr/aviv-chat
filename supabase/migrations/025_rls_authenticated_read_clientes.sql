-- 025_rls_authenticated_read_clientes.sql
-- Correção: a auditoria de segurança fechou o acesso ANON a sienge_clientes e
-- mensagens_cobranca (RLS), mas deixou o staff logado (authenticated) também sem
-- leitura — inconsistente com sienge_boletos (que já libera authenticated). Isso
-- fazia a Central de Clientes ver só os 104 contatos (chat_contacts).
-- Aqui liberamos SELECT para authenticated (anon continua bloqueado). Só leitura.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.mensagens_cobranca'::regclass AND polname='auth_select') THEN
    CREATE POLICY auth_select ON public.mensagens_cobranca FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.sienge_clientes'::regclass AND polname='auth_select') THEN
    CREATE POLICY auth_select ON public.sienge_clientes FOR SELECT TO authenticated USING (true);
  END IF;
END $$;
