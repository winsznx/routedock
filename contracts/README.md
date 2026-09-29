# contracts/

Smart contracts for RouteDock on Stellar.

## agent-vault/

The RouteDock agent vault is a Soroban smart contract account built on top of
[Crossmint/stellar-smart-account](https://github.com/Crossmint/stellar-smart-account) v1.0.0.

**Status:** Implemented and covered by native contract tests. The contract and its dependencies have not received a production security audit.

### Policies

1. **Daily USDC cap** — rejects any transfer that would exceed the configured daily spend limit.
2. **Endpoint allowlist and per-payee caps** — rejects recipients outside the allowlist and enforces each payee's daily sub-cap.
3. **Session key with expiry** — the agent signing key expires at a configured ledger sequence.
4. **Lifetime USDC cap** — optionally bounds total lifetime spend without resetting on day boundaries.
5. **Freeze and two-step admin transfer** — support emergency control while preventing a mistyped admin transfer from orphaning the vault.

All signed authorizations are default-deny: only SAC `transfer` contexts accepted by the policies above can pass `__check_auth`.

### Prerequisites

- Rust 1.94.1 for the repository's locked Soroban dependency graph
- `wasm32v1-none` target for release builds
- Stellar CLI (`stellar`)
- Soroban SDK 22

### Test, build, and deploy

```bash
cargo +1.94.1 test --manifest-path contracts/agent-vault/Cargo.toml
cargo +1.94.1 test --manifest-path contracts/agent-vault/Cargo.toml --features testutils

cd contracts/agent-vault
stellar contract build
```

> **⚠️ SECURITY WARNING:** The contract and the underlying
> `stellar-experimental/one-way-channel` contract are unaudited. RouteDock uses
> conservative defaults and durable server-side enforcement, but production use
> should await formal audits and a reviewed upgrade procedure.
>
> **Audit status:**
> - Shortlisted auditors: [OtterSec](https://ottersec.com/), [Hacken](https://hacken.io/), [Trail of Bits](https://trailofbits.com/)
> - SCF Audit Bank application: submitted
