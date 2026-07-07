-- 063_seed_indique_ganhe.sql
-- Semeia, de forma editável no painel, o fluxo "Indique e Ganhe":
--   integração CV CRM (api_call) + subagente + ferramenta de mensagem (send_message).
-- Credenciais CV ficam em SECRETS ({{env.CV_BASE_URL/CV_EMAIL/CV_TOKEN}}), nunca no banco.
DO $$
DECLARE
  v_agent uuid;
  v_api   uuid;
  v_sub   uuid;
BEGIN
  SELECT id INTO v_agent FROM public.chat_agents WHERE is_default = true AND is_active = true LIMIT 1;
  IF v_agent IS NULL THEN RAISE NOTICE 'sem agente default; seed abortado'; RETURN; END IF;

  -- ── Integração CV CRM (reservas por CPF) ───────────────────────────────────
  SELECT id INTO v_api FROM public.chat_api_configs WHERE name = 'CV CRM - Reservas' LIMIT 1;
  IF v_api IS NULL THEN
    INSERT INTO public.chat_api_configs
      (name, description, method, url, auth_type, headers, query_params, body_type, is_active)
    VALUES (
      'CV CRM - Reservas',
      'Busca a reserva do cliente por CPF e retorna o corretor responsável.',
      'GET',
      '{{env.CV_BASE_URL}}/api/v1/comercial/reservas',
      'none',
      '[{"key":"email","value":"{{env.CV_EMAIL}}","enabled":true},{"key":"token","value":"{{env.CV_TOKEN}}","enabled":true}]'::jsonb,
      '[{"key":"documento","value":"{{variables.cpf}}","enabled":true},{"key":"apenas_ativas","value":"true","enabled":true}]'::jsonb,
      'none', true
    ) RETURNING id INTO v_api;
  END IF;

  -- ── Subagente "Indique e Ganhe" (acionado por gatilho, não pelo principal) ──
  SELECT id INTO v_sub FROM public.chat_subagents WHERE agent_id = v_agent AND name = 'Indique e Ganhe' LIMIT 1;
  IF v_sub IS NULL THEN
    INSERT INTO public.chat_subagents
      (agent_id, name, trigger_type, invocation, instructions, model, is_active, sort_order, trigger, terminal_tool)
    VALUES (
      v_agent, 'Indique e Ganhe', 'text', 'flow',
      E'Você cuida da campanha "Indique e Ganhe" da Aviv. Fale em português, cordial e curto.\n\n'
      || E'1) Se você ainda NÃO tem o CPF do cliente nesta conversa, responda apenas: '
      || E'"Para registrar sua indicação, digite seu CPF." (não chame ferramenta).\n'
      || E'2) Quando o cliente enviar o CPF, chame a ferramenta de consulta do CV CRM passando o cpf (somente números).\n'
      || E'3) Se a consulta retornar um corretor (campos corretor.corretor e corretor.telefone), chame a ferramenta '
      || E'de notificação do corretor passando: telefone_corretor = corretor.telefone, corretor_nome = corretor.corretor, '
      || E'cliente_nome = titular.nome, empreendimento = unidade.empreendimento. Em seguida responda ao cliente: '
      || E'"Encontrei seus dados na base. O corretor responsável por seu cadastro entrará em contato para dar andamento '
      || E'na indicação e te explicar como a campanha vai funcionar. Obrigado!"\n'
      || E'4) Se a consulta NÃO encontrar reserva ou corretor, responda exatamente: '
      || E'ESCALAR_HUMANO: indicação sem cadastro localizado.',
      'gpt-4o-mini', true, 200,
      '{"kind":"campaign_reply","reply_flow":"indique_ganhe","buttons":["indicar","saber"]}'::jsonb,
      'Notificar corretor'
    ) RETURNING id INTO v_sub;
  END IF;

  -- ── Ferramenta 1: Consultar reserva (api_call → CV CRM) ─────────────────────
  IF NOT EXISTS (SELECT 1 FROM public.chat_agent_tools WHERE subagent_id = v_sub AND name = 'Consultar reserva CV CRM') THEN
    INSERT INTO public.chat_agent_tools (subagent_id, agent_id, name, description, tool_type, config, is_active, sort_order)
    VALUES (
      v_sub, NULL, 'Consultar reserva CV CRM',
      'Consulta a reserva do cliente por CPF no CV CRM e retorna o corretor (nome e telefone).',
      'api_call',
      jsonb_build_object(
        'api_config_id', v_api,
        'parameters', '[{"name":"cpf","type":"string","required":true,"description":"CPF do cliente, somente números"}]'::jsonb
      ),
      true, 1
    );
  END IF;

  -- ── Ferramenta 2: Notificar corretor (send_message → WhatsApp template) ─────
  IF NOT EXISTS (SELECT 1 FROM public.chat_agent_tools WHERE subagent_id = v_sub AND name = 'Notificar corretor') THEN
    INSERT INTO public.chat_agent_tools (subagent_id, agent_id, name, description, tool_type, config, is_active, sort_order)
    VALUES (
      v_sub, NULL, 'Notificar corretor',
      'Envia um WhatsApp (template aprovado) ao corretor avisando da indicação do cliente.',
      'send_message',
      ('{"channel":"whatsapp_cloud","message_type":"template","template_name":"novo_lead_indique_ganhe",'
      || '"to_param":"telefone_corretor","name_param":"corretor_nome",'
      || '"variables":["cliente_nome","cliente_wa_link"],'
      || '"parameters":['
      || '{"name":"telefone_corretor","type":"string","required":true,"description":"Telefone do corretor retornado pela consulta"},'
      || '{"name":"corretor_nome","type":"string","required":false,"description":"Nome do corretor"},'
      || '{"name":"cliente_nome","type":"string","required":true,"description":"Nome do cliente (titular)"}]}')::jsonb,
      true, 2
    );
  END IF;
END $$;
