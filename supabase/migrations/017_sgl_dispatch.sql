-- 017_sgl_dispatch.sql
-- SGL cobrança orientado a evento: nosso sender reage a cada novo registro inserido
-- pelo n8n em mensagens_cobranca e envia o template correspondente (paridade com o
-- workflow "ENVIO - AVIV Cobrança"). n8n vira só ponte (parse + insert).

-- Marca de processamento pelo nosso sender (null = ainda não enviado por nós)
ALTER TABLE public.mensagens_cobranca
  ADD COLUMN IF NOT EXISTS app_dispatched_at timestamptz;

CREATE INDEX IF NOT EXISTS mensagens_cobranca_pending_idx
  ON public.mensagens_cobranca (created_at)
  WHERE app_dispatched_at IS NULL;

-- Mapa: classificacao (passo da régua SGL) → template + variáveis
CREATE TABLE IF NOT EXISTS public.sgl_regua_map (
  classificacao    text PRIMARY KEY,
  template_id      uuid NOT NULL REFERENCES public.chat_wa_templates(id) ON DELETE RESTRICT,
  inbox_id         uuid NOT NULL REFERENCES public.chat_inboxes(id)      ON DELETE RESTRICT,
  variable_mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.sgl_regua_map ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  BEGIN CREATE POLICY auth_select ON public.sgl_regua_map FOR SELECT TO authenticated USING (true);
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN CREATE POLICY auth_insert ON public.sgl_regua_map FOR INSERT TO authenticated WITH CHECK (true);
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN CREATE POLICY auth_update ON public.sgl_regua_map FOR UPDATE TO authenticated USING (true);
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN CREATE POLICY auth_delete ON public.sgl_regua_map FOR DELETE TO authenticated USING (true);
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;

-- Seed (paridade com o Switch1 do n8n). Colunas do "row" montado pelo sender:
-- customer_name, empreendimento, quadra, lote, parcela, due_date, amount, link_boleto.
WITH ib AS (SELECT id FROM public.chat_inboxes WHERE is_active ORDER BY created_at LIMIT 1),
map8 AS (SELECT '{"1":{"type":"column","value":"customer_name"},"2":{"type":"column","value":"empreendimento"},"3":{"type":"column","value":"quadra"},"4":{"type":"column","value":"lote"},"5":{"type":"column","value":"parcela"},"6":{"type":"column","value":"due_date","format":"date"},"7":{"type":"column","value":"amount"},"8":{"type":"column","value":"link_boleto"}}'::jsonb AS m),
map7 AS (SELECT '{"1":{"type":"column","value":"customer_name"},"2":{"type":"column","value":"empreendimento"},"3":{"type":"column","value":"quadra"},"4":{"type":"column","value":"lote"},"5":{"type":"column","value":"parcela"},"6":{"type":"column","value":"due_date","format":"date"},"7":{"type":"column","value":"amount"}}'::jsonb AS m)
INSERT INTO public.sgl_regua_map (classificacao, template_id, inbox_id, variable_mapping)
SELECT v.classificacao, t.id, ib.id, v.m
FROM ib, (
  SELECT 'a_vencer'        AS classificacao, 'a_vencer1'       AS tpl, (SELECT m FROM map8) AS m
  UNION ALL SELECT 'vencida_3_dias',  'vencidas_3_dias',  (SELECT m FROM map8)
  UNION ALL SELECT 'vencida_10_dias', 'vencidas_3_dias',  (SELECT m FROM map8)
  UNION ALL SELECT 'vencida_30_dias', 'vencidas_30_dias', (SELECT m FROM map7)
  UNION ALL SELECT 'sem_classificacao','vencidas_3_dias', (SELECT m FROM map8)
) v
JOIN public.chat_wa_templates t ON t.name = v.tpl AND t.status = 'APPROVED'
ON CONFLICT (classificacao) DO NOTHING;
