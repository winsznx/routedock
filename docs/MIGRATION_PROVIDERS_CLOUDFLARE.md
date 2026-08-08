# Migration plan: provider-a / provider-b → Cloudflare Workers

Status: **proposal, not implemented.** Nothing in this document has been built.

## Why now

The providers are down, not degraded.

| Check | Result |
|---|---|
| `api-a.routedock.xyz` | NXDOMAIN — no DNS record exists |
| `api-b.routedock.xyz` | NXDOMAIN — no DNS record exists |
| `routedock-provider-a.up.railway.app` | HTTP 404 `Application not found` |
| `routedock-provider-b.up.railway.app` | HTTP 404 `Application not found` |
| Railway API (MCP) | `Unauthorized` |
| `routedock - provider-a` / `-b` commit status on `main` | failure |

Both Railway services are gone and the `api-a` / `api-b` DNS records were never
recreated after `routedock.xyz` moved to Cloudflare nameservers. There is no
running deployment to migrate *from*. This is a rebuild.

`MIGRATION.md` is stale on one point: it lists the custom domain as PENDING.
`routedock.xyz` and `www.routedock.xyz` are already attached to the `routedock`
Worker as custom domains and serve HTTP 200. Only the two API subdomains are missing.

Cloudflare account: `eb94a234b390bb8da04babac718d6c92`
`routedock.xyz` zone: `7b75ca0074513c143eada75333bf0000` (active, 8 records, zero Worker routes)

## What makes this tractable

The SDK already ships the hard part. `packages/sdk/src/provider/hono.ts` is
documented as a **Workers-safe entry point**: Web-standard APIs only
(`atob`/`TextDecoder`, `hexToBytes`), and it detects client disconnect through
`c.req.raw.signal` rather than Node's `req.on('close')`. It covers all three
modes, including `mpp-session`.

The Express `routedock()` middleware the providers use today is Node-only. The
port is Express → Hono, not a rewrite of the payment logic.

Dependency audit against the Workers runtime:

| Dependency | Verdict |
|---|---|
| `@routedock/routedock/provider/hono` | Supported target, no change needed |
| `@stellar/stellar-sdk` 14.6.1 | Ships `./minimal`, `./no-axios`, `./no-eventsource` edge entries |
| `@supabase/supabase-js` | fetch-based, runs as-is |
| Horizon orderbook call | Plain HTTPS, can drop to `fetch` and delete the SDK dep entirely |
| `ajv` | **Blocked** — compiles schemas via `new Function`, which Workers reject |
| `express` | Removed |

`ajv` is the only hard blocker and it is not load-bearing. Both providers use it
once, at startup, to self-check their own manifest. That check moves to a test or
a build step. The provider request path never touches it.

## The real design question: shared state

Two stores default to per-isolate memory. On Railway that was one process. On
Workers it is N ephemeral isolates, so both become correctness bugs rather than
performance issues.

### 1. `SeenTxStore` — settlement idempotency (both providers)

Guards double-settlement when an agent retries after a post-settle timeout. A
missed hit means charging twice on-chain.

Do **not** back this with Workers KV. KV is eventually consistent, so a retry
landing before propagation reads empty and settles again — exactly the bug the
store exists to prevent.

Recommendation: back it with **Supabase**, which is already provisioned and
strongly consistent. A `settlements` table keyed on the idempotency key with a
unique constraint turns the race into a constraint violation the handler can
treat as a cache hit. The interface is two methods (`get`/`set`) and is already
injectable via the `seenTxStore` option.

### 2. `mpp-session` channel `Store` — voucher monotonicity (provider-b only)

`hono.ts` builds `Store.memory()` and keeps `lastCumulativeAmount`,
`lastSignatureHex`, and `sessionPayerAddress` in closure scope. Voucher
enforcement requires monotonically increasing reads. Any store without
serialized access lets a replayed voucher read stale state and underpay at close.

Recommendation: one **Durable Object per channel**, keyed by `channelId`.
Durable Objects give single-threaded serialized execution, which is precisely
the guarantee voucher monotonicity needs, plus SQLite-backed persistence. The
Workers Paid plan already in use covers it.

The DO holds the channel state and implements the `Store` shape the adapter
expects (`get` / `put` / `update`), so it drops into the existing
`wrappedStore` seam without touching payment logic.

