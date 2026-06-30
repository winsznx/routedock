## The Problem

Autonomous agents on Stellar have three ways to pay for services: **x402** (Coinbase's HTTP payment protocol), **MPP charge** (Stellar-native per-request transfers), and **MPP session** (off-chain payment channels via a Soroban contract). Each has a separate SDK, a separate integration path, and zero interoperability. No discovery mechanism tells an agent which modes a given endpoint supports. If the endpoint changes its pricing model, the agent breaks.

The `one-way-channel` contract exists but has no safe SDK integration — no monotonic enforcement, no durable session state, no spend guardrails. Streaming access (the most capital-efficient pattern for agents) is effectively unavailable.

## What RouteDock Is

One npm package ([`@routedock/routedock`](https://www.npmjs.com/package/@routedock/routedock)) that wraps all three Stellar payment modes behind a single function call:

```ts
const client = new RouteDockClient({ wallet, network: 'testnet' })
const result = await client.pay('https://api-a.routedock.xyz/price')
// result.mode → 'x402' | 'mpp-charge' | 'mpp-session'
```

The agent never decides the payment mode. The provider's manifest declares what's supported. The SDK selects and executes.

**Three components ship together:**

1. **Client + Provider SDK** — The client handles mode selection and payment execution. The provider middleware handles verification and settlement for all three modes via one Express middleware.

2. **`routedock.json` manifest** — Served at `/.well-known/routedock.json` on every provider. Declares supported modes, pricing, asset, network. Validated against a JSON Schema at startup. Indexed with `pg_trgm` trigram search in Supabase so agents can discover providers by capability.

3. **Agent vault contract** — A Soroban contract account using the `Crossmint/stellar-smart-account` pattern with three `__check_auth` policies: daily USDC spend cap, endpoint allowlist, and session key expiry. These are **consensus-layer guarantees** — the chain rejects overspend before any transaction is broadcast.

## Real Testnet Transactions

Every transaction below was produced by a single autonomous agent run against two live provider services. No mocks. No simulated data.

| Round | Mode | What Happened | Evidence |
|---|---|---|---|
| 1 | **x402** | Agent hit `/price`, got 402, signed Soroban auth entry, local facilitator broadcast. USDC transferred. | `5f6033...e2db64` |
| 2 | **MPP charge** | Same endpoint — mode router selected mpp-charge automatically (lower fee, no facilitator). | Server-side settlement |
| 3 | **MPP session** | Agent opened a one-way-channel with 0.1 USDC deposit. **50 off-chain vouchers** signed and verified. One on-chain close settled the cumulative amount. | close: `234dcb...29a20` |
| 4 | **Policy reject** | Cumulative spend exceeded daily cap. Rejected locally — nothing hit Stellar. | No TX |

**Round 3 is the efficiency proof.** 50 agent-provider interactions. 2 on-chain transactions. Every intermediate payment was an off-chain ed25519 commitment — no RPC call, no transaction fee, no ledger wait.

## Architecture Decisions

**Dual facilitator** — On mainnet, RouteDock uses OpenZeppelin's hosted facilitator at `channels.openzeppelin.com/x402`. On testnet, it runs `ExactStellarFacilitatorScheme` in-process — no external dependency. Single env var switches networks.

**Three-layer monotonic enforcement** — The one-way-channel contract uses cumulative commitments, but RouteDock enforces monotonicity at three independent layers: application (`@stellar/mpp` server store), database (Supabase trigger rejects non-increasing amounts), and contract (`close()` verifies on-chain). No single layer's failure compromises the invariant.

**Contract account policies** — Daily cap, endpoint allowlist, and session key expiry all run inside `__check_auth` on Soroban. If the agent SDK is compromised, the contract still rejects overspend.

## Deployed and Live

| Service | URL |
|---|---|
| Dashboard + Landing | [routedock.xyz](https://routedock.xyz) |
| Provider A (x402 + MPP charge) | [api-a.routedock.xyz](https://api-a.routedock.xyz) |
| Provider B (MPP session) | [api-b.routedock.xyz](https://api-b.routedock.xyz) |
| npm package | [@routedock/routedock](https://www.npmjs.com/package/@routedock/routedock) |
| Agent vault contract | `CAX5IDLC2XHGQSEA2YN3LPLZ7EXLMRXYX3HFJGKFXS6B7OQXBKWO44LT` |
| Source | [github.com/winsznx/routedock](https://github.com/winsznx/routedock) |

## Tech Stack

TypeScript monorepo — `@stellar/stellar-sdk` 14.6.1, `@x402/stellar` + `@x402/core` 2.9.0, `@stellar/mpp` 0.4.0, `mppx` 0.5.7, `stellar-experimental/one-way-channel`, Next.js 16, Supabase (PostgreSQL + Realtime), Soroban SDK 22.0.10. Zero type errors. Zero `@ts-ignore` suppressions.
