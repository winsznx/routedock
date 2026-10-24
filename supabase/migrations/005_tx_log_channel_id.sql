-- ─── Channel association for transaction logs ─────────────────
--
-- Channel-filtered SDK activity feeds need a first-class value to query.
-- Keep this nullable because x402 and mpp-charge transactions do not belong
-- to a payment channel. Existing rows are intentionally not backfilled: no
-- writer recorded the channel before this migration.

ALTER TABLE tx_log ADD COLUMN channel_id TEXT;

CREATE INDEX idx_tx_log_channel_id_created_at
  ON tx_log (channel_id, created_at DESC);
