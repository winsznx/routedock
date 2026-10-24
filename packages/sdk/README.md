# @routedock/routedock

Unified payment execution layer for autonomous agents on Stellar. One SDK for x402, MPP charge, and MPP session — mode selected automatically from the provider's `routedock.json` manifest.

## Requirements

Node.js **22 or newer**, matching the supported runtime of all RouteDock npm packages.

## Install

```bash
npm install @routedock/routedock
```

## Agent Usage

```ts
import { RouteDockClient } from '@routedock/routedock/client'
import { Keypair } from '@stellar/stellar-sdk'

const client = new RouteDockClient({
  wallet: Keypair.fromSecret(process.env.AGENT_SECRET),
  network: 'testnet',
  spendCap: { daily: '1.00', asset: 'USDC' },
  // Required by openSession() — signs the off-chain channel vouchers.
  commitmentSecret: process.env.COMMITMENT_SECRET,
})

// Single call — SDK reads manifest, picks mode automatically
const result = await client.pay('https://provider.example.com/price')
// result.data   — response body
// result.txHash — settlement hash (or null for session vouchers)
// result.mode   — 'x402' | 'mpp-charge' | 'mpp-session' | 'mpp-session-ws'

// Sustained streaming access
const session = await client.openSession('https://provider.example.com/stream/orderbook')
let updates = 0
for await (const update of session.stream()) {
  console.log(update)
  if (++updates >= 10) break
}
await session.close() // triggers on-chain settlement
```

`commitmentSecret` is optional in the client config, but `openSession()` throws
`RouteDockManifestError` without it because every voucher must be signed.

### Spend cap and other assets

The cap is a single USDC total. If the asset selected for a payment is not
`spendCap.asset` (for example a provider that prices in XLM), `pay()` and
`openSession()` throw `RouteDockPolicyRejectError` with reason
`local_cap_asset_mismatch` before anything is paid, and nothing is added to the
USDC total. USDC-only providers are unaffected. See
`docs/MULTI_ASSET_SUPPORT.md`.


### Durable spend cap

The `spendCap` is enforced via a pluggable `SpendStore` (`read()` / `write()`).
By default the client uses an in-memory store that resets on every process
restart — and logs a startup warning — so the cap is **not** durable. For
production, inject a persistent implementation so a crash or restart can't reset
the accumulator and bypass the cap:

```ts
import { RouteDockClient, type SpendStore, type DailySpend } from '@routedock/routedock/client'

const redisSpendStore: SpendStore = {
  async read(): Promise<DailySpend | null> {
    const raw = await redis.get('routedock:dailySpend')
    return raw ? (JSON.parse(raw) as DailySpend) : null
  },
  async write(state: DailySpend): Promise<void> {
    await redis.set('routedock:dailySpend', JSON.stringify(state))
  },
}

const client = new RouteDockClient({
  wallet: Keypair.fromSecret(process.env.AGENT_SECRET),
  network: 'mainnet',
  spendCap: { daily: '1.00', asset: 'USDC' },
  spendStore: redisSpendStore,
})
```

### Trust anchor (`expectedPayee`)

A manifest is self-signed by the `payee` it declares, so a signature alone does
not prove who served it. When you learned the provider's address out of band —
from the on-chain registry or an allowlist — pass it as `expectedPayee`. Every
fetched manifest (including cache hits) must match it, or the client throws
`RouteDockSignatureError` before any payment is attempted:

```ts
const client = new RouteDockClient({
  wallet: process.env.AGENT_SECRET!,
  network: 'mainnet',
  expectedPayee: 'G...REGISTERED_PROVIDER_PAYEE',
})
```

Set this whenever the provider address came from a registry or an allowlist.
Omitting it leaves only self-signed authenticity, which is not enough for
routing trust.

### Manifest caching

The client fetches `/.well-known/routedock.json` and caches it per origin for
**60 seconds by default**. The provider can override that with
`Cache-Control: max-age`, which wins over an `Expires` header. `Cache-Control:
no-store` or `no-cache` disables caching, and `max-age=0` makes the entry
immediately stale.

