-- Adiciona coluna de CPF/CNPJ do cliente para busca via comprovante
ALTER TABLE sienge_boletos
  ADD COLUMN IF NOT EXISTS customer_cpf varchar(20);

-- Índice para busca por CPF (fallback quando telefone não bater)
CREATE INDEX IF NOT EXISTS idx_sienge_boletos_cpf
  ON sienge_boletos (customer_cpf);
