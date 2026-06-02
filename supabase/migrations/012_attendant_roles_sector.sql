-- ── Setor do atendente ───────────────────────────────────────────────────────
ALTER TABLE chat_attendants
  ADD COLUMN IF NOT EXISTS sector TEXT;

-- ── Perfil Gerente ────────────────────────────────────────────────────────────
-- Remove a constraint de role antiga (se existir) e recria com 'manager'
DO $$
BEGIN
  -- Dropar constraints de CHECK existentes que envolvam a coluna role
  PERFORM constraint_name
  FROM   information_schema.table_constraints tc
  JOIN   information_schema.check_constraints cc USING (constraint_name, constraint_schema)
  WHERE  tc.table_name = 'chat_attendants'
    AND  tc.constraint_type = 'CHECK'
    AND  cc.check_clause ILIKE '%role%';

  -- Abordagem segura: alterar o tipo/constraint via ALTER TABLE … USING
  -- Se a constraint tiver nome fixo, dropamos; caso contrário, ignoramos o erro
  BEGIN
    ALTER TABLE chat_attendants DROP CONSTRAINT IF EXISTS chat_attendants_role_check;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
END $$;

-- Adicionar nova constraint que aceita 'admin' | 'manager' | 'agent'
ALTER TABLE chat_attendants
  DROP CONSTRAINT IF EXISTS attendants_role_check;

ALTER TABLE chat_attendants
  ADD CONSTRAINT attendants_role_check
  CHECK (role IN ('admin', 'manager', 'agent'));