The `AbortSignal` orphan path already works on Workers, so `onOrphaned` →
Supabase `status: 'closing'` carries over unchanged. The `SessionReconciler`
sweep, currently tied to process lifecycle, becomes a **Cron Trigger**.

## Per-service plan

### provider-a (`/price`, x402 + mpp-charge)

Stateless per request. Straightforward.

1. New `apps/provider-a/src/worker.ts` — Hono app, `routedockHono()` in place of `routedock()`
2. Routes carry over unchanged: `/.well-known/routedock.json`, `/price`, `/health`
3. Replace `Horizon.Server(...).orderbook(...)` with a `fetch` against
   `/order_book?selling_asset_type=native&buying_asset_type=credit_alphanum4&...`,
   dropping `@stellar/stellar-sdk` from the runtime path
4. Move the ajv manifest check into a test
5. Secrets (`STELLAR_PAYEE_SECRET`, `SUPABASE_SERVICE_KEY`, `OPENZEPPELIN_API_KEY`) via
   `wrangler secret put`, never in `wrangler.jsonc`
6. `SeenTxStore` → Supabase
7. Drop `/health` uptime, or report Worker-relative values — there is no process uptime

Note: `onSettled` currently logs `provider_url: http://localhost:${PORT}/price` into
`tx_log`. That is wrong today and should become the real public URL.

### provider-b (`/stream/orderbook`, mpp-session)

Harder, because of the DO.

1. Same Hono port as provider-a
2. `ChannelState` Durable Object implementing the `Store` shape
3. Wire it in as `seenTxStore` and the mpp channel store
4. Cron Trigger for the reconciler sweep
5. Same secret and manifest handling

Two existing bugs worth fixing rather than porting:

- The manifest advertises `sse` / `realtime` and names the endpoint `/stream/orderbook`,
  but the handler returns a single JSON body via `res.json()`. It is not a stream.
  Either implement a real SSE `ReadableStream` or correct the manifest and tags.
- `onSettled` closes sessions with `.eq('channel_contract', CHANNEL_CONTRACT_ID)`
  and `.eq('status','open')`, which will close the wrong row once more than one
  session is open against the same channel contract. It should match on `channel_id`.

## DNS

Once each Worker is deployed, attach custom domains. No manual DNS records: a
Workers custom domain provisions its own proxied record and certificate, the same
way `routedock.xyz` is already wired.

| Hostname | Worker |
|---|---|
| `api-a.routedock.xyz` | `routedock-provider-a` |
| `api-b.routedock.xyz` | `routedock-provider-b` |

I have authenticated Cloudflare API access and can do this step. It has to come
after deploy, since a custom domain needs an existing Worker to bind to.

## Sequencing

1. Port provider-a, verify locally with `wrangler dev`
2. Deploy provider-a to its `workers.dev` subdomain, exercise a real testnet x402 payment
3. Attach `api-a.routedock.xyz`
4. Build the `ChannelState` DO, unit test the monotonicity invariant directly
5. Port provider-b, verify locally
6. Deploy provider-b, run a full open → voucher → close cycle on testnet
7. Attach `api-b.routedock.xyz`
8. Update `README.md`, `docs/DEPLOY_RAILWAY.md` (replace or delete), `MIGRATION.md`
9. Remove the dead Railway commit statuses from the repo integrations

Provider-a can ship independently and restores `/price` well before the DO work lands.

## Risks

- **Untested combination.** `hono.ts` claims Workers safety but there is no
  Workers test in CI. Step 2 is the first real proof. Add a `wrangler dev` smoke test.
- **mppx / @stellar/mpp / @x402 transitive deps** are audited only at the direct
  level here. A single `require`, `Buffer`, or `new Function` deep in that tree
  breaks the bundle. Verify with `wrangler deploy --dry-run` early.
- **Payee secret on Workers.** Secrets are encrypted at rest, but this key signs
  real settlements. Consider a dedicated testnet key until the mainnet path is reviewed.
- **CPU limits.** Ed25519 signing and verification per request must fit the
  Workers CPU budget. Expected to be fine, unmeasured.

## Open questions

1. Real SSE for provider-b, or correct the manifest to match the current behavior?
2. Testnet only for now, or is mainnet in scope for this migration?
3. Keep `docs/DEPLOY_RAILWAY.md` as history, or delete it?
