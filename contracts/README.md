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
  --wasm target/wasm32-unknown-unknown/release/agent_vault.wasm \
  --source $DEPLOYER_KEY \
  --network testnet
```

> **⚠️ SECURITY WARNING:** The underlying `stellar-experimental/one-way-channel` contract
> is **unaudited**. RouteDock wraps it with safe defaults and a durable server-side
> session store, but production use should await a formal audit.
