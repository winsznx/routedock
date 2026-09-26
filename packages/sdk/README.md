# @routedock/sdk

Unified payment execution layer for autonomous agents on Stellar. One SDK for x402, MPP charge, and MPP session — mode selected automatically from the provider's `routedock.json` manifest.

## Install

```bash
npm install @routedock/sdk
```

## Agent Usage

```ts
import { RouteDockClient } from "@routedock/sdk/client";
import { Keypair } from "@stellar/stellar-sdk";

const client = new RouteDockClient({
  wallet: Keypair.fromSecret(process.env.AGENT_SECRET),
  network: "testnet",
  spendCap: { daily: "1.00", asset: "USDC" },
});

// Single call — SDK reads manifest, picks mode automatically
const result = await client.pay("https://provider.example.com/price");
// result.data   — response body
// result.txHash — settlement hash (or null for session vouchers)
// result.mode   — 'x402' | 'mpp-charge' | 'mpp-session'

// Sustained streaming access
const session = await client.openSession(
  "https://provider.example.com/stream/orderbook",
);
for await (const update of session.stream()) {
  console.log(update);
  if (done) break;
}
await session.close(); // triggers on-chain settlement
```

### Durable spend cap

The `spendCap` is enforced via a pluggable `SpendStore` (`read()` / `write()`).
By default the client uses an in-memory store that resets on every process
restart — and logs a startup warning — so the cap is **not** durable. For
production, inject a persistent implementation so a crash or restart can't reset
the accumulator and bypass the cap:

```ts
import {
  RouteDockClient,
  type SpendStore,
  type DailySpend,
} from "@routedock/sdk/client";

const redisSpendStore: SpendStore = {
  async read(): Promise<DailySpend | null> {
    const raw = await redis.get("routedock:dailySpend");
    return raw ? (JSON.parse(raw) as DailySpend) : null;
  },
  async write(state: DailySpend): Promise<void> {
    await redis.set("routedock:dailySpend", JSON.stringify(state));
  },
};

const client = new RouteDockClient({
  wallet: Keypair.fromSecret(process.env.AGENT_SECRET),
  network: "mainnet",
  spendCap: { daily: "1.00", asset: "USDC" },
  spendStore: redisSpendStore,
});
```

## Provider Usage

```ts
import express from "express";
import { routedock } from "@routedock/sdk/provider";

const app = express();

app.use(
  "/price",
  routedock({
    modes: ["x402", "mpp-charge"],
    pricing: { x402: "0.001", "mpp-charge": "0.0008" },
    asset: "USDC",
    assetContract: process.env.USDC_ASSET_CONTRACT,
    payee: process.env.STELLAR_PAYEE_ADDRESS,
    network: "testnet",
    payeeSecretKey: process.env.STELLAR_PAYEE_SECRET,
    manifest,
    onSettled: async (txHash, amount, mode) => {
      console.log(`settled: ${mode} ${amount} USDC — ${txHash}`);
    },
  }),
);
```

## Session Lifecycle Hooks

For `mpp-session` mode, the middleware exposes three hooks that fire at each stage of the payment channel lifecycle:

```ts
app.use(
  "/stream",
  routedock({
    modes: ["mpp-session"],
    pricing: {
      "mpp-session": { rate: "0.0001", channelContract: CHANNEL_CONTRACT },
    },
    asset: "USDC",
    assetContract: USDC_ASSET_CONTRACT,
    payee: PAYEE_ADDRESS,
    network: "testnet",
    payeeSecretKey: PAYEE_SECRET,
    manifest,
    commitmentPublicKey: COMMITMENT_PUBLIC_KEY,

    // Fires once when the first voucher is verified for a new session
    onSessionOpen: async (channelId) => {
      await db.from("sessions").insert({
        channel_id: channelId,
        status: "open",
        voucher_count: 0,
      });
    },

    // Fires after each verified ed25519 commitment (off-chain, no tx fee)
    onVoucher: async (voucherIndex, cumulativeAmount) => {
      await db
        .from("sessions")
        .update({
          voucher_count: voucherIndex,
          cumulative_amount: parseFloat(cumulativeAmount),
        })
        .eq("channel_id", channelId);
    },

    // Fires after the on-chain channel close settles the cumulative amount
    onSettled: async (txHash, totalPaid, mode) => {
      await db
        .from("sessions")
        .update({
          status: "closed",
          settlement_tx_hash: txHash,
        })
        .eq("channel_id", channelId);
    },
  }),
);
```

