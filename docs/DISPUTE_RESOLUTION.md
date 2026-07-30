# Dispute Resolution

This document covers what a production agent should do when an MPP session goes wrong. It maps four failure scenarios to the exact SDK call sequence and the expected on-chain outcome for each.

---

## Background: how the one-way channel settles

An MPP session uses a Soroban one-way-channel contract funded by the payer (agent). During the session the agent signs monotonically increasing ed25519 vouchers off-chain. Normal close: the agent calls `session.close()`, which sends the final voucher to the provider via `DELETE`; the provider submits a `settle_with_signature` transaction on-chain and returns `closeTxHash`.

If that normal path fails, the contract exposes a refund path:

1. Agent calls `request_refund` on-chain → channel moves to `in-refund-window`.
2. Provider has `refund_waiting_period_ledgers` (~24 h on mainnet, minimum 17 280 ledgers) to call `settle_with_signature` with any voucher it holds.
3. If the provider does not settle in time, the channel moves to `refundable`.
4. Agent calls `claim_refund` on-chain → full remaining balance returned.

The SDK surfaces this through `SessionHandle`:

```ts
interface SessionHandle {
  close(): Promise<SessionCloseResult>         // normal path
  requestRefund(): Promise<string>             // starts refund window
  settleWithLatestVoucher(): Promise<string>   // provider-side counter-settle
  getDisputeStatus(): Promise<DisputeStatus>   // 'open' | 'in-refund-window' | 'refundable' | 'settled'
}
```

---

## Scenario 1: provider goes offline at close

The agent finishes consuming the stream and calls `session.close()`. The provider's HTTP endpoint is unreachable — the `DELETE` request times out or returns a 5xx.

### What happens

`close()` retries the `DELETE` using the configured `RetryPolicy`. After exhausting retries it throws `RouteDockNetworkError` or `RouteDockChannelStateError`. The channel remains `open` on-chain; no funds have moved.

### Recovery sequence

```ts
import { RouteDockNetworkError, RouteDockChannelStateError } from '@routedock/sdk'

try {
  const result = await session.close()
  console.log('settled:', result.closeTxHash)
} catch (err) {
  if (
    err instanceof RouteDockNetworkError ||
    err instanceof RouteDockChannelStateError
  ) {
    console.warn('Provider unreachable — initiating on-chain refund dispute')

    // Step 1: open the refund window on-chain
    const refundTxHash = await session.requestRefund()
    console.log('refund window opened:', refundTxHash)

    // Step 2: poll for the refund window to expire (~24 h on mainnet)
    let status = await session.getDisputeStatus()
    while (status !== 'refundable' && status !== 'settled') {
      console.log('channel status:', status, '— waiting...')
      await sleep(60_000) // poll every minute
      status = await session.getDisputeStatus()
    }

    if (status === 'settled') {
      // Provider came back online and settled during the window — normal outcome
      console.log('Provider settled during refund window')
    } else {
      // Step 3: refund window expired without provider settlement — claim funds
      // Call claim_refund directly via the Stellar SDK (not yet wrapped in SessionHandle)
      console.log('Refund window expired — call claim_refund on the channel contract')
      // See "Calling claim_refund directly" below
    }
  }
}
```

### Expected on-chain outcome

| Path | What settles on-chain |
|---|---|
| Provider comes back within window | `settle_with_signature` tx from provider — provider receives owed amount, agent receives remainder |
| Window expires without provider settling | Agent calls `claim_refund` — full channel balance returned to agent |

### Time budget

`refund_waiting_period_ledgers` is set by the provider in the manifest. The minimum enforced by the SDK is **17 280 ledgers ≈ 24 hours** at 5 s/ledger. Never connect to a provider whose manifest sets this below 17 280 — the SDK will throw `RouteDockManifestError` during `openSession`.

---

## Scenario 2: provider rejects the final voucher

The agent calls `session.close()`. The provider's endpoint is reachable but returns a non-2xx response (e.g. `400 Bad Request` or `409 Conflict`) — the voucher signature is considered invalid or the cumulative amount does not match the provider's state.

### What happens

`close()` throws `RouteDockChannelStateError` with the message `Channel close failed: HTTP <status>`. Unlike network errors, 4xx responses are **not retried** by the SDK because they indicate a protocol disagreement, not a transient failure.

### Recovery sequence

