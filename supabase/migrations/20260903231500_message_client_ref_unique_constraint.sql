-- Upgrade messages.client_ref's uniqueness guard from a partial unique
-- index to a full UNIQUE constraint. Two reasons:
--
--  1. A plain UNIQUE constraint already permits unlimited NULL client_ref
--     values (Postgres never treats NULL = NULL for uniqueness purposes),
--     so the "WHERE client_ref IS NOT NULL" predicate on the original
--     index (20260903230000) was unnecessary.
--
--  2. sendMessageToConversation (src/lib/whatsapp/send-message.ts) now
--     claims a client_ref atomically via
--     `.upsert(row, { onConflict: 'client_ref', ignoreDuplicates: true })`
--     — PostgREST/postgres-js translate that into
--     `INSERT ... ON CONFLICT (client_ref) DO NOTHING`. Postgres can only
--     resolve an `ON CONFLICT (column)` inference against a unique
--     index/constraint whose definition has NO partial predicate (or an
--     exactly-matching one, which the JS client has no way to express) —
--     against the old partial index this upsert would fail at runtime
--     with "there is no unique or exclusion constraint matching the ON
--     CONFLICT specification". A full constraint has no such predicate to
--     match, so the same ON CONFLICT clause resolves cleanly.
--
-- Global (not per-conversation) uniqueness is intentional: client_ref is
-- a crypto.randomUUID() minted once per voice-note recording
-- (message-composer.tsx) and is never legitimately reused across
-- conversations, so a bare UNIQUE(client_ref) turns any such reuse (a
-- future bug, not a real-world scenario today) into a loud DB error
-- instead of silently letting a UNIQUE(conversation_id, client_ref)
-- create two different messages, in two different conversations, from
-- what should be one uniquely-identified send attempt.
DROP INDEX IF EXISTS messages_client_ref_unique;

ALTER TABLE messages
  ADD CONSTRAINT messages_client_ref_unique UNIQUE (client_ref);
