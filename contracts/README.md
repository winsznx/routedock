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
  --lifetime_cap 0
```

#### Constructor Arguments & Units

Deploying the vault passes configuration arguments atomically to `__constructor`:

- `--admin`: Stellar G-address of the vault admin (can adjust caps, rotate keys, transfer admin, freeze/unfreeze, upgrade).
- `--agent_pk`: 32-byte Ed25519 public key of the agent as 64 hex characters.
- `--daily_cap`: Daily USDC spend limit in stroops (1 USDC = 10,000,000 stroops; `250000000` = 25 USDC).
- `--allowlist`: JSON map of payee address to daily sub-cap in stroops (e.g. `'{"<PAYEE_G_ADDRESS>":"250000000"}'`).
- `--expiry_ledger`: Absolute ledger sequence at which session expires (compared against `env.ledger().sequence()`; not a duration).
- `--lifetime_cap`: Lifetime USDC spend limit in stroops (`0` = unlimited).

> **⚠️ SECURITY WARNING:** The underlying `stellar-experimental/one-way-channel` contract
> is **unaudited**. RouteDock wraps it with safe defaults and a durable server-side
> session store, but production use should await a formal audit.
>
> **Audit Status:**
> - Shortlisted auditors: [OtterSec](https://ottersec.com/), [Hacken](https://hacken.io/), [Trail of Bits](https://trailofbits.com/)
> - SCF Audit Bank application: Submitted
