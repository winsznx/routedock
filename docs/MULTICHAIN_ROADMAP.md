# Multi-Chain Roadmap

**Status:** Design sketch (not yet implemented) · **Area:** Ecosystem / Protocol

RouteDock is a **chain-agnostic agent payment protocol with Stellar as its canonical home.**
Today the SDK ships Stellar-only: the `routedock.json` manifest hardcodes
`network: 'testnet' | 'mainnet'`, and every settlement path resolves to a Stellar
transaction. But the protocols RouteDock unifies are not Stellar-bound. x402 — which
RouteDock wraps for its pay-per-request mode — was [designed by Coinbase as a
chain-neutral HTTP payment standard][x402] and already settles on EVM chains today.

This document sketches how RouteDock generalizes to additional chains without
breaking the single-call agent experience (`client.pay(url)`), keeping Stellar as the
reference implementation and **EVM (via x402) as the first extension target.**

[x402]: https://www.x402.org

---

## Design principle: the agent never learns about chains

The whole value of RouteDock is that an agent writes `client.pay(url)` and the SDK does
the rest — mode selection, payment construction, settlement. Multi-chain support must
preserve that. The agent does **not** choose a chain; the provider's manifest declares
which chain(s) it settles on, and the SDK selects a compatible adapter from the wallet
it was given. Chain selection is an internal routing concern, exactly like mode
selection is today (see `packages/sdk/src/client/ModeRouter.ts`).

```ts
// Unchanged for agents, on any chain:
const result = await client.pay('https://provider.example.com/price')
// result.mode  → 'x402' | 'mpp-charge' | 'mpp-session'
// result.chain → 'stellar' | 'evm'   (new field — informational only)
```

---

## Chain-adapter interface

A `ChainAdapter` encapsulates everything chain-specific behind a uniform surface. The
existing Stellar clients (`x402Client`, `MppChargeClient`, `MppSessionClient`) become the
**Stellar reference adapter**; new chains implement the same interface.

```ts
/** A chain on which RouteDock can settle. Open-ended on purpose. */
export type Chain = 'stellar' | 'evm'

/**
 * Everything chain-specific lives behind this interface. The ModeRouter picks an
 * adapter by matching the manifest's `chain` against the adapters registered on the
 * client, then delegates payment construction and settlement to it.
 */
export interface ChainAdapter {
  /** Stable identifier matched against `manifest.chain`. */
  readonly chain: Chain

  /** Payment modes this adapter can settle. Stellar: all three. EVM: x402 only (initially). */
  readonly supportedModes: PaymentMode[]

  /**
   * True if this adapter can settle the given manifest with the provided wallet —
   * e.g. the wallet's network/asset is compatible with the manifest. Used by the
   * router to disambiguate when multiple adapters are registered.
   */
  canSettle(manifest: RouteDockManifest, wallet: ChainWallet): boolean

  /**
   * Construct and submit a single payment for an x402 / mpp-charge call.
   * Returns the same PaymentResult shape regardless of chain.
   */
  pay(req: PaymentRequest, wallet: ChainWallet): Promise<PaymentResult>

  /**
   * Open a streaming session (mpp-session). Optional — adapters that don't support
   * session channels (e.g. the initial EVM adapter) omit it, and the router will
   * refuse `mpp-session` for that chain with RouteDockNoSupportedModeError.
   */
  openSession?(req: SessionRequest, wallet: ChainWallet): Promise<SessionHandle>
}

/** Opaque per-chain wallet/signer. Stellar: Keypair/Freighter. EVM: viem/ethers signer. */
export type ChainWallet = unknown
```

The `PaymentResult` and `SessionHandle` shapes in
[`packages/sdk/src/types.ts`](../packages/sdk/src/types.ts) are already chain-neutral
in spirit — `txHash: string | null` works for any chain's transaction identifier. The
only field worth adding is `chain` on `PaymentResult` so callers can attribute a payment
without re-deriving it from the manifest.

---

## Manifest evolution

The manifest gains an **optional** `chain` field, defaulting to `'stellar'` so every
existing manifest stays valid (no breaking change):

