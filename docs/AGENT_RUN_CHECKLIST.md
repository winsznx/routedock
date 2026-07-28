# Agent Run Checklist

Follow this in order to produce the 4 real Stellar testnet transaction hashes required for the README and submission.

---

## Prerequisites

### 1. Stellar testnet keypair funded with XLM

```bash
# Generate a new keypair (if you don't have one)
stellar keys generate agent-key --network testnet

# Fund with testnet XLM via Friendbot
curl "https://friendbot.stellar.org?addr=$(stellar keys address agent-key)"

# Verify balance
stellar account balance $(stellar keys address agent-key) --network testnet
```

Expected: ~10,000 XLM.

### 2. Add USDC trustline and get testnet USDC

```bash
# Add trustline for testnet USDC
stellar tx new --source agent-key --network testnet \
  change-trust --asset USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 --limit 100

# Get testnet USDC from Circle's testnet faucet: https://faucet.circle.com/
# Select "Stellar Testnet", paste your agent public key, request 10 USDC
```

### 3. Confirm AGENT_VAULT_CONTRACT_ID

The contract was deployed in Phase 1. Verify the value from `AGENT_PROGRESS.md`:

```
AGENT_VAULT_CONTRACT_ID=CAX5IDLC2XHGQSEA2YN3LPLZ7EXLMRXYX3HFJGKFXS6B7OQXBKWO44LT
```

Confirm it's live on testnet: https://stellar.expert/explorer/testnet/contract/CAX5IDLC2XHGQSEA2YN3LPLZ7EXLMRXYX3HFJGKFXS6B7OQXBKWO44LT

### 4. Confirm CHANNEL_CONTRACT_ID (one-way-channel)

> ⚠️ **T22/T23 are blocked on this.** The `stellar-experimental/one-way-channel` contract must be deployed separately to testnet before the MPP session client can open channels.

```bash
# Deploy the one-way-channel contract (from the stellar-experimental repo)
git clone https://github.com/stellar-experimental/one-way-channel
cd one-way-channel
stellar contract build
stellar contract deploy \
  --wasm target/wasm32v1-none/release/one_way_channel.wasm \
  --source $DEPLOYER_SECRET \
  --network testnet
# Record the output → CHANNEL_CONTRACT_ID
```

### 5. Confirm OPENZEPPELIN_API_KEY

Generate free at https://channels.openzeppelin.com/gen (Stellar testnet).

Store as `OPENZEPPELIN_API_KEY` in provider `.env` files.

---

## Environment Files

Fill all `.env` files from their `.env.example` templates:

```bash
cp apps/provider-a/.env.example apps/provider-a/.env
cp apps/provider-b/.env.example apps/provider-b/.env
cp agent/.env.example agent/.env
```

Required values in each:
- `apps/provider-a/.env`: `STELLAR_PAYEE_SECRET`, `STELLAR_PAYEE_ADDRESS`, `OPENZEPPELIN_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
- `apps/provider-b/.env`: Same + `CHANNEL_CONTRACT_ID`
- `agent/.env`: `AGENT_SECRET`, `AGENT_VAULT_CONTRACT_ID`, `PROVIDER_A_URL`, `PROVIDER_B_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`

---

## Build Everything

```bash
pnpm --filter @routedock/sdk build
pnpm --filter @routedock/provider-a build
pnpm --filter @routedock/provider-b build
pnpm --filter @routedock/agent build
```

---

## Start Providers (two separate terminals)

**Terminal 1 — Provider A:**
```bash
pnpm --filter @routedock/provider-a start
# Verify: curl http://localhost:3001/health
# Verify: curl http://localhost:3001/.well-known/routedock.json
```

**Terminal 2 — Provider B:**
```bash
pnpm --filter @routedock/provider-b start
# Verify: curl http://localhost:3002/health
# Verify: curl http://localhost:3002/.well-known/routedock.json
```

> If using deployed Railway URLs instead, set `PROVIDER_A_URL` and `PROVIDER_B_URL` in `agent/.env` to the Railway URLs and skip running providers locally.

---

## Run the Agent

```bash
pnpm --filter @routedock/agent start
```

The agent will:
1. Log its address and starting USDC balance
2. Round 1: x402 query → logs `txHash` (x402 settlement)
3. Round 2: MPP charge query → logs `txHash` (MPP charge)
4. Round 3: MPP session → logs channel open `txHash`, 50 vouchers, then settlement `txHash`
5. Round 4: Policy rejection → logs rejection reason, confirms nothing on-chain
6. Write `agent/RUN_RESULTS.md` with all 4 hashes

Expected `agent/RUN_RESULTS.md` output:
```
x402_settlement_tx: [HASH-1]
mpp_charge_tx:      [HASH-2]
channel_open_tx:    [HASH-3]
channel_close_tx:   [HASH-4]
```

---

## After Successful Run

### 7. Update README.md with real hashes

Open `README.md`, find the "Live Testnet Transactions" table, replace all `[REPLACE WITH REAL HASH]` values with the 4 hashes from `agent/RUN_RESULTS.md`.

### 8. Verify each hash on Stellar Expert

- x402 settlement: should show USDC transfer from agent → provider-a payee
- MPP charge: should show USDC SAC `transfer` invocation
- Channel open: should show Soroban `initialize` invocation with USDC deposit
- Channel close: should show Soroban `close` invocation with cumulative USDC amount

```
https://stellar.expert/explorer/testnet/tx/[HASH]
```

### 9. Update AGENT_PROGRESS.md

Copy all 4 hashes into `AGENT_PROGRESS.md` under a "T22/T23: completed" section.
