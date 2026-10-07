# contracts/

Smart contracts for RouteDock on Stellar.

## agent-vault/

The RouteDock agent vault is a Soroban smart contract account built on top of
[Crossmint/stellar-smart-account](https://github.com/Crossmint/stellar-smart-account) v1.0.0.

**Status:** Not yet scaffolded. Requires Rust + Soroban SDK setup.

### Policies (Phase 1 implementation)

1. **Daily USDC cap** — rejects any transfer that would exceed the configured daily spend limit
2. **Endpoint allowlist** — rejects payments to payee addresses not on the allowlist
3. **Session key with expiry** — session signing key expires at a configured ledger sequence

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

- Rust toolchain with `wasm32-unknown-unknown` target
- Stellar CLI (`stellar`)
- Soroban SDK

### Build & Deploy

```bash
stellar contract build
stellar contract deploy \
  --wasm target/wasm32v1-none/release/agent_vault.wasm \
  --source $DEPLOYER_KEY \
  --network testnet \
  -- \
  --admin <ADMIN_G_ADDRESS> \
  --agent_pk <AGENT_ED25519_PUBKEY_64_HEX> \
  --daily_cap 250000000 \
  --allowlist '{"<PAYEE_G_ADDRESS>":"250000000"}' \
  --expiry_ledger <ABSOLUTE_LEDGER_SEQUENCE> \
  --lifetime_cap 0 \
  --asset <USDC_SAC_CONTRACT_ID>
```

#### Constructor Arguments & Units

Deploying the vault passes configuration arguments atomically to `__constructor`:

- `--admin`: Stellar G-address of the vault admin (can adjust caps, rotate keys, transfer admin, freeze/unfreeze, upgrade).
- `--agent_pk`: 32-byte Ed25519 public key of the agent as 64 hex characters.
- `--daily_cap`: Daily USDC spend limit in stroops (1 USDC = 10,000,000 stroops; `250000000` = 25 USDC).
- `--allowlist`: JSON map of payee address to daily sub-cap in stroops (e.g. `'{"<PAYEE_G_ADDRESS>":"250000000"}'`).
- `--expiry_ledger`: Absolute ledger sequence at which session expires (compared against `env.ledger().sequence()`; not a duration).
- `--lifetime_cap`: Lifetime USDC spend limit in stroops (`0` = unlimited).
- `--asset`: SAC contract ID of the spend asset (e.g. USDC). Only `transfer` calls on this asset with the vault as payer are authorized; the admin can rotate it with `set_asset`. Upgraded vaults must call `set_asset` before payments resume (fail-closed).

> **⚠️ SECURITY WARNING:** The underlying `stellar-experimental/one-way-channel` contract
> is **unaudited**. RouteDock wraps it with safe defaults and a durable server-side
> session store, but production use should await a formal audit.
>
> **Audit Status:**
> - Shortlisted auditors: [OtterSec](https://ottersec.com/), [Hacken](https://hacken.io/), [Trail of Bits](https://trailofbits.com/)
> - SCF Audit Bank application: Submitted