```jsonc
{
  "routedock": "1.0",
  "chain": "evm",                 // NEW — optional, defaults to "stellar"
  "name": "EVM Price Feed",
  "modes": ["x402"],
  "network": "base-sepolia",      // chain-specific network id (was Stellar-only)
  "asset": "USDC",
  "asset_contract": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "payee": "0xabc…",              // chain-specific address format
  "pricing": { "x402": { "amount": "0.001", "per": "request" } },
  "endpoints": { "price": "GET /price" },
  "tags": ["price", "evm", "base"]
}
```

Migration notes:

- `network` widens from `'testnet' | 'mainnet'` to a chain-scoped network id. Stellar
  keeps `testnet | mainnet`; EVM uses chain ids / names (`base`, `base-sepolia`, …).
  The JSON Schema (`packages/sdk/src/schemas/routedock.schema.json`) gains a
  conditional: validate `network`/`payee`/`asset_contract` formats per `chain`.
- `asset_contract` and `payee` are validated by the adapter, not centrally — a Stellar
  `G…`/`C…` address and an EVM `0x…` address are both valid, just for different chains.
- The discovery registry (`providers` table, trigram search) is unchanged; `chain`
  simply becomes another indexed/filterable column so agents can query by capability
  *and* chain.

---

## Router changes

`ModeRouter` today selects a payment **mode** from the manifest. It gains one prior
step: select a **chain adapter**.

```text
fetchManifest(url)
  → pick adapter where adapter.chain === (manifest.chain ?? 'stellar')   // NEW
  → intersect manifest.modes with adapter.supportedModes
  → select mode (existing logic: forceMode / sustained / preference order)
  → adapter.pay() | adapter.openSession()
```

If no registered adapter matches the manifest's chain, the SDK throws a clear error
(`RouteDockNoSupportedChainError`) rather than failing deep in a settlement path.
Adapters are registered on the client, so an agent only pays for the chains it opts into:

```ts
import { RouteDockClient } from '@routedock/routedock'
import { stellarAdapter } from '@routedock/routedock/chains/stellar'  // default, bundled
import { evmAdapter } from '@routedock/routedock/chains/evm'          // opt-in

const client = new RouteDockClient({
  adapters: [stellarAdapter({ wallet, network: 'testnet' }),
             evmAdapter({ signer, network: 'base-sepolia' })],
})
```

For backward compatibility, the existing `new RouteDockClient({ wallet, network })`
constructor keeps working — it's sugar for registering the Stellar adapter alone.

---

## Phased plan

| Phase | Scope | Outcome |
|---|---|---|
| **0 — today** | Stellar-only, three modes | Shipped |
| **1 — refactor (no new chains)** | Extract the Stellar clients behind `ChainAdapter`; add optional `chain` to manifest + schema (defaults to `stellar`); add `chain` to `PaymentResult` | No behavior change; Stellar is now a *reference adapter*, not the only path |
| **2 — EVM via x402** | `evmAdapter` implementing `pay()` for the `x402` mode on Base (mainnet + sepolia) using the existing x402 facilitator flow; viem/ethers signer support | RouteDock pays EVM x402 providers through the same `client.pay(url)` |
| **3 — registry + discovery** | `chain` column + filter in the `providers` table; dashboard chain badges | Agents discover providers by capability *and* chain |
| **4 — sessions on EVM (stretch)** | Evaluate an EVM equivalent of the one-way-channel for `mpp-session` (state channels / `mpp-session` analogue) | Streaming/pay-per-time beyond Stellar |

Stellar remains the canonical home: it is the reference adapter, the only chain with all
three modes (including the audited-path session channel work), and the default when a
manifest omits `chain`. EVM is the proof that the abstraction holds.

---

## Why this is low-risk

- **Additive, not breaking.** `chain` is optional and defaults to `stellar`; every
  existing manifest, provider, and agent keeps working untouched.
- **The result shape is already chain-neutral.** `PaymentResult.txHash` is a plain
  string; nothing in the agent-facing API assumes Stellar.
- **x402 is the natural first target.** It's already multi-chain by design, and
  RouteDock already speaks it — Phase 2 reuses the existing x402 client flow against an
  EVM facilitator rather than inventing a new mode.
