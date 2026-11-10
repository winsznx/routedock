-- Per-network aggregate view backing the dashboard metric cards (issue #571).
-- Always emits one row for 'testnet' and one row for 'mainnet' so
-- `.eq('network', configuredNetwork()).maybeSingle()` returns a zeroed row
-- even when no sessions exist yet for that network.

DROP VIEW IF EXISTS public_dashboard_stats;

CREATE VIEW public_dashboard_stats AS
  SELECT
    net.network,
    COALESCE(agg.active_sessions, 0) AS active_sessions,
    COALESCE(agg.open_vouchers, 0)   AS open_vouchers,
    COALESCE(agg.total_settled, '0') AS total_settled,
    latest.settlement_tx_hash        AS last_settlement_tx_hash,
    latest.updated_at                AS last_settlement_at
  FROM (VALUES ('testnet'::text), ('mainnet'::text)) AS net(network)
  LEFT JOIN (
    SELECT
      network,
      COUNT(*) FILTER (WHERE status = 'open')                                    AS active_sessions,
      COALESCE(SUM(voucher_count) FILTER (WHERE status = 'open'), 0)             AS open_vouchers,
      COALESCE(SUM(cumulative_amount) FILTER (WHERE status = 'closed'), 0)::text AS total_settled
    FROM sessions
    GROUP BY network
  ) agg ON agg.network = net.network
  LEFT JOIN LATERAL (
    SELECT settlement_tx_hash, updated_at
    FROM sessions
    WHERE sessions.network = net.network
      AND status = 'closed'
      AND settlement_tx_hash IS NOT NULL
    ORDER BY updated_at DESC
    LIMIT 1
  ) latest ON true;

REVOKE ALL ON public_dashboard_stats FROM anon, authenticated;
GRANT SELECT ON public_dashboard_stats TO anon, authenticated;