| Hook                                 | When it fires                           | On-chain? |
| ------------------------------------ | --------------------------------------- | --------- |
| `onSessionOpen(channelId)`           | First verified voucher in a new session | No        |
| `onVoucher(index, cumulativeAmount)` | Each verified ed25519 commitment        | No        |
| `onSettled(txHash, amount, mode)`    | Channel close transaction confirmed     | Yes       |

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
migration `004_settlement_retention.sql` adds cleanup for old rows):

```ts
import { createClient } from "@supabase/supabase-js";
import {
  routedockHono,
  SupabaseSeenTxStore,
} from "@routedock/routedock/provider/hono";

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
const seenTxStore = new SupabaseSeenTxStore(supabase);

app.use(
  "*",
  routedockHono({
    modes: ["x402", "mpp-charge"],
    pricing: { x402: "0.001", "mpp-charge": "0.0008" },
    asset: "USDC",
    assetContract: env.USDC_ASSET_CONTRACT,
    payee: env.STELLAR_PAYEE_ADDRESS,
    payeeSecretKey: env.STELLAR_PAYEE_SECRET,
    network: "testnet",
    manifest,
    seenTxStore,
  }),
);
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
import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import { routedockHono } from "@routedock/routedock/provider/hono";
import { Store } from "@stellar/mpp/channel/server";

// The provider needs @stellar/mpp as a direct dependency for Store.

export class ChannelSession extends DurableObject<Env> {
  private app: Hono | null = null;

  private buildApp(): Hono {
    const env = this.env;
    const sessionStore = Store.from({
      get: (key: string) => this.ctx.storage.get(key),
      put: (key: string, value: unknown) => this.ctx.storage.put(key, value),
      delete: async (key: string) => {
        await this.ctx.storage.delete(key);
      },
    });

    const app = new Hono();
    app.use(
      "*",
      routedockHono({
        modes: ["mpp-session"],
        pricing: {
          "mpp-session": {
            rate: "0.0001",
            channelFactory: env.CHANNEL_CONTRACT_ID,
          },
        },
        asset: "USDC",
        assetContract: env.USDC_ASSET_CONTRACT,
        payee: env.STELLAR_PAYEE_ADDRESS,
        payeeSecretKey: env.STELLAR_PAYEE_SECRET,
        network: "testnet",
        commitmentPublicKey: env.COMMITMENT_PUBLIC_KEY!,
        sessionStore,
        manifest,
      }),
    );
    return app;
  }

  override async fetch(request: Request): Promise<Response> {
    this.app ??= this.buildApp();
    return this.app.fetch(request);
  }
}
```

Route all requests for a given channel to the same object, keyed by channel
contract, so vouchers for one channel always serialize through one instance:

```ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = env.CHANNEL_SESSION.idFromName(env.CHANNEL_CONTRACT_ID);
    return env.CHANNEL_SESSION.get(id).fetch(request);
  },
};
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
`idleTimeoutMs` has to be set explicitly — without it, no idle timer is armed
and an idle (as opposed to disconnected) session is never flagged orphaned.
This is a Workers-only gap: the idle timer is a `setTimeout` inside the
Durable Object, and Cloudflare evicts an idle object after roughly 70–140
seconds, taking the timer with it — so `idleTimeoutMs` never fires on Workers
either way. provider-b currently has no `idleTimeoutMs` at all and its abort
path only covers the first request; see #314.

The status and cumulative-amount fields need to be written separately.
Writing `cumulative_amount` in the same update as `status: 'closing'` can
collide with the `monotonic_cumulative` trigger (`supabase/migrations/001_init.sql:40,48-50`),
which rejects any update where the new amount isn't strictly greater than the
stored one — and `onVoucher` has usually already stored that exact amount, so
the combined update silently fails and the row never reaches `closing`. This
is the same bug tracked as #338:

```ts
app.use(
  "*",
  routedockHono({
    // ...
    idleTimeoutMs: 5 * 60_000,
    onOrphaned: async (channelId, info) => {
      await supabase
        .from("sessions")
        .update({ status: "closing" })
        .eq("channel_id", channelId);
      await supabase
        .from("sessions")
        .update({
          cumulative_amount: info.cumulativeAmount,
          last_signature: info.lastSignature || null,
          voucher_count: info.voucherCount,
        })
        .eq("channel_id", channelId)
        .lt("cumulative_amount", info.cumulativeAmount);
    },
  }),
);
```

Then schedule `reconcileAbandonedSessions` to actually settle those `closing`
sessions with their latest voucher:

```ts
import { reconcileAbandonedSessions } from "@routedock/routedock/provider/hono";

