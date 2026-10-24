-- ─── Session reconcile attempt tracking ───────────────────────
--
-- SessionReconciler retried every `closing` row on each run with no record of
-- past failures, so permanently failing rows kept the oldest `updated_at` and
-- starved newer recoverable sessions. Track attempts and the last error, and
-- add a terminal `failed` status so exhausted rows stop being retried.
--
-- `public_sessions` selects explicit columns, so the new columns (including the
-- error text) stay private; `status = 'failed'` is visible through the view.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS reconcile_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reconcile_error text;

ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_status_check;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_status_check
  CHECK (status IN ('open', 'closing', 'closed', 'failed'));
