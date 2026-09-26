-- One-row aggregate view backing the dashboard metric cards, so the cards no
-- longer depend on the 50 most recently opened sessions the page fetches for
-- the table. It exposes only aggregates plus a settlement hash/timestamp that
-- `public_sessions` already exposes, and an aggregate view is not
-- auto-updatable, so the grant opens no write path.

CREATE OR REPLACE VIEW public_dashboard_stats AS
  SELECT
    agg.active_sessions,
    agg.open_vouchers,
    agg.total_settled,
    latest.settlement_tx_hash AS last_settlement_tx_hash,
    latest.updated_at         AS last_settlement_at
  FROM (
    SELECT
      COUNT(*) FILTER (WHERE status = 'open')                                    AS active_sessions,
      COALESCE(SUM(voucher_count) FILTER (WHERE status = 'open'), 0)             AS open_vouchers,
      COALESCE(SUM(cumulative_amount) FILTER (WHERE status = 'closed'), 0)::text AS total_settled
    FROM sessions
  ) agg
  LEFT JOIN LATERAL (
    SELECT settlement_tx_hash, updated_at
    FROM sessions
    WHERE status = 'closed' AND settlement_tx_hash IS NOT NULL
    ORDER BY updated_at DESC
    LIMIT 1
  ) latest ON true;

GRANT SELECT ON public_dashboard_stats TO anon, authenticated;
