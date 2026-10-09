# RouteDock manifest specification

Providers serve a `RouteDockManifest` at `/.well-known/routedock.json`. This
document is the human-readable companion to
[`packages/sdk/src/schemas/routedock.schema.json`](../packages/sdk/src/schemas/routedock.schema.json)
(JSON Schema draft-07). Fields marked **required** are required by the schema;
all other fields are optional. Unknown fields are rejected.

## Manifest properties

| Property | Required | Meaning |
| --- | --- | --- |
| `routedock` | yes | Schema version in `major.minor` form, for example `1.0`. |
| `name` | yes | Human-readable provider name, 1–120 characters. |
| `description` | yes | Human-readable service description, 1–500 characters. |
| `modes` | yes | Unique list of supported payment modes: `x402`, `mpp-charge`, `mpp-session`, or `mpp-session-ws`. |
| `network` | yes | `testnet` or `mainnet`. |
| `asset` | yes | Payment asset ticker, such as `USDC`. |
| `asset_contract` | yes | Stellar asset contract address. |
| `payee` | yes | Stellar `G...` account receiving payment. |
| `pricing` | yes | Pricing object keyed by the modes the provider advertises. |
| `endpoints` | yes | Named map of endpoint descriptors. |
| `tags` | yes | Unique non-empty capability tags. |
| `min_client_version` | no | Minimum SDK `major.minor` required before payment. |
| `deprecated_modes` | no | Modes retained for compatibility but demoted during selection. |
| `sunset_at` | no | ISO 8601 time after which the manifest is unusable. |
| `sla` | no | Service-level availability, latency, and maintenance windows. |
| `vault` | no | Custody mode: `local-key`, `agent-vault`, or `nulth`. |
| `nulth_account` | no | Optional Nulth smart-account address. |
| `capabilities` | no | Streaming, webhook, idempotency, and content-type capabilities. |
| `regions` | no | Unique two-to-ten-character region identifiers. |
| `latency_hints` | no | Non-negative p50 milliseconds keyed by `regions`. Every key must be a region. |
| `signature` | no in schema | Base64 Ed25519 signature added by the provider adapter. It is required for SDK trust verification. |
| `signature_version` | no in schema | Must be `"2"` when signing; v2 includes nested fields in the digest. |
| `categories` | no | Unique hierarchical taxonomy labels. |

`pricing` uses `PricingConfig` for `x402` and `mpp-charge`: required
`amount` and `per: "request"`, with an optional x402 `facilitator` URL and
optional per-mode `payee`. It uses `SessionPricingConfig` for both
`mpp-session` and `mpp-session-ws`: required `rate`, `per: "voucher"`,
`channel_factory`, `min_deposit`, and positive
`refund_waiting_period_ledgers`. The WebSocket variant describes the same
channel pricing with WebSocket transport.

`EndpointDescriptor` requires `method` and `path`. It may also contain
`deprecated`, an ISO `sunset_at`, string `headers`, arbitrary JSON
`request_schema` and `response_schema`, and a `rate_limit` with required
`requests` and `window_seconds`. `SLAConfig` requires numeric
`uptime_30d_percent` and `p95_latency_ms`; its optional maintenance windows
contain `cron` and `duration_minutes`. `capabilities` may contain a
`streaming` list (`sse` or `websocket`), booleans `webhooks` and
`idempotency_keys`, and a string `content_types` list.

## Complete examples

Per-request provider:

```json
{
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
  "endpoints": { "price": { "method": "GET", "path": "/price" } },
  "tags": ["price", "stellar", "dex", "orderbook", "usdc"]
}
```

Session provider:

```json
{
  "routedock": "1.0",
  "name": "Stellar DEX Orderbook Stream",
  "description": "Voucher-metered USDC/XLM orderbook snapshots from Stellar Horizon",
  "modes": ["mpp-session", "mpp-session-ws"],
  "network": "testnet",
  "asset": "USDC",
  "asset_contract": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  "payee": "GDEMO2PAYEEADDRESS11111111111111111111111111111111111111",
  "pricing": {
    "mpp-session": { "rate": "0.0001", "per": "voucher", "channel_factory": "CDEMO1CHANNELCONTRACT1111111111111111111111111111111111", "min_deposit": "0.10", "refund_waiting_period_ledgers": 17280 },
    "mpp-session-ws": { "rate": "0.0001", "per": "voucher", "channel_factory": "CDEMO1CHANNELCONTRACT1111111111111111111111111111111111", "min_deposit": "0.10", "refund_waiting_period_ledgers": 17280 }
  },
  "endpoints": { "stream": { "method": "GET", "path": "/stream/orderbook" } },
  "tags": ["stream", "stellar", "dex", "orderbook", "usdc", "websocket"]
}
```

## Signature v2 and trust

The provider adapter receives an unsigned manifest and calls `signManifest`
once at startup. It adds `signature_version: "2"` first, then computes the
digest over the object with `signature` omitted. Object keys are sorted
recursively at every depth; array order and JSON primitive semantics are
preserved. The UTF-8 `JSON.stringify` result is hashed with SHA-256, and the
payee's Ed25519 key signs that digest. The signature is base64 encoded and
returned as `signature`.

Clients verify the signature after schema validation and the custom manifest
invariants. `RouteDockClient` accepts `expectedPayee`, which is the trust
anchor that binds a fetched document to a known account. `ProviderRegistry`
provides the corresponding registry payee binding. Without an anchor, a valid
signature only proves that the document was signed by the key named in its own
`payee` field.

`fetchManifest` checks, in order: schema validation, `assertManifestValid`,
signature, `min_client_version`, and `sunset_at`. Cache hits rerun every check
except the schema check. `assertManifestValid` additionally requires every
`latency_hints` key to be included in `regions`.

## Versioning and deprecation

`routedock` is a `major.minor` manifest-schema version. `min_client_version`
uses the SDK's `major.minor` comparison; an older client throws
`RouteDockClientVersionError`. A parsed `sunset_at` in the past throws
`RouteDockManifestSunsetError`; an unparseable value throws
`RouteDockManifestError`.

Endpoint descriptors can mark `deprecated: true` or supply their own
`sunset_at`. The SDK warns before paying deprecated endpoints and refuses a
fully sunset endpoint, but does not otherwise change routing based on endpoint
metadata yet. `deprecated_modes` are still accepted in `modes`, but are tried
only after all active modes.

## Mode selection

`forceMode` always wins. Session requests select `mpp-session-ws` when
`transport: "websocket"` is requested and otherwise select `mpp-session`;
when the preferred variant is absent, selection falls back to the other
session variant. With `optimize: "cost"`, the SDK compares `x402` and
`mpp-charge`, respects `budget_per_request`, and chooses the cheaper
affordable mode. If both exceed the budget it throws
`RouteDockPolicyRejectError`. The normal default order is `mpp-charge`, then
`x402`. Deprecated modes are demoted until every active mode has been tried;
selecting one logs a warning.
