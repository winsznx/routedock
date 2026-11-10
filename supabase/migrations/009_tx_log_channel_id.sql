-- ============================================================
-- RouteDock — Migration 009: Add channel_id to tx_log
-- ============================================================

ALTER TABLE tx_log ADD COLUMN channel_id TEXT;

CREATE INDEX idx_tx_log_channel_id_created_at
  ON tx_log (channel_id, created_at DESC);
