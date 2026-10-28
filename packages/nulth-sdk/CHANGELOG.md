# @routedock/nulth-sdk

## 0.3.0

### Minor Changes

- [#638](https://github.com/winsznx/routedock/pull/638) [`5d5aa72`](https://github.com/winsznx/routedock/commit/5d5aa72ab7fd52c2676be563e1f22a0d376f1634) Thanks [@chykason77-blip](https://github.com/chykason77-blip)! - Adds the Nulth x402 signing pieces: `NULTH_SIGNER_MARKER` marks a signer built by
  `createNulthSigner()` so a client can tell a ZK account payer from an ed25519 key,
  `nulthProofScVal`/`decodeNulthProofScVal` encode and read the `zk-v1` proof
  envelope that goes into `SorobanAddressCredentials.signature`, and
  `nulthAuthorizeEntry` replaces stellar-sdk's default authorization writer — which
  throws `invalid version byte. expected 48, got 16` for a `C...` contract account
  ([#356](https://github.com/winsznx/routedock/issues/356)) — with one that stores the proof instead of an ed25519 signature.

### Patch Changes

- [#625](https://github.com/winsznx/routedock/pull/625) [`aa99d8d`](https://github.com/winsznx/routedock/commit/aa99d8d4980f95fd373c029957780cfc1baa57f5) Thanks [@chiomailekuba](https://github.com/chiomailekuba)! - Enable npm provenance for releases and include repository, homepage, and issue links in package metadata.

- [#630](https://github.com/winsznx/routedock/pull/630) [`461ca6a`](https://github.com/winsznx/routedock/commit/461ca6afd0231259343d647bada89994f5bc9b11) Thanks [@chiomailekuba](https://github.com/chiomailekuba)! - Declare Node.js 22 as the minimum supported runtime, add npm discovery keywords, and document the testnet-only Nulth SDK API and mock prover limitations. Align the MCP build target with the declared runtime.

- [#617](https://github.com/winsznx/routedock/pull/617) [`13fcf55`](https://github.com/winsznx/routedock/commit/13fcf55d7824b823fb501b76ea1a3f138e7fb7e1) Thanks [@Yerimahjr](https://github.com/Yerimahjr)! - Make the `client`, `react` and `provider/hono` entry points runtime-neutral (no `node:fs`, `node:crypto` or `Buffer`). `FileSpendStore` moves to the Node-only `@routedock/routedock/node` entry point (still exported from the root entry), `manifestDigest()` now returns a `Uint8Array`, and SHA-256/512 use `@noble/hashes`. CI now checks the built bundles for Node built-ins.

- [#589](https://github.com/winsznx/routedock/pull/589) [`e16df60`](https://github.com/winsznx/routedock/commit/e16df603eee29a0dcbbbcfacade3f6a3923e6c67) Thanks [@TS-mfon](https://github.com/TS-mfon)! - Use the shared Nulth client, proof and signer implementation in RouteDock while
  preserving manifest errors and configurable SDK logging. Add typed Nulth
  configuration errors and an optional logger with a silent standalone default.

## 0.2.2

### Patch Changes

- [#546](https://github.com/winsznx/routedock/pull/546) [`cd645d5`](https://github.com/winsznx/routedock/commit/cd645d564d95cb836288ad62b03df4d58143c1bf) Thanks [@anifast-123](https://github.com/anifast-123)! - Fix `paymentContextFromManifest` in both the SDK and `@routedock/nulth-sdk` ignoring a per-mode payee override. Both helpers always returned the top-level `manifest.payee`, while providers pay out to `resolvePayee(manifest, mode)` (`pricing.<mode>.payee ?? manifest.payee`). For any manifest using treasury separation the Nulth allowlist therefore checked an address that never received the payment: an agent allowlisting the real recipient was rejected with `payee_not_allowed`, while one allowlisting only the top-level payee got a signature for funds sent elsewhere. Each helper's parameter type now accepts an optional `payee` and returns `pricing.payee ?? manifest.payee`, mirroring `resolvePayee`.

## 0.2.1

### Patch Changes

- [#537](https://github.com/winsznx/routedock/pull/537) [`e591dd7`](https://github.com/winsznx/routedock/commit/e591dd7b2a25bb027c89b28a470fe90453f8d925) Thanks [@vrse-vrde](https://github.com/vrse-vrde)! - Bind the payment challenge to the signed manifest before anything is signed. The client verified the manifest signature and then signed whatever the unsigned 402 asked for, so a dishonest provider could publish a manifest priced at 0.0001 USDC and demand 1000 USDC to any address in any SAC token. `X402Client` and `MppChargeClient` now compare the challenge's network, payee, asset and amount against the manifest and throw `RouteDockPolicyRejectError` with a `challenge_*` reason before any signer is called. `PaymentResult.amount` reports the amount actually signed, which may be less than the manifest price, and `stroopsToUsdc` is exported from `@routedock/nulth-sdk` as the inverse of `usdcToStroops`.

- [#492](https://github.com/winsznx/routedock/pull/492) [`70fbcd5`](https://github.com/winsznx/routedock/commit/70fbcd55f55180c1162de33225a7568a1925409f) Thanks [@chiomailekuba](https://github.com/chiomailekuba)! - Reject negative `amountStroops` and non-safe-integer or negative `ledgerSequence` in nulth policy enforcement with `RangeError`.

## 0.2.0

### Minor Changes

- [#180](https://github.com/winsznx/routedock/pull/180) [`4da4b78`](https://github.com/winsznx/routedock/commit/4da4b78729b0a31866cef1c99539f54152734293) Thanks [@Jaydearcadian](https://github.com/Jaydearcadian)! - Restore the public npm release pipeline, build every publishable package before publication, and prepare the RouteDock packages for their 0.2.0 releases.

### Patch Changes

- [#469](https://github.com/winsznx/routedock/pull/469) [`34a1a79`](https://github.com/winsznx/routedock/commit/34a1a7961b9aa61a006a654ea8c1835b0529002e) Thanks [@joydeelish](https://github.com/joydeelish)! - Point the require condition in exports at the emitted .d.cts declarations so CJS consumers on node16/nodenext get CJS types.

- [#441](https://github.com/winsznx/routedock/pull/441) [`98fc671`](https://github.com/winsznx/routedock/commit/98fc671b25d858010a5bc52c451b936852028be7) Thanks [@Yerimahjr](https://github.com/Yerimahjr)! - Nulth signers now decode the Soroban auth entry before signing and reject it with `NulthPolicyError` code `auth_entry_mismatch` unless it is a single `transfer` on `assetContract` from the Nulth account to `paymentContext.payee` for exactly `paymentContext.amountStroops`, with no sub-invocations. `assertAuthEntryMatchesContext` is exported from `@routedock/nulth-sdk`.

- [#480](https://github.com/winsznx/routedock/pull/480) [`b9d8b7e`](https://github.com/winsznx/routedock/commit/b9d8b7ef84f9cf3b484efc4b56d06de93dd193be) Thanks [@Mayor-Isaac](https://github.com/Mayor-Isaac)! - Make the Nulth mainnet guard fail closed. `NulthClient` construction now throws unless `network` is `'testnet'`, and throws on any prover other than `'mock'`, so a missing or misspelled network (for example `'pubnet'`), a network read from env or JSON, or a legacy `prover: 'wasm'` setting can no longer produce a mock-proof client on a non-testnet network.

- [#467](https://github.com/winsznx/routedock/pull/467) [`155e610`](https://github.com/winsznx/routedock/commit/155e610d1a2cd0a8419b3169e484183a342dd666) Thanks [@joydeelish](https://github.com/joydeelish)! - Publish only dist/ and README.md from each package.

- [#237](https://github.com/winsznx/routedock/pull/237) [`2eac983`](https://github.com/winsznx/routedock/commit/2eac983f738b83fecbc259b94e55d27c4b9dd7d7) Thanks [@TS-mfon](https://github.com/TS-mfon)! - Block the insecure Nulth mock prover on mainnet and stop advertising an unimplemented WASM backend.