export default {
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    await reconcileAbandonedSessions({
      supabase,
      network: "testnet",
      payeeSecretKey: env.STELLAR_PAYEE_SECRET,
      onRecovered: async (channelId, txHash, totalPaid) => {
        console.log(
          `[reconcile] recovered ${channelId}: ${txHash} (${totalPaid} USDC)`,
        );
      },
    });
  },
};
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
import {
  registerProvider,
  signManifest,
} from "@routedock/routedock/provider/hono";

const signed = signManifest(manifest, env.STELLAR_PAYEE_SECRET);
ctx.waitUntil(
  registerProvider({
    supabase,
    manifest: signed,
    baseUrl: "https://your-provider.example.com",
  }).catch((err) => {
    console.error("[registry] failed to register provider:", err);
  }),
);
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
import { upgradeWebSocket } from "hono/cloudflare-workers";
import {
  routedockHono,
  mppSessionWsVerified,
} from "@routedock/routedock/provider/hono";

app.use(
  "*",
  routedockHono({
    modes: ["mpp-session", "mpp-session-ws"],
    pricing: {
      "mpp-session": {
        rate: "0.0001",
        channelFactory: env.CHANNEL_CONTRACT_ID,
      },
      "mpp-session-ws": {
        rate: "0.0001",
        channelFactory: env.CHANNEL_CONTRACT_ID,
      },
    },
    asset: "USDC",
    assetContract: env.USDC_ASSET_CONTRACT,
    payee: env.STELLAR_PAYEE_ADDRESS,
    payeeSecretKey: env.STELLAR_PAYEE_SECRET,
    network: "testnet",
    commitmentPublicKey: env.COMMITMENT_PUBLIC_KEY!,
    manifest,
  }),
);

app.get(
  "/stream",
  async (c, next) => {
    const isUpgrade = c.req.header("upgrade")?.toLowerCase() === "websocket";
    if (isUpgrade && !mppSessionWsVerified(c)) {
      return c.json({ error: "refusing unverified WebSocket handshake" }, 403);
    }
    await next();
  },
  upgradeWebSocket(() => ({
    onMessage: (_evt, ws) => {
      ws.send(JSON.stringify({ type: "ack" }));
    },
  })),
);

// mpp-session (HTTP) requests land here after the middleware verified the voucher.
app.get("/stream", (c) => c.json({ data: "..." }));
```

### Workers-safe imports

Every snippet above imports from `@routedock/routedock/provider/hono`, which
re-exports `routedockHono`, `mppSessionWsVerified`, `registerProvider`,
`signManifest`, `SupabaseSeenTxStore` and `reconcileAbandonedSessions`. Don't
import from `@routedock/routedock/provider` in a Workers snippet — that's the
Node-only Express entry point and pulls in dependencies (like `express`) that
don't run on Workers.

## React Integration

`@routedock/sdk/react` provides hooks for client construction, payments, sessions, and live tx log subscription. Wrap your app with `RouteDockProvider`:

```tsx
import { RouteDockProvider, useRouteDockClient } from "@routedock/sdk/react";
import { createClient } from "@supabase/supabase-js";

function App({ children }: { children: React.ReactNode }) {
  const client = useRouteDockClient({
    wallet: process.env.NEXT_PUBLIC_AGENT_SECRET!,
    network: "testnet",
    spendCap: { daily: "1.00", asset: "USDC" },
  });
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
  return (
    <RouteDockProvider client={client} supabase={supabase}>
      {children}
    </RouteDockProvider>
  );
}
```

### `usePay(url, options?)`

```tsx
import { usePay } from "@routedock/sdk/react";

function PriceButton() {
  const { pay, result, loading, error } = usePay(
    "https://provider.example.com/price",
  );
  if (error) return <span>Error: {error.message}</span>;
  return (
    <button onClick={pay} disabled={loading}>
      {loading
        ? "Paying…"
        : result
        ? `Paid: ${result.txHash}`
        : "Pay 0.001 USDC"}
    </button>
  );
}
```

### `useSession(url)`

```tsx
import { useEffect } from "react";
import { useSession } from "@routedock/sdk/react";

function StreamingFeed() {
  const { open, close, status, vouchers, cumulative } = useSession(
    "https://provider.example.com/stream/orderbook",
  );
  useEffect(() => {
    void open();
  }, []);
  return (
    <div>
      <p>
        Status: {status} — vouchers: {vouchers} — paid: {cumulative} USDC
      </p>
      <button onClick={close} disabled={status !== "open"}>
        Close & settle
      </button>
    </div>
  );
}
```

The hook automatically fires `session.close()` in the background on unmount when status is `open` (best-effort settlement).

### `useTxLog(filter?)`

```tsx
import { useTxLog } from "@routedock/sdk/react";