Call `client.invalidateManifest(url)` to evict the cached copy immediately, so
the next `pay()`, `estimateCost()`, or `openSession()` re-fetches it — useful
after a provider announces a pricing or mode change:

```ts
client.invalidateManifest('https://provider.example.com/price')
```

### `estimateCost()` and `preflight()`

Both methods are read-only and submit no transaction. Use them as an approval
gate before paying:

```ts
const estimate = await client.estimateCost(
  'https://provider.example.com/price',
  { optimize: 'cost', budget_per_request: '0.002' },
)
// estimate.amount  — expected charge (decimal string)
// estimate.asset   — selected payment asset
// estimate.mode    — mode that would be used
// estimate.manifest — full manifest for budget/routing decisions

const preflight = await client.preflight(
  estimate.manifest,
  estimate.mode,
  'https://provider.example.com/price',
)
// preflight.hasTrustline — payer has the required trustline (throws otherwise)
// preflight.asset, preflight.modes, preflight.regions, preflight.capabilities
```

`preflight()` verifies the payer's trustline on Horizon and surfaces the
manifest's regions, latency hints, and capabilities. A missing trustline
throws `RouteDockTrustlineError` with an exact `stellar tx new ... change-trust`
remediation command.

### Manifest signatures (`signature_version` 2)

Providers must sign manifests with `signManifest` from this SDK. It sets
`signature_version: '2'`, which covers nested fields recursively; legacy
signatures did not, so clients reject any manifest whose `signature_version`
is not `'2'` with `RouteDockSignatureError`. Unsigned manifests are rejected
too:

```ts
import { signManifest } from '@routedock/routedock'

const signed = signManifest(manifest, process.env.STELLAR_PAYEE_SECRET!)
```

`routedock()` and `routedockHono()` already call `signManifest` with
`payeeSecretKey`, so this is only needed when producing a signed manifest
outside the middleware.

On Node you can use the file-backed store instead. It depends on `node:fs`, so it
lives in a Node-only entry point and is **not** exported from `/client`:

```ts
import { RouteDockClient } from '@routedock/routedock/client'
import { FileSpendStore } from '@routedock/routedock/node' // Node only (node:fs)

const client = new RouteDockClient({
  // ...
  spendStore: new FileSpendStore('~/.routedock/spend.json'),
})
```

**Sharing one store between processes.** The client serializes its own
read → check → write, but that only protects one `RouteDockClient`. If two
processes can use the same store (the MCP server and the example agent both
default to `~/.routedock/spend.json`), a plain `read()` / `write()` store can
lose updates and let the cap be exceeded. A shared store must implement the
optional atomic `update(fn)` method, which the client uses automatically.
`FileSpendStore` implements it with an exclusive lock file
(`<file>.lock`, stale locks from crashed processes are broken after 10 s):

```ts
const store: SpendStore = {
  read, write,
  // fn(prev) returns the next state, or undefined to leave it unchanged.
  // Make the read, fn and write atomic (a transaction, CAS loop, lock, ...).
  async update(fn) { /* ... */ },
}
```

## Provider Usage

```ts
import express from 'express'
import { routedock } from '@routedock/routedock/provider'

const app = express()

app.use('/price', routedock({
  modes: ['x402', 'mpp-charge'],
  pricing: { x402: '0.001', 'mpp-charge': '0.0008' },
  asset: 'USDC',
  assetContract: process.env.USDC_ASSET_CONTRACT,
  payee: process.env.STELLAR_PAYEE_ADDRESS,
  network: 'testnet',
  payeeSecretKey: process.env.STELLAR_PAYEE_SECRET,
  manifest,
  onSettled: async (txHash, amount, mode) => {
    console.log(`settled: ${mode} ${amount} USDC — ${txHash}`)
  },
}))
```

## Session Lifecycle Hooks

For `mpp-session` mode, the middleware exposes three hooks that fire at each stage of the payment channel lifecycle:

