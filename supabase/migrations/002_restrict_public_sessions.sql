-- Restrict anonymous session reads so signed channel-close vouchers are never
-- exposed through the browser Supabase anon key.

DROP POLICY IF EXISTS "public_read_sessions" ON sessions;

CREATE OR REPLACE VIEW public_sessions AS
  SELECT
    id,
    channel_id,
    payee,
    payer,
    cumulative_amount,
    status,
    network,
    opened_at,
    updated_at,
    settlement_tx_hash,
    open_tx_hash,
    voucher_count
  FROM sessions;

GRANT SELECT ON public_sessions TO anon, authenticated;

-- Realtime publishes whole changed rows. Do not publish `sessions` because rows
-- contain last_signature, a broadcastable channel-close authorization.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication_tables
             WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'sessions') THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE sessions;
  END IF;
END $$;
