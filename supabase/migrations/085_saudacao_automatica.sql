-- 085_saudacao_automatica.sql
-- Saudação automática da caixa (pedido de 01/09/2026, caso Harbor 360).
--
-- Substitui a "mensagem de saudação" do app WhatsApp Business, que morre quando
-- o número é registrado na Cloud API: um QR code leva ao WhatsApp com frase
-- pronta e a primeira mensagem do contato recebe UM texto fixo (sem LLM) — 
-- depois disso a conversa é 100% humana.
--
-- Só tem efeito com ia_ativa=false (o modo "Resposta automática" da UI grava
-- ia_ativa=false + este texto). Enviada apenas quando a conversa nunca teve
-- mensagem 'out'; o claim atômico de handled_by bot→human no ai-responder
-- impede envio duplicado quando duas mensagens chegam juntas.

ALTER TABLE public.chat_inboxes
  ADD COLUMN IF NOT EXISTS auto_resposta text;

COMMENT ON COLUMN public.chat_inboxes.auto_resposta IS
  'Texto fixo enviado UMA vez na primeira mensagem do contato (equivalente à '
  'saudação do app WhatsApp Business). Só vale com ia_ativa=false.';