function ActivityFeed({ channelId }: { channelId: string }) {
  const txLog = useTxLog({ channelId, limit: 25 });
  return (
    <ul>
      {txLog.map((row) => (
        <li key={row.id}>
          {row.mode} — {row.amount} USDC — {row.tx_hash}
        </li>
      ))}
    </ul>
  );
}
```

| Hook                         | Returns                                                         | Requires from `RouteDockProvider`  |
| ---------------------------- | --------------------------------------------------------------- | ---------------------------------- |
| `useRouteDockClient(config)` | Memoized `RouteDockClient`                                      | — (creator hook)                   |
| `usePay(url, options?)`      | `{ pay, result, loading, error }`                               | `client`                           |
| `useSession(url)`            | `{ session, status, vouchers, cumulative, error, open, close }` | `client` (with `commitmentSecret`) |
| `useTxLog(filter?)`          | `TxLogRow[]` (newest first)                                     | `supabase`                         |

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
  RouteDockPolicyRejectError,
} from "@routedock/sdk/client";

const client = new RouteDockClient({
  wallet: process.env.AGENT_SECRET!,
  network: "testnet",
  retryPolicy: { maxAttempts: 4, baseDelayMs: 250 },
});

try {
  const result = await client.pay("https://provider.example.com/price");
  console.log(result.mode, result.txHash);
} catch (err) {
  if (err instanceof RouteDockPolicyRejectError) {
    console.error("Spend cap exceeded:", err.reason);
  } else if (err instanceof RouteDockFacilitatorError) {
    console.error(
      `Facilitator HTTP ${err.status} (retryable=${err.retryable})`,
    );
  } else if (err instanceof RouteDockManifestError) {
    console.error("Manifest or config problem:", err.message);
  } else if (err instanceof RouteDockError) {
    console.error(`[${err.code}] ${err.message} (retryable=${err.retryable})`);
  } else {
    throw err;
  }
}
```

| Error                               | `retryable` | Typical cause                              |
| ----------------------------------- | ----------- | ------------------------------------------ |
| `RouteDockManifestError`            | no          | Invalid manifest, missing pricing fields   |
| `RouteDockNoSupportedModeError`     | no          | Provider has no compatible payment mode    |
| `RouteDockFacilitatorError`         | yes         | Facilitator/provider 429 or 5xx            |
| `RouteDockNetworkError`             | yes         | Timeouts, connection failures              |
| `RouteDockSignatureError`           | no          | Signing or commitment failure              |
| `RouteDockVoucherMonotonicityError` | no          | Non-increasing voucher amount              |
| `RouteDockPolicyRejectError`        | no          | Local spend cap exceeded                   |
| `RouteDockChannelStateError`        | no          | Channel simulate/close invariant violation |

## Mode Selection Logic

The `ModeRouter` uses this decision tree (deterministic, no randomness):

1. If `{ sustained: true }` passed AND manifest supports `mpp-session` → session
2. Else if manifest supports `mpp-charge` AND network is Stellar → MPP charge (lower fees)
3. Else if manifest supports `x402` → x402 with facilitator
4. Else throw `RouteDockNoSupportedModeError`

Override with `{ forceMode: 'x402' }` to bypass auto-selection.

## Dispute Resolution

For `mpp-session` mode, the session handle exposes three methods to handle server unavailability or crashes:

```ts
const session = await client.openSession("https://provider.example.com/stream");

// Check the current dispute status (open, in-refund-window, refundable, settled)
const status = await session.getDisputeStatus();

// If server is unresponsive, request a refund (starts the refund window)
const refundTxHash = await session.requestRefund();

// Server-side: settle with the latest signed voucher before refund window expires
const settleTxHash = await session.settleWithLatestVoucher();
```

| Method                      | Purpose                 | Requires                 | Returns                                                     |
| --------------------------- | ----------------------- | ------------------------ | ----------------------------------------------------------- |
| `getDisputeStatus()`        | Query channel state     | None                     | `'open' \| 'in-refund-window' \| 'refundable' \| 'settled'` |
| `requestRefund()`           | Initiate refund process | Signed agent keypair     | Transaction hash (string)                                   |
| `settleWithLatestVoucher()` | Server counter-settle   | Latest voucher signature | Transaction hash (string)                                   |

Raises: `RouteDockDisputeError`, `RouteDockChannelStateError`, `RouteDockRefundWindowError`

## Security

The `one-way-channel` Soroban contract wrapped by `MppSessionClient` is **unaudited** (`stellar-experimental/one-way-channel`). Safe defaults are enforced: 17280 ledger refund window, monotonic cumulative enforcement at application, database, and contract layers. Production mainnet use should await a formal audit.

## License

MIT