```ts
app.use('/stream', routedock({
  modes: ['mpp-session'],
  pricing: { 'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_FACTORY } },
  asset: 'USDC',
  assetContract: USDC_ASSET_CONTRACT,
  payee: PAYEE_ADDRESS,
  network: 'testnet',
  payeeSecretKey: PAYEE_SECRET,
  manifest,
  commitmentPublicKey: COMMITMENT_PUBLIC_KEY,

  // Fires once when the first voucher is verified for a new session
  onSessionOpen: async (channelId, payer) => {
    await db.from('sessions').insert({
      channel_id: channelId,
      payer,
      status: 'open',
      voucher_count: 0,
    })
  },

  // Fires after each verified ed25519 commitment (off-chain, no tx fee).
  // cumulativeAmount is a decimal string — keep it as a string in the DB.
  onVoucher: async (channelId, voucherIndex, cumulativeAmount, signature) => {
    await db.from('sessions').update({
      voucher_count: voucherIndex,
      cumulative_amount: cumulativeAmount,
      last_signature: signature,
    }).eq('channel_id', channelId)
  },

  // Fires after the on-chain channel close settles the cumulative amount.
  // onSettled receives no channel ID, so filter on the configured factory —
  // the handler reports that same value as channelId to the other hooks.
  onSettled: async (txHash, totalPaid, mode, payer) => {
    await db.from('sessions').update({
      status: 'closed',
      settlement_tx_hash: txHash,
      payer,
    }).eq('channel_id', CHANNEL_FACTORY)
  },
}))
```

| Hook | When it fires | On-chain? |
|---|---|---|
| `onSessionOpen(channelId, payer)` | First verified voucher in a new session | No |
| `onVoucher(channelId, voucherIndex, cumulativeAmount, signature)` | Each verified ed25519 commitment | No |
| `onSettled(txHash, amount, mode, payer)` | Channel close transaction confirmed | Yes |

## Running a provider in production

The `routedockHono` defaults — `InMemorySeenTxStore` for `seenTxStore` and
`Store.memory()` for `sessionStore` — are only safe in a single long-lived
process. Any runtime that can route requests to different isolates or
processes (Cloudflare Workers, Deno Deploy, Lambda@Edge, or even a
multi-instance Node deployment) needs the durable stores below, or an agent
retry can settle a payment twice or lose voucher tracking mid-session.

### Settlement idempotency (`seenTxStore`)

`seenTxStore` guards against double-settlement when an agent retries the same
payment after a timeout. The in-memory default is per-handler and per-process,
so a retry landing in a fresh isolate misses the cache and settles again,
charging twice on-chain.

`SupabaseSeenTxStore` backs it with Postgres, which gives the read-your-writes
consistency this needs. **Don't use Workers KV here** — it's eventually
consistent, so a retry can outrun propagation and reintroduce the double
settle.

Requires the `settlements` table from migration `003_settlement_idempotency`
(see `supabase/migrations/003_settlement_idempotency.sql`; the follow-up
migration `004_settlement_retention.sql` adds cleanup for old rows). The store
needs two required methods, `get`/`set`, plus an optional `claimReplay`;
`SupabaseSeenTxStore` also needs `006_settlement_replay_limit.sql`. The
idempotency key is scoped to the method, path, amount and payee, and a cached
settlement is only replayed within a 60s window and a bounded number of times:

```ts
import { createClient } from '@supabase/supabase-js'
import { routedockHono, SupabaseSeenTxStore } from '@routedock/routedock/provider/hono'

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY)
const seenTxStore = new SupabaseSeenTxStore(supabase)

app.use('*', routedockHono({
  modes: ['x402', 'mpp-charge'],
  pricing: { x402: '0.001', 'mpp-charge': '0.0008' },
  asset: 'USDC',
  assetContract: env.USDC_ASSET_CONTRACT,
  payee: env.STELLAR_PAYEE_ADDRESS,
  payeeSecretKey: env.STELLAR_PAYEE_SECRET,
  network: 'testnet',
  manifest,
  seenTxStore,
}))
```

