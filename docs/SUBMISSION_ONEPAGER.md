# RouteDock — Submission Brief

## The Problem

Autonomous agents on Stellar have three ways to pay for services: x402 (Coinbase's HTTP payment protocol), MPP charge (Stellar-native per-request transfers), and MPP session (off-chain payment channels via a Soroban contract). Each has a separate SDK, a separate integration path, and a separate set of assumptions about what the agent holds and how the server verifies payment.

No agent can switch between these modes at runtime. No discovery mechanism tells an agent which modes a given endpoint supports. The one-way-channel contract (`stellar-experimental/one-way-channel`) exists but is unaudited, undocumented for SDK consumption, and has no safe integration path — no monotonic enforcement, no durable session state, no spend guardrails.

The result: every agent team hardcodes payment logic per endpoint. If the endpoint changes its pricing model, the agent breaks. If a new payment mode becomes available, the agent can't adopt it without a code change. Streaming access (the most capital-efficient pattern) is effectively unavailable because nobody has wrapped the channel contract.

## What RouteDock Is

RouteDock is one npm package (`@routedock/sdk`) that wraps all three Stellar payment modes behind a single function call. The agent calls `client.pay(url)`. The SDK reads the provider's manifest, selects the payment mode, and executes the full lifecycle — including channel open, off-chain voucher signing, and on-chain settlement.

Three components ship together:

1. **`@routedock/sdk`** — client and provider libraries. The client handles mode selection and payment execution. The provider middleware handles verification and settlement for all three modes via one Express middleware.

2. **`routedock.json`** — a discovery manifest served at `/.well-known/routedock.json` on every provider. Declares supported modes, pricing, asset, network, and endpoints. Validated against a JSON Schema at startup. Indexed with trigram search in Supabase so agents can query by capability ("find me a streaming price feed") without exact keyword matching.

3. **Agent vault contract** — a Soroban contract account (`Crossmint/stellar-smart-account` pattern) with three `__check_auth` policies: daily USDC spend cap, endpoint allowlist, and session key expiry. These are consensus-layer guarantees — the chain rejects overspend before any transaction is broadcast.

## What RouteDock Is Not

Not a reimplementation of x402, MPP, or the one-way-channel contract. RouteDock depends on `@x402/stellar`, `@stellar/mpp`, and `stellar-experimental/one-way-channel` as-is. It wraps them with safe defaults and a unified interface.

Not an agent marketplace, rating system, or MCP server. Those are roadmap items. This is the payment execution layer that makes them possible.

## Proof: Real Testnet Transactions

Every transaction below was produced by a single autonomous agent run against two live provider services on Stellar testnet. No mocks. No simulated data. Real Horizon orderbook queries, real USDC transfers, real Soroban contract execution.

| Round | Mode | What Happened | Tx Hash |
|---|---|---|---|
| 1 | x402 | Agent queried `/price`. Server returned 402. Agent signed Soroban auth entry. Local facilitator verified and broadcast. USDC transferred. Price data returned. | `5f6033...e2db64` |
| 2 | MPP charge | Same endpoint. Mode router selected mpp-charge (lower fee, no facilitator). Native SAC transfer via `@stellar/mpp`. | Server-side settlement |
| 3 | MPP session | Agent connected to `/stream/orderbook`. Channel contract deployed with 0.1 USDC deposit. 50 off-chain vouchers signed and verified. Session closed — one on-chain settlement for the cumulative amount. | close: `234dcb...29a20` |
| 4 | Policy rejection | Agent attempted another x402 payment. Cumulative spend (0.0018 USDC) + new amount (0.001) exceeded daily cap (0.002). Rejected locally. Nothing broadcast to Stellar. | NO TX |

**Round 3 is the efficiency proof.** 50 interactions between agent and provider. 2 on-chain transactions (channel open + close). Every intermediate payment was an off-chain ed25519 commitment — no RPC call, no transaction fee, no ledger wait. The channel contract's `close()` function settled the cumulative amount in a single Soroban invocation.

## How the Three Modes Work

### x402 — Pay per request

The server returns HTTP 402 with an `X-Payment-Requirements` header specifying the price, asset, and payee. The agent signs a Soroban authorization entry for a USDC SAC transfer. The facilitator (running locally on the provider, not a third party) rebuilds the transaction with its own account as source, signs the envelope, and broadcasts. One request, one settlement.

Used for: discrete queries, data lookups, one-shot API calls.

### MPP Charge — Pay per action

The server returns 402 with a `WWW-Authenticate: Payment` header per the MPP protocol. The agent signs a SAC transfer directly — no facilitator intermediary. The server broadcasts. Lower fees than x402, native to Stellar.

Used for: frequent requests where facilitator overhead matters.

### MPP Session — Pay per time

The agent deposits USDC into a `one-way-channel` Soroban contract. For every unit of data consumed, the agent signs a cumulative ed25519 commitment (not a transaction — just bytes). The server verifies the signature off-chain by simulating `prepare_commitment` on the contract. No RPC submission per voucher. When the session ends, the server calls `close(amount, signature)` on the contract — one transaction settles everything.

Used for: streaming data, sustained access, SSE feeds. The capital-efficient path for any agent that needs more than a few requests.

### Mode Selection Logic

Deterministic, manifest-driven, no randomness:

1. If caller requests sustained access AND manifest supports `mpp-session` → session
2. Else if manifest supports `mpp-charge` AND network is Stellar → charge (lower fees)
3. Else if manifest supports `x402` → x402 with facilitator
4. Else throw — no supported mode

The agent never decides. The manifest declares. The router selects.

## Architecture Decisions That Matter

### Dual facilitator: OZ on mainnet, local on testnet

On mainnet, RouteDock uses the OpenZeppelin hosted facilitator at `channels.openzeppelin.com/x402` with Bearer token authentication. The `x402ResourceServer` from `@x402/core` handles the verify/settle cycle via the OZ Relayer infrastructure — production-grade, Coinbase-backed.

On testnet, the OZ facilitator does not serve `stellar:testnet`. RouteDock runs the `ExactStellarFacilitatorScheme` from `@x402/stellar` in-process on the provider. The provider's own keypair signs the envelope. No external service, no API key, no single point of failure. The x402 V2 protocol is fully preserved — the agent's experience is identical on both networks.

The network switch is a single env var: `STELLAR_NETWORK=testnet|mainnet`. The SDK selects the facilitator path automatically.

### Two-layer monotonic enforcement

The one-way-channel contract uses cumulative commitments — each voucher authorizes the server to withdraw UP TO a cumulative amount. If the server receives an old voucher (cumulative amount lower than what was already withdrawn), the contract ignores it.

RouteDock adds enforcement before the contract:
- **Application layer:** `@stellar/mpp`'s server store tracks the cumulative amount per channel. Rejects any voucher where `new_amount <= stored_amount`.
- **Database layer:** Supabase trigger on `sessions.cumulative_amount` rejects UPDATE if `NEW.cumulative_amount <= OLD.cumulative_amount`.
- **Contract layer:** `close(amount, signature)` verifies the ed25519 signature on-chain and only transfers the difference between the committed amount and what's already been withdrawn.

Three independent enforcement points. No single layer's failure compromises the invariant.

### Contract account policies as consensus guarantees

The agent vault contract (`contracts/agent-vault/`) uses the `Crossmint/stellar-smart-account` pattern. Policies run inside `__check_auth` — the Soroban runtime calls this before authorizing any transaction from the account.

- **Daily cap:** `current_day_spend + amount > daily_cap` → contract rejects. Day bucket keyed by `ledger_sequence / 17280` in temporary storage (auto-expires).
- **Endpoint allowlist:** payee address checked against stored `ALLOWLIST`. Unknown payees rejected.
- **Session key expiry:** `env.ledger().sequence() > expiry_ledger` → rejected.

These are not application-layer checks. The chain enforces them. If the agent SDK is compromised, the contract still rejects overspend. The agent's policy is a consensus-layer guarantee.

### Discovery via manifest, not hardcoded URLs

Every provider serves `routedock.json` at `/.well-known/routedock.json`. The SDK fetches and validates it against a JSON Schema (AJV, draft-07) before every call. Invalid manifests are rejected — the provider won't start if the manifest fails validation.

The Supabase `providers` table indexes these manifests with `pg_trgm` trigram search. An agent can query "streaming price feed" and get ranked results by similarity score against provider name, description, and tags. This is the difference between a static directory and a searchable capability registry.

## Technical Stack

| Component | Technology | Version |
|---|---|---|
| SDK | TypeScript, dual ESM/CJS via tsup | 0.1.0 |
| Frontend | Next.js App Router | 16.2.2 |
| Providers | Express + TypeScript | 4.18.2 |
| Blockchain SDK | @stellar/stellar-sdk | 14.6.1 |
| x402 | @x402/stellar + @x402/core | 2.9.0 |
| MPP | @stellar/mpp + mppx | 0.4.0 / 0.5.7 |
| Channel contract | stellar-experimental/one-way-channel | latest |
| Contract account | Crossmint/stellar-smart-account pattern | v1.0.0 |
| Database | Supabase (PostgreSQL + Realtime + pg_trgm) | managed |
| Contract language | Rust + Soroban SDK | 22.0.10 |

## Protocol Conformance

Every wire format deviation discovered during integration is documented in `AGENT_PROGRESS.md`. Key conformance points:

- x402 V2: `PAYMENT-SIGNATURE` header (not `X-PAYMENT` which is V1). `extra.areFeesSponsored: true` required for Stellar exact scheme.
- MPP: `WWW-Authenticate: Payment` challenge with mppx credential scheme. `authorization: Payment credential="..."` response.
- One-way-channel commitments: XDR-serialized `ScVal::Map` with four entries sorted alphabetically by key (`amount`, `channel`, `domain`, `network`). Domain separator `chancmmt`. Signature via ed25519 over the serialized bytes.
- `@stellar/mpp` server verifies signatures by simulating `prepare_commitment` on the contract — a read-only Soroban simulation, no on-chain submission per voucher.

## What the Dashboard Shows

The dashboard at `/dashboard` is a public read-only view of all RouteDock activity on testnet.

- **4 metric cards:** Active sessions (with pulsing indicator), total vouchers accumulated, total USDC settled, last settlement (time ago + tx hash link)
- **Session table:** Real-time via Supabase `postgres_changes` subscription. Shows channel ID, payer, mode badge, voucher count, cumulative USDC, status (open/closing/closed with visual indicator), settlement tx link.
- **Transaction feed:** Real-time INSERT subscription on `tx_log`. Mode badge (x402 / MPP Charge / MPP Session), amount, tx hash link, timestamp.
- **Voucher chart:** Recharts area chart showing cumulative voucher count over time. Polls every 30 seconds.

The landing page at `/` shows the SDK pitch: code block, three-mode breakdown, live feed from testnet, FAQ.

## What's Deployed

| Service | Status |
|---|---|
| Agent vault contract | Live on Stellar testnet: `CAX5IDLC2XHGQSEA2YN3LPLZ7EXLMRXYX3HFJGKFXS6B7OQXBKWO44LT` |
| One-way-channel contract | Live on Stellar testnet: `CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH` |
| 4 testnet transaction hashes | Verified on Stellar Expert |
| SDK dist | Built (ESM + CJS + .d.ts), ready to publish |
| Supabase schema | Applied with RLS policies + Realtime publication |
| Dashboard + landing | Built, ready for Vercel deploy |
| Providers | Built, ready for Railway deploy |

## Roadmap (Post-Hackathon)

- **Registry API** — REST endpoint for agent capability search against the trigram-indexed provider table. MCP server adapter so AI agents can discover endpoints via tool use.
- **Mainnet launch** — flip `STELLAR_NETWORK=mainnet`. All code paths are network-aware via a single env var.
- **Contract audit** — the one-way-channel contract is unaudited. RouteDock wraps it with safe defaults but production mainnet use should await a formal audit.
- **Multi-asset support** — current implementation is USDC-only. The manifest schema supports arbitrary SAC assets.
- **Provider SDK for other runtimes** — current middleware is Express-only. Hono, Fastify, and serverless adapters are natural next steps.

## Repository

Monorepo structure:
```
routedock/
├── packages/sdk/        # @routedock/sdk — npm package
├── apps/web/            # Next.js dashboard + landing
├── apps/provider-a/     # Price endpoint (x402 + MPP charge)
├── apps/provider-b/     # Orderbook endpoint (MPP session)
├── contracts/agent-vault/ # Soroban contract account
├── agent/               # Reference autonomous agent
└── supabase/            # Schema + RLS + trigram indexes
```

All TypeScript, strict mode, `exactOptionalPropertyTypes: true`. Zero type errors across 5 packages. Zero type suppressions (`@ts-ignore`, `as any`).

## License

MIT