```ts
import { RouteDockChannelStateError } from '@routedock/sdk'

try {
  const result = await session.close()
  console.log('settled:', result.closeTxHash)
} catch (err) {
  if (err instanceof RouteDockChannelStateError) {
    console.warn('Provider rejected close — checking dispute status')

    const status = await session.getDisputeStatus()

    if (status === 'settled') {
      // Provider already settled on-chain with a prior voucher — no action needed
      console.log('Channel already settled on-chain by provider')
      return
    }

    // The agent holds a valid signed voucher. If the provider is acting in bad
    // faith by refusing to accept it, the agent can settle unilaterally.
    console.log('Settling on-chain with latest signed voucher')
    const settleTxHash = await session.settleWithLatestVoucher()
    console.log('settled on-chain:', settleTxHash)
  }
}
```

### Expected on-chain outcome

`settleWithLatestVoucher()` calls `settle_with_signature` directly from the agent side using the highest voucher the agent has signed. The contract verifies the ed25519 signature and releases funds: provider receives the cumulative amount, agent receives the remainder.

> **Note:** `settleWithLatestVoucher()` can only be called while the channel is still `open`. If the provider has already called `settle_with_signature` on-chain (status `settled`), the contract will reject the duplicate and the call will throw `RouteDockDisputeError`.

---

## Scenario 3: channel timeout / refund window expiry

The agent opened a refund window (either as recovery from Scenario 1 or because the session was abandoned) and the `refund_waiting_period_ledgers` have elapsed without the provider settling.

### What happens

`getDisputeStatus()` returns `'refundable'`. The SDK does not automatically claim the refund — the agent must do it explicitly because claiming requires the agent's account to sign and submit an on-chain transaction.

### Recovery sequence

```ts
const status = await session.getDisputeStatus()

if (status === 'refundable') {
  console.log('Refund window expired — claiming refund from contract')

  // claim_refund is not yet wrapped in SessionHandle; call via Stellar SDK directly
  const { rpc, Contract, TransactionBuilder, BASE_FEE, Keypair, Networks } =
    await import('@stellar/stellar-sdk')

  const server = new rpc.Server('https://mainnet.sorobanrpc.com') // or testnet RPC
  const contract = new Contract(session.channelId)
  const agentKeypair = Keypair.fromSecret(process.env.AGENT_SECRET!)
  const networkPassphrase = Networks.PUBLIC // or Networks.TESTNET

  const account = await server.getAccount(agentKeypair.publicKey())
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call('claim_refund'))
    .setTimeout(30)
    .build()

  const prepared = await server.prepareTransaction(tx)
  prepared.sign(agentKeypair)
  const result = await server.sendTransaction(prepared)

  console.log('Refund claimed, tx hash:', result.hash)
}
```

### Expected on-chain outcome

`claim_refund` transfers the full remaining channel balance back to the agent's funding address. The channel moves to `settled`. The provider receives nothing for unredeemed vouchers.

### Monitoring recommendation

For long-running production agents, poll `getDisputeStatus()` on a schedule (e.g. every 1 000 ledgers ≈ 1.4 hours) if a refund window has been opened. Store the `channelId` and refund-open timestamp in durable storage so the agent can resume after a restart.

```ts
// Persist enough state to resume after a crash
const savedState = {
  channelId: session.channelId,
  refundWindowOpenedAt: Date.now(),
  refundWaitingPeriodLedgers: manifest.pricing['mpp-session']!.refund_waiting_period_ledgers,
}
```

---

## Scenario 4: network partition during settlement

The agent calls `session.close()` successfully — the `DELETE` request reaches the provider, the provider submits `settle_with_signature` — but the agent's connection drops before the HTTP response arrives. The agent receives a fetch error and does not know whether settlement succeeded.

### What happens

`close()` throws `RouteDockNetworkError`. The channel may or may not be settled on-chain. Acting as if it failed and calling `requestRefund()` could race with a legitimate provider settlement, wasting gas. Acting as if it succeeded could leave funds stranded if it actually failed.

### Recovery sequence

Always check on-chain state before taking any dispute action:

```ts
import { RouteDockNetworkError } from '@routedock/sdk'

try {
  const result = await session.close()
  console.log('settled:', result.closeTxHash)
} catch (err) {
  if (err instanceof RouteDockNetworkError) {
    console.warn('Network error during close — checking on-chain state before disputing')

    // Wait a few seconds for any in-flight transaction to land
    await sleep(10_000)

    const status = await session.getDisputeStatus()
    console.log('channel status after network error:', status)

    switch (status) {
      case 'settled':
        // Provider's settlement landed on-chain — session closed correctly
        console.log('Channel already settled — no action needed')
        break

      case 'open':
        // Settlement did not land — retry close once before escalating
        try {
          const retry = await session.close()
          console.log('retry settled:', retry.closeTxHash)
        } catch (retryErr) {
          // Retry also failed — open the refund window
          console.warn('Retry failed — opening refund window')
          const refundTxHash = await session.requestRefund()
          console.log('refund window opened:', refundTxHash)
          // Continue with Scenario 1 polling loop above
        }
        break

      case 'in-refund-window':
        // Agent or provider already opened a refund window in a prior attempt
        // Wait out the window and check again (see Scenario 3)
        console.log('Refund window already open — waiting for it to resolve')
        break

      case 'refundable':
        // Window expired — claim refund (see Scenario 3)
        console.log('Refundable — claiming refund')
        break
    }
  }
}
```

### Expected on-chain outcome

| Status after partition | Correct action | Funds outcome |
|---|---|---|
| `settled` | None — already done | Provider receives owed amount |
| `open` | Retry `close()`, then `requestRefund()` if retry fails | Normal settlement or refund after window |
| `in-refund-window` | Wait, then claim if `refundable` | Full refund to agent if provider doesn't counter-settle |
| `refundable` | `claim_refund` via Stellar SDK | Full refund to agent |

The key invariant: **always call `getDisputeStatus()` before opening a refund window**. Opening a redundant refund window when the channel is already `settled` is a no-op but wastes gas and creates noise in event logs.

---

## Calling `claim_refund` directly

`SessionHandle` does not currently wrap `claim_refund` (the contract exposes it but the SDK method is not yet added). Use the Stellar SDK directly as shown in Scenario 3. The call requires:

- The agent's main keypair (`AGENT_SECRET`) — not the commitment key
- The channel contract address (`session.channelId`)
- Channel must be in `refundable` state

```ts
// Minimal claim_refund helper
async function claimRefund(channelId: string, agentSecret: string, network: 'testnet' | 'mainnet') {
  const { rpc, Contract, TransactionBuilder, BASE_FEE, Keypair, Networks } =
    await import('@stellar/stellar-sdk')

  const rpcUrl = network === 'mainnet'
    ? 'https://mainnet.sorobanrpc.com'
    : 'https://soroban-testnet.stellar.org'
  const passphrase = network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET

  const server = new rpc.Server(rpcUrl)
  const agentKp = Keypair.fromSecret(agentSecret)
  const contract = new Contract(channelId)

  const account = await server.getAccount(agentKp.publicKey())
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(contract.call('claim_refund'))
    .setTimeout(30)
    .build()

  const prepared = await server.prepareTransaction(tx)
  prepared.sign(agentKp)
  const result = await server.sendTransaction(prepared)
  return result.hash
}
```

---

## Error reference

| Error class | `retryable` | When thrown |
|---|---|---|
| `RouteDockNetworkError` | `true` | Fetch timeout, connection reset, DNS failure |
| `RouteDockChannelStateError` | `false` | 4xx from provider, RPC simulation error, missing `closeTxHash` |
| `RouteDockDisputeError` | `false` | `request_refund`, `settleWithLatestVoucher`, or `getDisputeStatus` RPC failure |
| `RouteDockSignatureError` | `false` | Ed25519 signing failed (key corruption or wrong commitment key) |
| `RouteDockRefundWindowError` | `false` | Window not yet open or already expired when the operation requires a specific state |

Errors with `retryable: true` are automatically retried by the SDK according to the `RetryPolicy` passed to `RouteDockClientConfig`. Errors with `retryable: false` require the caller to decide — they represent either a protocol disagreement or a state that requires manual resolution.

---

## Decision tree

```
session.close() throws?
│
├─ No → done ✓
│
└─ Yes
   │
   ├─ RouteDockNetworkError
   │   └─ getDisputeStatus()
   │       ├─ 'settled'        → done ✓
   │       ├─ 'open'           → retry close() → if fails: requestRefund()
   │       ├─ 'in-refund-window' → wait + poll
   │       └─ 'refundable'    → claim_refund via Stellar SDK
   │
   └─ RouteDockChannelStateError
       └─ getDisputeStatus()
           ├─ 'settled'        → done ✓  (provider settled during window)
           └─ 'open'           → settleWithLatestVoucher()
```
