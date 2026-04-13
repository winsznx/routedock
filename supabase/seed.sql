-- ============================================================
-- RouteDock — Development Seed Data
-- For local dashboard dev and demo purposes only.
-- Run: supabase db seed
-- ============================================================


-- ─── Sample Providers ────────────────────────────────────────

INSERT INTO providers (name, description, base_url, modes, tags, network, payee, manifest, verified)
VALUES
  (
    'Stellar DEX Price Feed',
    'Real-time USDC/XLM mid-price from Stellar DEX orderbook via Horizon',
    'https://provider-a.railway.app',
    ARRAY['x402', 'mpp-charge'],
    ARRAY['price', 'stellar', 'dex', 'orderbook', 'usdc'],
    'testnet',
    'GDEMO1PAYEEADDRESS11111111111111111111111111111111111111',
    '{
      "routedock": "1.0",
      "name": "Stellar DEX Price Feed",
      "description": "Real-time USDC/XLM mid-price from Stellar DEX orderbook via Horizon",
      "modes": ["x402", "mpp-charge"],
      "network": "testnet",
      "asset": "USDC",
      "asset_contract": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      "payee": "GDEMO1PAYEEADDRESS11111111111111111111111111111111111111",
      "pricing": {
        "x402": { "amount": "0.001", "per": "request", "facilitator": "https://channels.openzeppelin.com/x402/testnet" },
        "mpp-charge": { "amount": "0.0008", "per": "request" }
      },
      "endpoints": { "price": "GET /price" },
      "tags": ["price", "stellar", "dex", "orderbook", "usdc"]
    }'::jsonb,
    true
  ),
  (
    'Stellar DEX Orderbook Stream',
    'Real-time USDC/XLM orderbook SSE stream from Stellar Horizon',
    'https://provider-b.railway.app',
    ARRAY['mpp-session'],
    ARRAY['stream', 'stellar', 'dex', 'orderbook', 'usdc', 'sse', 'realtime'],
    'testnet',
    'GDEMO2PAYEEADDRESS11111111111111111111111111111111111111',
    '{
      "routedock": "1.0",
      "name": "Stellar DEX Orderbook Stream",
      "description": "Real-time USDC/XLM orderbook SSE stream from Stellar Horizon",
      "modes": ["mpp-session"],
      "network": "testnet",
      "asset": "USDC",
      "asset_contract": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      "payee": "GDEMO2PAYEEADDRESS11111111111111111111111111111111111111",
      "pricing": {
        "mpp-session": {
          "rate": "0.0001",
          "per": "voucher",
          "channel_contract": "CDEMO1CHANNELCONTRACT1111111111111111111111111111111111",
          "min_deposit": "0.10",
          "refund_waiting_period_ledgers": 17280
        }
      },
      "endpoints": { "stream": "GET /stream/orderbook" },
      "tags": ["stream", "stellar", "dex", "orderbook", "usdc", "sse", "realtime"]
    }'::jsonb,
    true
  );


-- ─── Sample Sessions ──────────────────────────────────────────

INSERT INTO sessions (
  channel_id, payee, payer, cumulative_amount, last_signature,
  status, channel_contract, network, opened_at, updated_at,
  settlement_tx_hash, open_tx_hash, voucher_count
)
VALUES
  (
    'chan_demo_001_open',
    'GDEMO2PAYEEADDRESS11111111111111111111111111111111111111',
    'GDEMO1AGENTADDRESS1111111111111111111111111111111111111',
    0.0023,
    'DEMOBASE64SIGNATURE001==',
    'open',
    'CDEMO1CHANNELCONTRACT1111111111111111111111111111111111',
    'testnet',
    NOW() - INTERVAL '2 hours',
    NOW() - INTERVAL '5 minutes',
    NULL,
    'demotxhash001xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    23
  ),
  (
    'chan_demo_002_closed',
    'GDEMO2PAYEEADDRESS11111111111111111111111111111111111111',
    'GDEMO1AGENTADDRESS1111111111111111111111111111111111111',
    0.0050,
    'DEMOBASE64SIGNATURE002==',
    'closed',
    'CDEMO1CHANNELCONTRACT1111111111111111111111111111111111',
    'testnet',
    NOW() - INTERVAL '6 hours',
    NOW() - INTERVAL '3 hours',
    'demotxhash003xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    'demotxhash002xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    50
  ),
  (
    'chan_demo_003_closing',
    'GDEMO2PAYEEADDRESS11111111111111111111111111111111111111',
    'GDEMO1AGENTADDRESS1111111111111111111111111111111111111',
    0.0011,
    'DEMOBASE64SIGNATURE003==',
    'closing',
    'CDEMO1CHANNELCONTRACT1111111111111111111111111111111111',
    'testnet',
    NOW() - INTERVAL '30 minutes',
    NOW() - INTERVAL '1 minute',
    NULL,
    'demotxhash004xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    11
  );


-- ─── Sample tx_log entries ────────────────────────────────────

INSERT INTO tx_log (tx_type, tx_hash, amount, mode, network, provider_url, agent_address, metadata)
VALUES
  (
    'x402_settle',
    'demotxhash005xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    0.001,
    'x402',
    'testnet',
    'https://provider-a.railway.app/price',
    'GDEMO1AGENTADDRESS1111111111111111111111111111111111111',
    '{"status": 200, "latency_ms": 142}'::jsonb
  ),
  (
    'mpp_charge',
    'demotxhash006xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    0.0008,
    'mpp-charge',
    'testnet',
    'https://provider-a.railway.app/price',
    'GDEMO1AGENTADDRESS1111111111111111111111111111111111111',
    '{"status": 200, "latency_ms": 98}'::jsonb
  ),
  (
    'channel_open',
    'demotxhash004xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    0.10,
    'mpp-session',
    'testnet',
    'https://provider-b.railway.app/stream/orderbook',
    'GDEMO1AGENTADDRESS1111111111111111111111111111111111111',
    '{"channel_id": "chan_demo_003_closing"}'::jsonb
  );
