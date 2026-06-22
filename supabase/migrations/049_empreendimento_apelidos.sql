-- 049_empreendimento_apelidos.sql
-- Empreendimentos podem ter mais de um nome (a SPE no boleto difere do nome comercial).
-- Ex.: "LOTEAMENTO JARDIM PAULO FREIRE SPE LTDA" (beneficiário) == "Jardim dos Ypes/Ipês"
-- (nome comercial). O validador de comprovante (process-media) trata como divergência e
-- manda p/ validação manual. `apelidos` carrega os nomes alternativos e entra na lista de
-- referência do validador, que passa a reconhecer a equivalência.

ALTER TABLE public.sienge_empreendimentos ADD COLUMN IF NOT EXISTS apelidos text;

UPDATE public.sienge_empreendimentos
   SET apelidos = 'Jardim dos Ypes, Jardim dos Ipês'
 WHERE name = 'LOTEAMENTO JARDIM PAULO FREIRE SPE LTDA';
