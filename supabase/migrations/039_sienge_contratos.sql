-- 039_sienge_contratos.sql
-- Cadastro de CONTRATOS DE VENDA do Sienge (GET /sales-contracts). Traz o que faltava:
-- empreendimento + unidade (quadra/lote) + vínculo cliente/título. Alimentado pelo sync
-- mensal (sienge-sync-contratos) e, em tempo real, pelos webhooks sales_contract_*.

CREATE TABLE IF NOT EXISTS public.sienge_contratos (
  contract_id           integer PRIMARY KEY,           -- sales-contract id
  client_id             integer,                        -- cliente principal (salesContractCustomers.main)
  customer_name         text,
  enterprise_id         integer,
  enterprise_name       text,                           -- EMPREENDIMENTO
  company_name          text,
  unidade               text,                           -- unidade principal ("Quadra L / Lote 10")
  receivable_bill_id    integer,                        -- título (vínculo com o boleto/baixa)
  number                text,                           -- nº do contrato (CVAVIV...)
  situation             text,
  value                 numeric,
  total_selling_value   numeric,
  contract_date         date,
  expected_delivery_date date,
  payment_conditions    jsonb,                          -- plano de parcelas (cru, p/ uso futuro)
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sienge_contratos_client_idx ON public.sienge_contratos (client_id);
CREATE INDEX IF NOT EXISTS sienge_contratos_bill_idx   ON public.sienge_contratos (receivable_bill_id);

ALTER TABLE public.sienge_contratos ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  BEGIN CREATE POLICY auth_read ON public.sienge_contratos FOR SELECT TO authenticated USING (true);
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sienge_contratos TO authenticated, service_role;

-- 1 contrato por cliente (o mais recente) — para joins de enriquecimento sem multiplicar linhas.
DROP VIEW IF EXISTS public.vw_cliente_contrato;
CREATE VIEW public.vw_cliente_contrato
WITH (security_invoker = true) AS
SELECT DISTINCT ON (client_id)
  client_id, contract_id, enterprise_name, unidade, receivable_bill_id, number, situation
FROM public.sienge_contratos
WHERE client_id IS NOT NULL
ORDER BY client_id, contract_date DESC NULLS LAST, contract_id DESC;

GRANT SELECT ON public.vw_cliente_contrato TO authenticated, service_role;
