-- ─────────────────────────────────────────────────────────────────────────────
-- 073 — Campanhas: não enviar para distratado (com escape consciente)
--
-- Último caminho de envio sem proteção de distrato. As outras três — régua
-- Sienge, 2ª via do bot e régua SGL — já bloqueiam quem tem contrato(s) e
-- nenhum ativo. A view que alimenta a audiência (vw_clientes_boletos) tem hoje
-- 12 linhas de distratados: uma campanha "Cobrança" montada da base os incluiria.
--
-- Aqui a trava NÃO pode ser cega: campanhas de reconquista ou pesquisa com
-- ex-cliente são legítimas. Por isso é um interruptor POR CAMPANHA, com o padrão
-- no lado seguro (não envia). Quem quiser alcançar distratado marca a opção e
-- assume a escolha — explícito, não acidental.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.chat_campaigns
  ADD COLUMN IF NOT EXISTS incluir_distratados boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.chat_campaigns.incluir_distratados IS
  'false (padrão) = remove da audiência quem não tem nenhum contrato ativo no '
  'Sienge. true = envia mesmo assim (reconquista/pesquisa), escolha explícita.';
