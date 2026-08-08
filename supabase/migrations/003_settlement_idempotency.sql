-- ─── Settlement idempotency ───────────────────────────────────
--
-- Providers deduplicate settlements through a SeenTxStore. The SDK default is
-- per-process memory, which held on Railway (one long-lived process) but not on
-- Cloudflare Workers, where each request may land in a fresh isolate. An agent
-- retrying after a post-settlement timeout would miss the cache and settle a
-- second time, charging twice on-chain.
--
-- Workers KV is the wrong backing store here: it is eventually consistent, so a
-- retry can outrun propagation and reintroduce exactly this bug. Postgres gives
-- the read-your-writes guarantee the check depends on.

CREATE TABLE settlements (
  key        TEXT        PRIMARY KEY,
  tx_hash    TEXT,
  headers    JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Providers write with the service key, which bypasses RLS. Enable it anyway so
-- the anon key cannot read settlement records if it is ever pointed here: the
-- idempotency key is derived from the inbound payment header.
ALTER TABLE settlements ENABLE ROW LEVEL SECURITY;

-- Retention: idempotency only needs to outlive an agent's retry window.
CREATE INDEX idx_settlements_created_at ON settlements (created_at);