On Cloudflare Workers, `InMemorySeenTxStore` logs a `console.warn` when
constructed so this isn't missed silently — but that check only detects the
Workers user agent, so Bun and Deno operators get no warning today. Don't rely
on it; wire a durable store explicitly.

### Session state (`sessionStore`)

`sessionStore` backs the `mpp-session` channel store (voucher monotonicity
tracking). The in-memory default doesn't survive isolate eviction, and
`MppSessionClient` issues one HTTP request per voucher — so voucher N and
voucher N+1 can land in different isolates entirely.

> **Note:** this `sessionStore` option takes a `@stellar/mpp` `Store.Store`.
> That's a different thing from this SDK's own `SessionStore` /
> `SupabaseSessionStore` (in `packages/sdk/src/store/SessionStore.ts`), which
> is a separate interface over the Supabase `sessions` table used for
> dashboards and reconciliation. Don't confuse the two.

On Cloudflare Workers, back it with a Durable Object per channel so voucher
reads and writes serialize through one instance:

```ts
import { DurableObject } from 'cloudflare:workers'
import { Hono } from 'hono'
import { routedockHono } from '@routedock/routedock/provider/hono'
import { Store } from '@stellar/mpp/channel/server'

// The provider needs @stellar/mpp as a direct dependency for Store.

export class ChannelSession extends DurableObject<Env> {
  private app: Hono | null = null

  private buildApp(): Hono {
    const env = this.env
    const sessionStore = Store.from({
      get: (key: string) => this.ctx.storage.get(key),
      put: (key: string, value: unknown) => this.ctx.storage.put(key, value),
      delete: async (key: string) => {
        await this.ctx.storage.delete(key)
      },
    })

    const app = new Hono()
    app.use('*', routedockHono({
      modes: ['mpp-session'],
      pricing: {
        'mpp-session': { rate: '0.0001', channelFactory: env.CHANNEL_CONTRACT_ID },
      },
      asset: 'USDC',
      assetContract: env.USDC_ASSET_CONTRACT,
      payee: env.STELLAR_PAYEE_ADDRESS,
      payeeSecretKey: env.STELLAR_PAYEE_SECRET,
      network: 'testnet',
      commitmentPublicKey: env.COMMITMENT_PUBLIC_KEY!,
      sessionStore,
      manifest,
    }))
    return app
  }

  override async fetch(request: Request): Promise<Response> {
    this.app ??= this.buildApp()
    return this.app.fetch(request)
  }
}
```

Route all requests for a given channel to the same object, keyed by channel
contract, so vouchers for one channel always serialize through one instance:

```ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = env.CHANNEL_SESSION.idFromName(env.CHANNEL_CONTRACT_ID)
    return env.CHANNEL_SESSION.get(id).fetch(request)
  },
}
```

Wire the binding and migration in `wrangler.jsonc`:

```jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "CHANNEL_SESSION", "class_name": "ChannelSession" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ChannelSession"] }]
}
```

**Limitation:** the Durable Object persists the `@stellar/mpp` channel store
only. `routedockHono` still tracks `lastCumulativeAmount`, `voucherCount`,
`lastSignatureHex` and `sessionPayerAddress` in closure scope, so if the
instance is evicted mid-session those reset, and the close path falls back to
the client-supplied amount and signature. Moving them into the same durable
store is tracked separately — check the current state of that work before
relying on it.

### Orphaned sessions and reconciliation

Without recovery wiring, a session abandoned mid-stream (client disconnects,
goes idle) just sits open forever with funds locked in the channel. Two pieces
are required together:

`onOrphaned` writes the session row as `status: 'closing'` (the `sessions`
table comes from migration `001_init.sql`) so the reconciler can find it.

`idleTimeoutMs` has to be set explicitly. Without it no idle timer is armed,
and an idle (as opposed to disconnected) session is never flagged orphaned.

