-- ============================================================
-- RouteDock — Initial Schema Migration
-- Section 8: Database Schema (Supabase)
-- ============================================================

-- ─── Extensions ─────────────────────────────────────────────

-- Enable pg_trgm for fuzzy/trigram search on provider metadata.
-- Also enable in Supabase dashboard: Database → Extensions → pg_trgm
CREATE EXTENSION IF NOT EXISTS pg_trgm;


-- ─── 8.1 Sessions Table ──────────────────────────────────────

CREATE TABLE sessions (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id       TEXT          NOT NULL UNIQUE,
  payee            TEXT          NOT NULL,
  payer            TEXT          NOT NULL,
  cumulative_amount NUMERIC(20,7) NOT NULL DEFAULT 0,
  last_signature   TEXT,
  status           TEXT          NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'closing', 'closed')),
  channel_contract TEXT          NOT NULL,
  network          TEXT          NOT NULL DEFAULT 'testnet',
  opened_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  settlement_tx_hash TEXT,
  open_tx_hash     TEXT,
  voucher_count    INTEGER       NOT NULL DEFAULT 0
);

-- Monotonic enforcement at DB level.
-- The application MUST only call UPDATE sessions SET cumulative_amount = $new ...
-- WHERE channel_id = $id AND cumulative_amount::numeric < $new::numeric.
-- This trigger provides a second line of defence.
CREATE OR REPLACE FUNCTION enforce_monotonic_cumulative()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.cumulative_amount <= OLD.cumulative_amount THEN
    RAISE EXCEPTION 'cumulative_amount must be strictly increasing (old=%, new=%)',
      OLD.cumulative_amount, NEW.cumulative_amount;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER monotonic_cumulative
  BEFORE UPDATE OF cumulative_amount ON sessions
  FOR EACH ROW EXECUTE FUNCTION enforce_monotonic_cumulative();

-- Auto-update updated_at on any row change
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sessions_updated_at
  BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ─── 8.2 Provider Registry Table ─────────────────────────────

CREATE TABLE providers (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT        NOT NULL,
  description   TEXT,
  base_url      TEXT        NOT NULL UNIQUE,
  modes         TEXT[]      NOT NULL,
  tags          TEXT[]      NOT NULL DEFAULT '{}',
  network       TEXT        NOT NULL DEFAULT 'testnet',
  payee         TEXT        NOT NULL,
  manifest      JSONB       NOT NULL,
  verified      BOOLEAN     DEFAULT false,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trigram GIN indexes enable similarity() scoring and % operator queries
-- on provider name/description so agents can do fuzzy capability search
-- (e.g. "find me a streaming price feed") without exact keyword matching.
CREATE INDEX idx_providers_name_trgm
  ON providers USING GIN (name gin_trgm_ops);

CREATE INDEX idx_providers_description_trgm
  ON providers USING GIN (description gin_trgm_ops);

-- GIN index on tags array for exact tag lookups
CREATE INDEX idx_providers_tags
  ON providers USING GIN (tags);

-- JSONB index for manifest queries
CREATE INDEX idx_providers_manifest
  ON providers USING GIN (manifest);


-- ─── 8.3 Transactions Log Table ──────────────────────────────

CREATE TABLE tx_log (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    UUID        REFERENCES sessions(id),
  tx_type       TEXT        NOT NULL
    CHECK (tx_type IN ('x402_settle','mpp_charge','channel_open','channel_close','policy_reject')),
  tx_hash       TEXT,
  amount        NUMERIC(20,7),
  mode          TEXT,
  network       TEXT        NOT NULL DEFAULT 'testnet',
  provider_url  TEXT,
  agent_address TEXT,
  metadata      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ─── 8.4 Row Level Security ───────────────────────────────────

-- Sessions: providers can read/write their own sessions (matched by payee address).
-- Set app.stellar_address via SET LOCAL or connection parameter before queries.
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "providers_own_sessions" ON sessions
  FOR ALL
  USING (payee = current_setting('app.stellar_address', true));

CREATE POLICY "public_read_sessions" ON sessions
  FOR SELECT
  USING (true);

-- tx_log: fully public read for dashboard display (no sensitive data stored here).
ALTER TABLE tx_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public_read_tx_log" ON tx_log
  FOR SELECT
  USING (true);

-- providers: public read so agents can query the registry.
-- Authenticated insert requires the caller to set app.stellar_address.
ALTER TABLE providers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public_read_providers" ON providers
  FOR SELECT
  USING (true);


-- ─── Realtime ─────────────────────────────────────────────────
-- Enable Supabase Realtime change events for dashboard subscriptions.
ALTER PUBLICATION supabase_realtime ADD TABLE sessions, tx_log;
