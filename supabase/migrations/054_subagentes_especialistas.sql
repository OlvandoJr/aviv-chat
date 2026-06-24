-- 054_subagentes_especialistas.sql
-- Arquitetura de 3 camadas: Agente principal (orquestrador) → Subagentes
-- (especialistas) → Ferramentas. Esta migration adiciona o conceito de
-- "invocação" ao subagente e permite que ferramentas (chat_agent_tools)
-- pertençam a um subagente. Cria o subagente "Agendador de Pagamentos"
-- (on_demand) com a ferramenta payment_scheduler já configurável.
--
-- Aditiva e idempotente: não apaga dados; mantém back-compat (ferramentas
-- ainda podem pertencer ao agente diretamente até a Fase 2).

-- ── 1. chat_subagents: como o subagente é acionado ───────────────────────────
--   auto_context = injeta contexto no prompt do principal a cada mensagem (texto)
--   on_media     = acionado por gatilho de mídia (imagem/documento/áudio)
--   on_demand    = delegável pelo agente principal via função delegar_<slug>
ALTER TABLE public.chat_subagents
  ADD COLUMN IF NOT EXISTS invocation             text NOT NULL DEFAULT 'auto_context',
  ADD COLUMN IF NOT EXISTS delegation_description text,
  ADD COLUMN IF NOT EXISTS escalation_message     text;

-- Backfill: subagentes de mídia existentes passam a 'on_media'
UPDATE public.chat_subagents
   SET invocation = 'on_media'
 WHERE trigger_type IN ('image', 'document', 'audio');

DO $$ BEGIN
  ALTER TABLE public.chat_subagents
    ADD CONSTRAINT chat_subagents_invocation_chk
    CHECK (invocation IN ('auto_context', 'on_media', 'on_demand'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2. chat_agent_tools: ferramenta pode pertencer a um subagente ────────────
-- agent_id já é nullable (migration 010). Adiciona o vínculo com subagente.
ALTER TABLE public.chat_agent_tools
  ADD COLUMN IF NOT EXISTS subagent_id uuid REFERENCES public.chat_subagents(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_chat_agent_tools_subagent_id
  ON public.chat_agent_tools(subagent_id);

-- ── 3. Seed: subagente Agendador (on_demand) + ferramenta payment_scheduler ──
-- Sem hardcode de IDs: resolve o agente default em runtime e cria só se faltar.
DO $$
DECLARE
  v_agent_id uuid;
  v_sub_id   uuid;
BEGIN
  SELECT id INTO v_agent_id FROM public.chat_agents WHERE is_default = true ORDER BY created_at LIMIT 1;
  IF v_agent_id IS NULL THEN
    SELECT id INTO v_agent_id FROM public.chat_agents ORDER BY created_at LIMIT 1;
  END IF;
  IF v_agent_id IS NULL THEN RETURN; END IF;

  SELECT id INTO v_sub_id FROM public.chat_subagents
   WHERE agent_id = v_agent_id AND name = 'Agendador de Pagamentos' LIMIT 1;

  IF v_sub_id IS NULL THEN
    INSERT INTO public.chat_subagents
      (agent_id, name, trigger_type, invocation, instructions,
       delegation_description, escalation_message, model, is_active, sort_order)
    VALUES (
      v_agent_id,
      'Agendador de Pagamentos',
      'text',          -- trigger_type não se aplica a on_demand; mantido por compat de schema
      'on_demand',
      'Você é o especialista em agendamento de pagamento de boletos da Aviv. '
        || 'Ofereça SOMENTE as datas retornadas pela ferramenta calcular_datas_pagamento. '
        || 'Quando o cliente escolher uma delas, registre com confirmar_agendamento. '
        || 'Nunca confirme data fora das opções nem além do prazo máximo configurado: '
        || 'nesses casos, não registre e encaminhe para um atendente humano. '
        || 'Seja breve, claro e cordial.',
      'Use quando o cliente quiser pagar o boleto em OUTRA data, reagendar, adiar ou negociar o prazo do pagamento.',
      'Vou te encaminhar para um de nossos atendentes para tratar essa data. 🙏',
      'gpt-4o-mini',
      true,
      100
    )
    RETURNING id INTO v_sub_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.chat_agent_tools
     WHERE subagent_id = v_sub_id AND tool_type = 'payment_scheduler'
  ) THEN
    INSERT INTO public.chat_agent_tools
      (subagent_id, name, description, tool_type, config, is_active, sort_order)
    VALUES (
      v_sub_id,
      'Agendador de Pagamentos',
      'Calcula as datas úteis disponíveis e registra o agendamento do pagamento do boleto.',
      'payment_scheduler',
      jsonb_build_object(
        'business_day_offsets', jsonb_build_array(3, 5, 10),  -- opções oferecidas (dias úteis a partir de hoje)
        'max_offset_days',      10,                            -- prazo máximo permitido (dias úteis)
        'max_reschedules',      2,                             -- nº máx. de agendamentos por contato antes de escalar
        'on_exceed',            'escalate',                    -- ação ao exceder limite/prazo
        'calendar',             'system'                       -- 'system' = grava chat_scheduled_payments; Google Calendar via api_connection
      ),
      true,
      0
    );
  END IF;
END $$;
