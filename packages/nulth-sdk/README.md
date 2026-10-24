# @routedock/nulth-sdk — Stub / Proof-of-Concept

**Status: STUB — not ready for production.**

This package provides an **insecure mock prover** (`insecureMockProof`). It produces a
SHA-512 digest as a placeholder; no real zero-knowledge proof is generated. Use it
only for **testnet development**, never for custody or production policy enforcement.
`NulthClient` rejects every network except `testnet` and every prover except `mock`.
See [Issue #143](https://github.com/winsznx/routedock/issues/143) for production prover work.

## Requirements

Node.js **22 or newer**, matching the supported runtime of the RouteDock packages.
TypeScript examples use ES2022 or later for native `bigint` support.

## Install

```bash
npm install @routedock/nulth-sdk
```

## Example: initialize a testnet client

Set `NULTH_ACCOUNT` to your testnet smart-account contract address (`C...`) and
`TESTNET_PAYEE` to an allowed testnet recipient (`G...` or `C...`). This example
initializes local policy state and prints commitments; it does not submit a payment.
Persist the witness secret securely if you need to recreate the same commitments.

```ts
import { randomBytes } from 'node:crypto'
import {
  createPolicyState,
  NulthClient,
  stroopsToUsdc,
} from '@routedock/nulth-sdk'

const nulthAccount = process.env.NULTH_ACCOUNT
const payee = process.env.TESTNET_PAYEE
if (!nulthAccount || !payee) {
  throw new Error('Set NULTH_ACCOUNT and TESTNET_PAYEE to testnet addresses')
}

const policy = createPolicyState({
  dailyCapUsdc: '1.00',
  allowedPayees: [payee],
  witnessSecret: randomBytes(32).toString('hex'),
})
const client = new NulthClient({
  nulthAccount,
  network: 'testnet',
  prover: 'mock',
  policy,
})

console.log(client.allowlistCommitment, client.capCommitment)
console.log(stroopsToUsdc(client.dailySpendStroops)) // '0'
```

Before using the signing adapter, supply the payment's real ledger sequence, asset,
payee, and amount through `setNulthPaymentContext`. `createNulthSigner` checks the
actual Soroban authorization preimage against that context. A missing context or
mismatched transfer is rejected. These client-side checks do not make the mock proof secure.

## Exports

| Export | Purpose |
| --- | --- |
| `NulthClient` | Testnet-only client with policy checks, mock proof construction, encoding, and spend/commitment getters. |
| `createPolicyState` | Initialize off-chain policy from a decimal USDC cap, payees, witness secret, and optional ledger/expiry. |
| `createNulthSigner` | Create an x402-compatible signer for a Nulth account using the mock client. |
| `setNulthPaymentContext` | Set the next payment context on the configuration used by the signer. |
| `paymentContextFromManifest` | Extract asset, payee, amount, and ledger context from manifest pricing. |
| `assertAuthEntryMatchesContext` | Reject an authorization preimage whose transfer does not match the expected payer, payee, asset, or amount. |
| `usdcToStroops`, `stroopsToUsdc`, `USDC_DECIMALS` | Convert decimal USDC strings and integer units using seven decimal places. |
| `commitAllowlist`, `commitDailyCap` | Compute salted SHA-256 commitments to policy values. |
| `dayBucket` | Convert a ledger sequence to its 17,280-ledger day bucket. |
| `hashPayee`, `authDigestFromEntry`, `sha256Hex` | Hash payees, authorization preimages, and byte/string inputs. |
| `encodeAuthSignature`, `decodeAuthSignature` | Encode or decode the mock signature envelope as base64 JSON; decoding is not proof verification. |
| `insecureMockProof`, `DEFAULT_PROVER` | Produce deterministic SHA-512 placeholder bytes and identify the only supported backend (`mock`). |
| `NulthPolicyError` | Typed policy rejection with a `code` such as `daily_cap_exceeded` or `auth_entry_mismatch`. |
| `NulthPolicyState`, `NulthClientConfig`, `PaymentAuthContext` | Types for policy state, client configuration, and payment authorization inputs. |
| `NulthSignerConfig`, `NulthStellarSigner` | Types for mutable signer configuration and its signing interface. |
| `NulthProof`, `NulthAuthSignature`, `ProverBackend` | Types for the mock proof, signature envelope, and prover selection. |

## What the mock prover does and does not prove

`NulthClient` checks the local allowlist, daily cap, and optional session expiry,
then hashes public inputs into deterministic placeholder bytes. Building a proof
updates the client's in-memory daily spend; it is not evidence of on-chain settlement
and does not provide durable accounting across process restarts.

The digest is **not a zero-knowledge proof** and proves neither knowledge of a secret
witness nor satisfaction of the policy to an on-chain verifier. Anyone can reproduce
it from the public preimage. Commitments alone do not provide a production security
boundary, and the public inputs expose payment amounts, day buckets, and hashes.
A real prover/verifier integration is still required before this package can protect funds.

For contributors, `pnpm --filter @routedock/nulth-sdk check:readme` typechecks every
TypeScript example against the built package exports. It also runs during `pnpm verify`.
## Diagnostics and configuration errors

Diagnostics are silent by default. Pass a `logger(level, message, fields?)` in
`NulthClientConfig` (also accepted by `createNulthSigner`) to receive the mock-prover
warning. The sink is compatible with RouteDock's `RouteDockLogger`; the RouteDock
SDK adapter retains its console-backed default and accepts the same override.

Invalid networks and prover backends throw `NulthConfigError`, with code
`unsupported_network` or `unsupported_prover`. The RouteDock adapter maps these
to `RouteDockManifestError`; policy failures remain `NulthPolicyError`.

