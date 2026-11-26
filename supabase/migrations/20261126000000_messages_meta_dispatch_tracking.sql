-- Phase 3: Ambiguous-dispatch tracking on public.messages
-- Additive and backward-compatible with older application versions.
-- Note: messages_client_ref_unique ON public.messages (client_ref) already exists.

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS meta_dispatch_started_at timestamptz;
