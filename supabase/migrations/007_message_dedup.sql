-- Unique index on wa_message_id so duplicate webhooks are rejected at DB level
-- NULL values are excluded (outbound bot messages have no wa_message_id yet)
CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_wa_message_id_key
  ON chat_messages (wa_message_id)
  WHERE wa_message_id IS NOT NULL;
