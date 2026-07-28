# @routedock/nulth-sdk — Stub / Proof-of-Concept

**Status: STUB — not ready for production.**

This package provides a **mock Groth16 prover** (`mockGroth16Proof`) that computes a
SHA-512 digest as a placeholder. No real zero-knowledge proof is generated.

- The mock prover is only safe for **testnet** development.
- **Mainnet use is blocked** — `prepareNulthSigner` throws `RouteDockManifestError`
  when `network === 'mainnet'` and the prover is `'mock'` (the default).
- To use on mainnet, an explicit `prover: 'wasm'` opt-in is required in
  `NulthVaultConfig` / `NulthClientConfig`, paired with a real Groth16 WASM prover.

See [Issue #143](https://github.com/winsznx/routedock/issues/143) for context.
