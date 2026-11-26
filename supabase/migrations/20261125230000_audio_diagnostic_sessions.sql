-- Additive, backward-compatible diagnostic store for voice-note recording
-- telemetry (Phase 1 observability). Stores strictly technical metadata
-- (zero audio bytes, transcripts, phone numbers, or PII) keyed by
-- (account_id, recording_id) so each recording session updates cleanly in place.

CREATE TABLE IF NOT EXISTS public.audio_diagnostic_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  recording_id text NOT NULL,
  correlation_id text NOT NULL,
  stage text NOT NULL,
  failure_category text NOT NULL DEFAULT 'none',
  runtime_mode text,
  ios_version text,
  build_commit text,
  duration_ms integer,
  size_bytes integer,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audio_diagnostic_sessions_account_recording_unique
    UNIQUE (account_id, recording_id)
);

CREATE INDEX IF NOT EXISTS audio_diagnostic_sessions_account_updated_idx
  ON public.audio_diagnostic_sessions (account_id, updated_at DESC);

ALTER TABLE public.audio_diagnostic_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audio_diagnostic_sessions_owner_select ON public.audio_diagnostic_sessions;
CREATE POLICY audio_diagnostic_sessions_owner_select
  ON public.audio_diagnostic_sessions
  FOR SELECT
  USING (public.is_account_member(account_id, 'owner'));

DROP POLICY IF EXISTS audio_diagnostic_sessions_owner_insert ON public.audio_diagnostic_sessions;
CREATE POLICY audio_diagnostic_sessions_owner_insert
  ON public.audio_diagnostic_sessions
  FOR INSERT
  WITH CHECK (public.is_account_member(account_id, 'owner'));

DROP POLICY IF EXISTS audio_diagnostic_sessions_owner_update ON public.audio_diagnostic_sessions;
CREATE POLICY audio_diagnostic_sessions_owner_update
  ON public.audio_diagnostic_sessions
  FOR UPDATE
  USING (public.is_account_member(account_id, 'owner'));

DROP POLICY IF EXISTS audio_diagnostic_sessions_owner_delete ON public.audio_diagnostic_sessions;
CREATE POLICY audio_diagnostic_sessions_owner_delete
  ON public.audio_diagnostic_sessions
  FOR DELETE
  USING (public.is_account_member(account_id, 'owner'));
