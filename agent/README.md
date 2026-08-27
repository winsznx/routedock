# RouteDock Reference Agent

Autonomous reference agent demonstrating multi-mode micropayments (`x402`, `mpp-charge`, and `mpp-session`) over the Stellar network using `@routedock/routedock`.

## Overview

The agent executes the full autonomous payment workflow:
1. **Initialize**: Derive agent keypair, check Horizon USDC balance & trustline.
2. **x402 Discrete Query**: Execute forced `x402` micropayment against Provider A `/price`.
3. **MPP Charge Query**: Execute natural mode selection (`mpp-charge`) against Provider A `/price`.
4. **MPP Session Streaming**: Open channel session with Provider B `/stream/orderbook`, stream 50 SSE events via 50 off-chain vouchers, and settle on-chain in 2 transactions (`open` + `close`).
5. **Policy Rejection**: Demonstrate local pre-payment spend cap enforcement without broadcasting any transaction to Stellar Horizon.

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `AGENT_SECRET` | Required | Stellar secret key (starts with `S...`) |
| `STELLAR_NETWORK` | `testnet` | Stellar network (`testnet` or `mainnet`) |
| `PROVIDER_A_URL` | `http://localhost:3001` | URL for discrete price provider |
| `PROVIDER_B_URL` | `http://localhost:3002` | URL for streaming orderbook provider |
| `AGENT_DAILY_CAP_USDC` | `0.002` | Daily spending cap in USDC |
| `AGENT_SPEND_STORE_PATH` | `~/.routedock/spend.json` | Path to persistent file spend store |
| `COMMITMENT_SECRET` | Optional | Ed25519 commitment secret key for `mpp-session` |

## Spend Cap & Store Durability

> [!WARNING]
> **Production Safety Warning**:
> By default, initializing `RouteDockClient` without a `spendStore` parameter uses `InMemorySpendStore`.
> An in-memory spend cap resets to zero on every process restart, OOM kill, or container redeploy, which allows spend limits to be bypassed across runs.
>
> **Do not rely on an in-memory spend cap in production.**
> Always pass a durable `SpendStore` (such as `FileSpendStore` pointing to disk, Redis, or SQL) via `spendStore` in `RouteDockClientConfig`:
>
> ```typescript
> import { RouteDockClient, FileSpendStore } from '@routedock/routedock'
>
> const client = new RouteDockClient({
>   wallet: keypair,
>   network: 'testnet',
>   spendCap: { daily: '10.0', asset: 'USDC' },
>   spendStore: new FileSpendStore('~/.routedock/spend.json'),
> })
> ```

## Running the Agent

```bash
pnpm --filter agent dev
```
