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

### Timelocked Wasm upgrades

Wasm replacement is a two-step process with a fixed **17,280-ledger notice period** (approximately one day at the vault's existing ledger-day accounting rate):

- `propose_upgrade(new_wasm_hash)` — admin only; stores the target and earliest executable ledger, extends the instance TTL through the notice period, and emits `upgrade_proposed`.
- `pending_upgrade()` — returns `Some((new_wasm_hash, ready_at_ledger))` until the proposal is executed or cancelled.
- `upgrade_timelock_ledgers()` — returns the fixed delay so clients do not need to hard-code it.
- `execute_upgrade()` — admin only; succeeds at or after `ready_at_ledger`, updates the executable, clears the proposal, and emits `upgraded`.
- `cancel_upgrade()` — admin only; clears a proposal even after it becomes executable and emits `upgrade_cancelled`.

A replacement proposal replaces the current target and restarts the full delay. The ledger calculation fails closed on overflow instead of saturating into immediate readiness. The target Wasm must already be uploaded on-chain when execution is attempted; a missing target rolls the transaction back and leaves the proposal pending.

The old immediate `upgrade(new_wasm_hash)` entry point has been removed. A contract already running the old Wasm needs one unavoidable bootstrap call through that old interface before it can expose this timelock; new deployments are protected from genesis.

This mechanism gives users notice before the enforcement code changes. It does **not** make the single-admin model trustless: the admin can still rotate agent keys and change caps, allowlists, expiry, and freeze state. Every target Wasm hash must be reviewed, and operators should monitor upgrade events.

### Prerequisites

- Rust 1.94.1 for the repository's locked Soroban dependency graph
- `wasm32-unknown-unknown` target for release builds
- Stellar CLI (`stellar`)
- Soroban SDK 22

### Test, build, and deploy

```bash
cargo +1.94.1 test --manifest-path contracts/agent-vault/Cargo.toml
cargo +1.94.1 test --manifest-path contracts/agent-vault/Cargo.toml --features testutils

cd contracts/agent-vault
stellar contract build
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/agent_vault.wasm \
  --source $DEPLOYER_KEY \
  --network testnet
```

> **⚠️ SECURITY WARNING:** The contract and the underlying
> `stellar-experimental/one-way-channel` contract are unaudited. RouteDock uses
> conservative defaults and durable server-side enforcement, but production use
> should await formal audits and a reviewed upgrade procedure.
>
> **Audit status:**
> - Shortlisted auditors: [OtterSec](https://ottersec.com/), [Hacken](https://hacken.io/), [Trail of Bits](https://trailofbits.com/)
> - SCF Audit Bank application: submitted