On Cloudflare Workers it doesn't help yet. The idle timer is a `setTimeout`
inside the Durable Object, and Cloudflare evicts an idle object after roughly
70 to 140 seconds, so the timer never fires. provider-b has the same gap, see
[#314](https://github.com/winsznx/routedock/issues/314).

The status and cumulative-amount fields need to be written separately.
Writing `cumulative_amount` in the same update as `status: 'closing'` can
collide with the `monotonic_cumulative` trigger (`supabase/migrations/001_init.sql:40,48-50`),
which rejects any update where the new amount isn't strictly greater than the
stored one — and `onVoucher` has usually already stored that exact amount, so
the combined update silently fails and the row never reaches `closing`. This
is the same bug tracked as [#338](https://github.com/winsznx/routedock/issues/338):

```ts
app.use('*', routedockHono({
  // ...
  idleTimeoutMs: 5 * 60_000,
  onOrphaned: async (channelId, info) => {
    await supabase.from('sessions')
      .update({ status: 'closing' })
      .eq('channel_id', channelId)
    await supabase.from('sessions')
      .update({
        cumulative_amount: info.cumulativeAmount,
        last_signature: info.lastSignature || null,
        voucher_count: info.voucherCount,
      })
      .eq('channel_id', channelId)
      .lt('cumulative_amount', info.cumulativeAmount)
  },
}))
```

Then schedule `reconcileAbandonedSessions` to actually settle those `closing`
sessions with their latest voucher:

```ts
import { reconcileAbandonedSessions } from '@routedock/routedock/provider/hono'

export default {
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    await reconcileAbandonedSessions({
      supabase,
      network: 'testnet',
      payeeSecretKey: env.STELLAR_PAYEE_SECRET,
      onRecovered: async (channelId, txHash, totalPaid) => {
        console.log(`[reconcile] recovered ${channelId}: ${txHash} (${totalPaid} USDC)`)
      },
    })
  },
}
```

Trigger it on a schedule in `wrangler.jsonc`:

```jsonc
{
  "triggers": {
    "crons": ["*/15 * * * *"]
  }
}
```

### Registering in discovery

A provider doesn't show up in the discovery registry unless it registers
itself. Sign the manifest, then call `registerProvider` inside
`ctx.waitUntil(...)` with a `.catch` so a registry hiccup never blocks serving
a request:

```ts
import { registerProvider, signManifest } from '@routedock/routedock/provider/hono'

const signed = signManifest(manifest, env.STELLAR_PAYEE_SECRET)
ctx.waitUntil(
  registerProvider({
    supabase,
    manifest: signed,
    baseUrl: 'https://your-provider.example.com',
  }).catch((err) => {
    console.error('[registry] failed to register provider:', err)
  }),
)
```

This writes to the `providers` table from migration `001_init.sql`.

### Serving `mpp-session-ws`

`mpp-session-ws` upgrades the HTTP connection to a WebSocket after the
handshake's payment is verified. Hono's `upgradeWebSocket` calls its callback
before it looks at the `Upgrade` header, so a guard placed only inside that
callback (throwing when `mppSessionWsVerified(c)` is false) also fires — and
throws — for an ordinary `mpp-session` GET on the same route, which has
nothing to do with a WebSocket handshake. Check the header in a separate
middleware ahead of the upgrade route instead, and let a second, plain route
serve `mpp-session` requests once the payment middleware has verified them:

```ts
import { upgradeWebSocket } from 'hono/cloudflare-workers'
import { routedockHono, mppSessionWsVerified } from '@routedock/routedock/provider/hono'

app.use('*', routedockHono({
  modes: ['mpp-session', 'mpp-session-ws'],
  pricing: {
    'mpp-session': { rate: '0.0001', channelFactory: env.CHANNEL_CONTRACT_ID },
    'mpp-session-ws': { rate: '0.0001', channelFactory: env.CHANNEL_CONTRACT_ID },
  },
  asset: 'USDC',
  assetContract: env.USDC_ASSET_CONTRACT,
  payee: env.STELLAR_PAYEE_ADDRESS,
  payeeSecretKey: env.STELLAR_PAYEE_SECRET,
  network: 'testnet',
  commitmentPublicKey: env.COMMITMENT_PUBLIC_KEY!,
  manifest,
}))

app.get(
  '/stream',
  async (c, next) => {
    const isUpgrade = c.req.header('upgrade')?.toLowerCase() === 'websocket'
    if (isUpgrade && !mppSessionWsVerified(c)) {
      return c.json({ error: 'refusing unverified WebSocket handshake' }, 403)
    }
    await next()
  },
  upgradeWebSocket(() => ({
    onMessage: (_evt, ws) => {
      ws.send(JSON.stringify({ type: 'ack' }))
    },
  })),
)

// mpp-session (HTTP) requests land here after the middleware verified the voucher.
app.get('/stream', (c) => c.json({ data: '...' }))
```

### Workers-safe imports

Every snippet above imports from `@routedock/routedock/provider/hono`, which
re-exports `routedockHono`, `mppSessionWsVerified`, `registerProvider`,
`signManifest`, `SupabaseSeenTxStore` and `reconcileAbandonedSessions`. Don't
import from `@routedock/routedock/provider` in a Workers snippet — that's the
Node-only Express entry point and pulls in dependencies (like `express`) that
don't run on Workers.

### Runtime-neutral entry points

`@routedock/routedock/client`, `/react` and `/provider/hono` use only
Web-standard APIs. They run in browsers, Cloudflare Workers (no `nodejs_compat`
needed for this package), Bun, Deno and Node, and contain no `node:*` imports or
`Buffer` references. CI enforces this (`node scripts/check-runtime-neutral.mjs`)
against the built output.

Anything that needs Node built-ins is kept out of those entries:

| Import | Runtime | Notes |
| --- | --- | --- |
| `@routedock/routedock/client`, `/react`, `/provider/hono` | any | runtime-neutral |
| `@routedock/routedock/node` | Node only | `FileSpendStore` (`node:fs`) |
| `@routedock/routedock/provider`, `/provider/fastify` | Node only | Express/Fastify adapters |
| `@routedock/routedock` | Node | full SDK, includes `FileSpendStore` |

Third-party dependencies are outside this guarantee: for example `mppx` imports
`node:util`, so a Worker that uses it can still need `nodejs_compat`.

## React Integration

> **Warning:** These hooks create a RouteDockClient in the browser, so the wallet secret and any commitmentSecret are readable by anyone who loads the page.
>
> Next.js inlines every `NEXT_PUBLIC_*` variable into the client bundle at build time, so never put a Stellar secret in one.
>
> Only use these hooks with a dedicated, low-balance testnet key, and spendCap does not protect a key that has leaked.
>
> For production or mainnet, keep RouteDockClient on the server (a route handler or server action) and read the key from a non-public variable such as `AGENT_SECRET`, as the Agent Usage section does.

`@routedock/routedock/react` provides hooks for client construction, payments, sessions, and live tx log subscription. Wrap your app with `RouteDockProvider`:

```tsx
import { RouteDockProvider, useRouteDockClient } from '@routedock/routedock/react'
import { createClient } from '@supabase/supabase-js'

// Dedicated throwaway testnet key. Never a funded or mainnet key.
const THROWAWAY_TESTNET_SECRET = 'S...'

function App({ children }: { children: React.ReactNode }) {
  const client = useRouteDockClient({
    wallet: THROWAWAY_TESTNET_SECRET,
    network: 'testnet',
    spendCap: { daily: '1.00', asset: 'USDC' },
  })
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
  return (
    <RouteDockProvider client={client} supabase={supabase}>
      {children}
    </RouteDockProvider>
  )
}
```

### Paying from the server

```ts
// app/api/price/route.ts (runs on the server only)
import { RouteDockClient } from '@routedock/routedock/client'

const client = new RouteDockClient({
  wallet: process.env.AGENT_SECRET!,
  network: 'testnet',
  spendCap: { daily: '1.00', asset: 'USDC' },
})

export async function POST() {
  const result = await client.pay('https://provider.example.com/price')
  return Response.json({ mode: result.mode, txHash: result.txHash, data: result.data })
}
```

### `usePay(url, options?)`

```tsx
import { usePay } from '@routedock/routedock/react'

function PriceButton() {
  const { pay, result, loading, error } = usePay('https://provider.example.com/price')
  if (error) return <span>Error: {error.message}</span>
  return (
    <button onClick={pay} disabled={loading}>
      {loading ? 'Paying…' : result ? `Paid: ${result.txHash}` : 'Pay 0.001 USDC'}
    </button>
  )
}
```

### `useSession(url)`

```tsx
import { useEffect } from 'react'
import { useSession } from '@routedock/routedock/react'

function StreamingFeed() {
  const { open, close, status, vouchers, cumulative } = useSession(
    'https://provider.example.com/stream/orderbook',
  )
  useEffect(() => { void open() }, [])
  return (
    <div>
      <p>Status: {status} — vouchers: {vouchers} — paid: {cumulative} USDC</p>
      <button onClick={close} disabled={status !== 'open'}>Close & settle</button>
    </div>
  )
}
```

The hook automatically fires `session.close()` in the background on unmount when status is `open` (best-effort settlement).

### `useTxLog(filter?)`

```tsx
import { useTxLog } from '@routedock/routedock/react'

function ActivityFeed({ channelId }: { channelId: string }) {
  const txLog = useTxLog({ channelId, limit: 25 })
  return (
    <ul>
      {txLog.map((row) => (
        <li key={row.id}>{row.mode} — {row.amount} USDC — {row.tx_hash}</li>
      ))}
    </ul>
  )
}
```

| Hook | Returns | Requires from `RouteDockProvider` |
|---|---|---|
| `useRouteDockClient(config)` | Memoized `RouteDockClient` | — (creator hook) |
| `usePay(url, options?)` | `{ pay, result, loading, error }` | `client` |
| `useSession(url)` | `{ session, status, vouchers, cumulative, error, open, close }` | `client` (with `commitmentSecret`) |
| `useTxLog(filter?)` | `TxLogRow[]` (newest first) | `supabase` |

React is a peer dependency — install `react@^18` (or `^19`) in your app.

---

## Error Handling

All SDK failures extend `RouteDockError` with a stable `code`, `retryable` flag, and optional `cause`. Transient failures (network timeouts, facilitator 5xx, Horizon RPC errors) are retried automatically with exponential backoff unless you disable retries.

```ts
import {
  RouteDockClient,
  RouteDockError,
  RouteDockFacilitatorError,
  RouteDockManifestError,
  RouteDockPaymentRejectedError,
  RouteDockPolicyRejectError,
} from '@routedock/routedock/client'

const client = new RouteDockClient({
  wallet: process.env.AGENT_SECRET!,
  network: 'testnet',
  retryPolicy: { maxAttempts: 4, baseDelayMs: 250 },
})

try {
  const result = await client.pay('https://provider.example.com/price')
  console.log(result.mode, result.txHash)
} catch (err) {
  if (err instanceof RouteDockPolicyRejectError) {
    console.error('Spend cap exceeded:', err.reason)
  } else if (err instanceof RouteDockPaymentRejectedError) {
    // The provider refused the signed payment; `reason` is its explanation.
    console.error(`Payment rejected (HTTP ${err.status}):`, err.reason ?? err.providerError)
  } else if (err instanceof RouteDockFacilitatorError) {
    console.error(`Facilitator HTTP ${err.status} (retryable=${err.retryable})`)
  } else if (err instanceof RouteDockManifestError) {
    console.error('Manifest or config problem:', err.message)
  } else if (err instanceof RouteDockError) {
    console.error(`[${err.code}] ${err.message} (retryable=${err.retryable})`)
  } else {
    throw err
  }
}
```

| Error | `retryable` | Typical cause |
|---|---|---|
| `RouteDockManifestError` | no | Invalid manifest, missing pricing fields |
| `RouteDockNoSupportedModeError` | no | Provider has no compatible payment mode |
| `RouteDockFacilitatorError` | yes | Facilitator/provider 429 or 5xx |
| `RouteDockPaymentRejectedError` | no | Provider refused the signed paid request (HTTP 401/402/other 4xx); `status` and `reason` carry why |
| `RouteDockNetworkError` | yes | Timeouts, connection failures |
| `RouteDockSignatureError` | no | Signing or commitment failure |
| `RouteDockVoucherMonotonicityError` | no | Non-increasing voucher amount |
| `RouteDockPolicyRejectError` | no | Local spend cap exceeded |
| `RouteDockChannelStateError` | no | Channel simulate/close invariant violation |

## Mode Selection Logic

`ModeRouter` selects deterministically — there is no randomness. The rules, in
order:

1. **`forceMode`** is authoritative. If the manifest does not advertise it, the
   client throws `RouteDockNoSupportedModeError`. A forced mode listed in
   `deprecated_modes` is still used, with a warning.
2. **Active modes are considered before deprecated ones.** Modes listed in
   `deprecated_modes` are only tried as a compatibility fallback, and selecting
   one logs a warning. If neither pass can select a mode, the client throws
   `RouteDockNoSupportedModeError`.
3. **Sustained sessions** (`sustained: true` or `session: true`):
   - `transport: 'websocket'` prefers `mpp-session-ws`, falling back to
     `mpp-session` if the provider does not advertise the WebSocket variant.
   - With `transport` omitted (or `'sse'`), `mpp-session` is preferred, falling
     back to `mpp-session-ws`.
4. **Cost optimization** (`optimize: 'cost'`) compares the per-request modes
   the provider advertises (`x402` and `mpp-charge`) and picks the cheapest.
   `budget_per_request` adds a ceiling: candidates above it are excluded, and
   if every candidate is over budget the client throws
   `RouteDockPolicyRejectError('budget_per_request_exceeded')`. A malformed
   `budget_per_request` throws
   `RouteDockPolicyRejectError('invalid_budget_per_request')` rather than
   silently disabling the ceiling.
5. **Default order** when nothing above applies: `mpp-charge`, then `x402`.
   If the provider supports neither, the client throws
   `RouteDockNoSupportedModeError`.

```ts
// Inspect the session mode selection without paying.
const estimate = await client.estimateCost(url, {
  sustained: true,
  transport: 'websocket',
})

// Cheapest per-request mode within a ceiling.
await client.pay(url, { optimize: 'cost', budget_per_request: '0.002' })

// Bypass auto-selection.
await client.pay(url, { forceMode: 'x402' })

// For sustained access, openSession() takes the mode directly.
const session = await client.openSession(url, { mode: 'mpp-session-ws' })
```

## Dispute Resolution

For `mpp-session` mode, the session handle exposes three methods to handle server unavailability or crashes:

```ts
const session = await client.openSession('https://provider.example.com/stream')

// Check the current dispute status (open, in-refund-window, refundable, settled)
const status = await session.getDisputeStatus()

// If server is unresponsive, request a refund (starts the refund window)
const refundTxHash = await session.requestRefund()

// Server-side: settle with the latest signed voucher before refund window expires
const settleTxHash = await session.settleWithLatestVoucher()
```

| Method | Purpose | Requires | Returns |
|--------|---------|----------|---------|
| `getDisputeStatus()` | Query channel state | None | `'open' \| 'in-refund-window' \| 'refundable' \| 'settled'` |
| `requestRefund()` | Initiate refund process | Signed agent keypair | Transaction hash (string) |
| `settleWithLatestVoucher()` | Server counter-settle | Latest voucher signature | Transaction hash (string) |

Raises: `RouteDockDisputeError`, `RouteDockChannelStateError`, `RouteDockRefundWindowError`

## Security

The `one-way-channel` Soroban contract wrapped by `MppSessionClient` is **unaudited** (`stellar-experimental/one-way-channel`). Safe defaults are enforced: 17280 ledger refund window, monotonic cumulative enforcement at application, database, and contract layers. Production mainnet use should await a formal audit.

## License

MIT
