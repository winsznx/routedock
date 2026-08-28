# @routedock/nulth-sdk — Stub / Proof-of-Concept

**Status: STUB — not ready for production.**

This package provides an **insecure mock prover** (`insecureMockProof`) that computes a
SHA-512 digest as a placeholder. No real zero-knowledge proof is generated.

- The mock prover is only safe for **testnet** development.
- **Mainnet use is blocked at `NulthClient` construction**. This package does not
  currently implement a production prover backend.
- The `mock` backend is deliberately not a cryptographic proof and must never be
  used for custody or policy enforcement.

See [Issue #143](https://github.com/winsznx/routedock/issues/143) for context.
