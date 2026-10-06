-- ─── Settlement replay limit ──────────────────────────────────
--
-- A settled payment may be replayed to recover the cached response after a
-- post-settlement network timeout, but only within a short window and only a
-- bounded number of times. Without a counter, the same header replays forever
-- (until eviction or the 7-day retention sweep), so one paid request unlocks
-- unlimited free responses.
--
-- `replay_count` is bumped atomically by `claim_settlement_replay`, which the
-- SDK's SupabaseSeenTxStore calls on each cache hit. The UPDATE takes a row
-- lock, so concurrent claims observe distinct counts and cannot both slip
-- under the limit.

ALTER TABLE settlements
  ADD COLUMN IF NOT EXISTS replay_count integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION claim_settlement_replay(p_key text)
RETURNS integer
LANGUAGE sql
AS $$
  UPDATE settlements
  SET replay_count = replay_count + 1
  WHERE key = p_key
  RETURNING replay_count;
$$;

-- Providers call this with the service key only. Keep the anon and
-- authenticated roles from incrementing (or probing) settlement counters.
REVOKE EXECUTE ON FUNCTION claim_settlement_replay(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION claim_settlement_replay(text) FROM anon;
REVOKE EXECUTE ON FUNCTION claim_settlement_replay(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION claim_settlement_replay(text) TO service_role;
