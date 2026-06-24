-- 055_tools_sob_subagente.sql
-- Fase 2 da arquitetura de 3 camadas: TODA ferramenta configurável
-- (chat_agent_tools) passa a pertencer a um subagente — nenhuma fica solta no
-- agente principal. Move as 3 api_call do agente "Contato Inteligente" para um
-- novo subagente "Atendimento ao Cliente" (on_demand) e trava a regra com CHECK.
--
-- Idempotente: resolve agentes/subagentes por nome em runtime; não apaga dados.

DO $$
DECLARE
  v_agent_id uuid;
  v_sub_id   uuid;
  v_orphans  int;
BEGIN
  SELECT id INTO v_agent_id FROM public.chat_agents WHERE name = 'Contato Inteligente' LIMIT 1;

  IF v_agent_id IS NOT NULL THEN
    -- 1. Subagente especialista de autoatendimento
    SELECT id INTO v_sub_id FROM public.chat_subagents
     WHERE agent_id = v_agent_id AND name = 'Atendimento ao Cliente' LIMIT 1;

    IF v_sub_id IS NULL THEN
      INSERT INTO public.chat_subagents
        (agent_id, name, trigger_type, invocation, instructions,
         delegation_description, escalation_message, model, is_active, sort_order)
      VALUES (
        v_agent_id,
        'Atendimento ao Cliente',
        'text',
        'on_demand',
        'Você é o especialista de autoatendimento da Aviv. Atenda usando SOMENTE as ferramentas disponíveis e os dados do contexto; nunca invente valores. Seja breve e cordial, uma pergunta por vez.'
          || E'\n\n- Quitação (saldo devedor): chame a ferramenta de quitação e informe o saldo de forma clara.'
          || E'\n- Extrato financeiro: confirme o e-mail do cliente, chame a ferramenta de extrato e avise que o extrato será enviado para esse e-mail.'
          || E'\n- Alterar endereço de correspondência: colete rua, número, complemento, bairro, cidade, estado (UF) e CEP; só então chame a ferramenta de alterar endereço e confirme a atualização.'
          || E'\n\nSe não conseguir concluir (dados insuficientes, erro na consulta após tentar, ou pedido fora deste escopo), encaminhe para um atendente respondendo APENAS com ESCALAR_HUMANO: <motivo>.',
        'Use quando o cliente quiser/escolher: consultar a quitação (saldo devedor), receber o extrato financeiro por e-mail, ou alterar o endereço de correspondência.',
        'Vou te encaminhar para um de nossos atendentes para concluir isso. 🙏',
        'gpt-4o-mini',
        true,
        90
      )
      RETURNING id INTO v_sub_id;
    END IF;

    -- 2. Mover as api_call órfãs desse agente para o subagente
    UPDATE public.chat_agent_tools
       SET subagent_id = v_sub_id, agent_id = NULL
     WHERE agent_id = v_agent_id
       AND subagent_id IS NULL
       AND tool_type = 'api_call';
  END IF;

  -- 3. Garantir que NÃO sobrou nenhuma ferramenta sem dono antes de travar
  SELECT count(*) INTO v_orphans FROM public.chat_agent_tools WHERE subagent_id IS NULL;
  IF v_orphans > 0 THEN
    RAISE EXCEPTION 'Ainda há % ferramenta(s) sem subagent_id — migre antes de aplicar o CHECK', v_orphans;
  END IF;
END $$;

-- 4. Travar a regra: toda ferramenta pertence a um subagente
DO $$ BEGIN
  ALTER TABLE public.chat_agent_tools
    ADD CONSTRAINT chat_agent_tools_owner_chk CHECK (subagent_id IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
