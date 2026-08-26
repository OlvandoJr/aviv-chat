-- 081_campanha_disparos.sql
-- Campanha com MAIS DE UM disparo, replicando o modelo da régua de cobrança
-- (cobranca_regua → cobranca_regua_step → cobranca_regua_log, migration 016):
--
--   chat_campaigns  → chat_campaign_disparos  → chat_campaign_envios
--
-- Diferença essencial: a régua ancora no vencimento (offset_days); campanha não
-- tem vencimento, então cada disparo tem DATA/HORA ABSOLUTA. O envio principal
-- da campanha continua intocado (template_id/scheduled_at próprios + recipients)
-- — os disparos daqui são os ADICIONAIS, cada um com template e mapeamento de
-- variáveis próprios, exatamente como um step da régua.

CREATE TABLE IF NOT EXISTS public.chat_campaign_disparos (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id      uuid NOT NULL REFERENCES public.chat_campaigns(id) ON DELETE CASCADE,
  ordem            integer NOT NULL DEFAULT 1,
  scheduled_at     timestamptz NOT NULL,
  template_id      uuid NOT NULL REFERENCES public.chat_wa_templates(id) ON DELETE RESTRICT,
  variable_mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- scheduled → running → done (mesma máquina de estados simples da campanha)
  status           text NOT NULL DEFAULT 'scheduled',
  sent             integer NOT NULL DEFAULT 0,
  failed           integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_campaign_disparos_camp ON public.chat_campaign_disparos (campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_disparos_due
  ON public.chat_campaign_disparos (scheduled_at) WHERE status IN ('scheduled','running');

-- Log por disparo × destinatário (equivalente ao cobranca_regua_log).
-- UNIQUE(disparo_id, wa_id) é o dedup: reprocessar um disparo nunca duplica envio.
CREATE TABLE IF NOT EXISTS public.chat_campaign_envios (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  disparo_id    uuid NOT NULL REFERENCES public.chat_campaign_disparos(id) ON DELETE CASCADE,
  campaign_id   uuid NOT NULL REFERENCES public.chat_campaigns(id) ON DELETE CASCADE,
  wa_id         text NOT NULL,
  name          text,
  status        text NOT NULL DEFAULT 'pending',   -- pending|sent|delivered|read|failed
  wa_message_id text,
  error         text,
  claimed_at    timestamptz,
  sent_at       timestamptz,
  delivered_at  timestamptz,
  read_at       timestamptz,
  replied_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (disparo_id, wa_id)
);
CREATE INDEX IF NOT EXISTS idx_campaign_envios_disparo ON public.chat_campaign_envios (disparo_id, status);
-- O webhook de status da Meta casa por wa_message_id (entrega/leitura/falha).
CREATE INDEX IF NOT EXISTS idx_campaign_envios_wamid ON public.chat_campaign_envios (wa_message_id);

-- Dados de ORIGEM do destinatário (linha da planilha/base). Sem isto só existe o
-- array de variáveis já resolvido para o template principal — e um disparo com
-- OUTRO template/mapeamento não teria de onde resolver as suas.
ALTER TABLE public.chat_campaign_recipients
  ADD COLUMN IF NOT EXISTS dados jsonb;

-- ── RLS: mesma visibilidade da campanha (migration 080) ──────────────────────
ALTER TABLE public.chat_campaign_disparos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_campaign_envios   ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "disparo segue campanha" ON public.chat_campaign_disparos
    FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM public.chat_campaigns c WHERE c.id = campaign_id
                   AND (public.is_supervisor() OR auth.uid() = ANY (c.visivel_para))));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "disparo escrita supervisor" ON public.chat_campaign_disparos
    FOR ALL TO authenticated USING (public.is_supervisor()) WITH CHECK (public.is_supervisor());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "envio segue campanha" ON public.chat_campaign_envios
    FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM public.chat_campaigns c WHERE c.id = campaign_id
                   AND (public.is_supervisor() OR auth.uid() = ANY (c.visivel_para))));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "envio escrita supervisor" ON public.chat_campaign_envios
    FOR ALL TO authenticated USING (public.is_supervisor()) WITH CHECK (public.is_supervisor());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
