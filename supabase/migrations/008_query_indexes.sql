-- ─── Query indexes for the hot read paths ────────────────────
--
-- The dashboard feeds, the session list, the stats view and the
-- SessionReconciler all order or filter on columns that have no supporting
-- index, so each becomes a sequential scan plus a sort as soon as the tables
-- grow. tx_log is append-only and retained forever
-- (004_settlement_retention.sql), so its feed query only gets worse over
-- time. This migration adds the missing indexes; no RLS policies or grants
-- change.
--
-- Indexes for the dashboard network filter on tx_log (network, created_at
-- desc) are intentionally not included yet — they belong with that filter if
-- #571 lands.

-- tx_log feed: `order created_at desc limit N` from the dashboard page,
-- TxFeed, LiveFeed and useTxLog. The DESC ordering matches the queries so
-- Postgres can walk the index and stop at the LIMIT without sorting.
CREATE INDEX IF NOT EXISTS idx_tx_log_created_at
  ON tx_log (created_at DESC);

-- useTxLog adds an equality filter on mode before ordering by created_at.
CREATE INDEX IF NOT EXISTS idx_tx_log_mode_created_at
  ON tx_log (mode, created_at DESC);

-- Session list: `order opened_at desc limit 50|500` through public_sessions
-- (dashboard page, SessionTable, VoucherChart). A security-invoker view
-- merges into its base table, so an index on sessions serves those queries.
CREATE INDEX IF NOT EXISTS idx_sessions_opened_at
  ON sessions (opened_at DESC);

-- SessionReconciler (every 15 minutes on provider-b):
--   WHERE status = 'closing' AND network = ? AND payee = ?
--     AND settlement_tx_hash IS NULL AND last_signature IS NOT NULL
--   ORDER BY updated_at LIMIT 100
-- The partial predicate covers the reconciler's status and settlement filters,
-- so the index stays small: closing sessions awaiting settlement are rare.
-- The remaining last_signature filter is applied after the index scan.
-- Leading with payee and network serves the equality filters, and
-- updated_at last supports the (ascending) ordering within each payee.
CREATE INDEX IF NOT EXISTS idx_sessions_closing_reconcile
  ON sessions (payee, network, updated_at)
  WHERE status = 'closing' AND settlement_tx_hash IS NULL;

-- public_dashboard_stats (005_public_dashboard_stats.sql): latest closed,
-- settled session —
--   WHERE status = 'closed' AND settlement_tx_hash IS NOT NULL
--   ORDER BY updated_at DESC LIMIT 1
CREATE INDEX IF NOT EXISTS idx_sessions_closed_settled
  ON sessions (updated_at DESC)
  WHERE status = 'closed' AND settlement_tx_hash IS NOT NULL;
