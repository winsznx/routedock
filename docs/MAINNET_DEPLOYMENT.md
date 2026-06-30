# Mainnet Deployment Guide

This guide documents the production mainnet rollout for RouteDock. It assumes you already run the project on testnet and want to move to Stellar mainnet by switching `STELLAR_NETWORK=mainnet` with production-grade controls.

---

## 1) Pre-flight security checklist

Do **not** deploy until every item below is explicitly marked done by the operator on call.

- [ ] **Contract audit status confirmed**
  - Agent vault contract code reviewed internally and tagged release commit.
  - `stellar-experimental/one-way-channel` risk accepted by engineering + security leadership (see Section 5 disclaimer).
  - Command:
    ```bash
    git rev-parse HEAD
    ```
- [ ] **Key custody plan approved**
  - Signing keys live in HSM or Ledger-backed flow.
  - No raw seeds stored in `.env`, shell history, CI logs, or chat.
  - Command (sanity check for accidental secrets in env files):
    ```bash
    rg -n "(SECRET=|SEED|S[ABCDEFGHIJKLMNOPQRSTUVWXYZ234567]{55})" apps agent docs --glob "*.env*"
    ```
- [ ] **Monitoring and alerting live**
  - Stellar Expert webhook configured for vault + channel contracts.
  - Supabase alerting configured for `policy_reject` spikes.
  - Command:
    ```bash
    curl -s https://stellar.expert/explorer/public | head -n 1
    ```
- [ ] **Rollback plan tested**
  - Procedure validated to stop new sessions, rotate keys, and force session expiry.
  - Last tabletop timestamp recorded.
  - Command:
    ```bash
    date -u
    ```

---

## 2) Mainnet keypair generation

Use hardware-backed key management only.

### Option A — HSM / KMS signer (recommended for production)

1. Create the key in your HSM/KMS and export only the public key.
2. Store key metadata in your secrets manager (not raw seed).
3. Verify account address:

```bash
# Example: read from secure runtime injection
echo "$STELLAR_PAYEE_ADDRESS"
```

### Option B — Ledger device

1. Initialize Ledger with secure PIN and recovery phrase backup policy.
2. Derive Stellar account and export public key only.
3. Verify:

```bash
stellar keys address ledger-mainnet --hd-path "44'/148'/0'" --network mainnet
```

> Never place `S...` secret seeds in `.env` files. For local testing, use isolated ephemeral accounts only.

---

## 3) USDC trustline (mainnet)

RouteDock mainnet flow expects USDC trustline to Circle's official Stellar issuer:

- **Issuer:** `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`

Create trustline from the vault funding account:

```bash
stellar tx new --source <MAINNET_SIGNER_ALIAS> --network mainnet \
  change-trust \
  --asset USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN \
  --limit 100000
```

Verify trustline exists:

```bash
stellar account balance <ACCOUNT_ADDRESS> --network mainnet
```

---

## 4) Deploy agent vault contract (mainnet policies)

Build and deploy from `contracts/agent-vault`:

```bash
cd contracts/agent-vault
stellar contract build
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/agent_vault.wasm \
  --source <MAINNET_DEPLOYER_ALIAS> \
  --network mainnet
```

Record the output as `AGENT_VAULT_CONTRACT_ID`.

Apply stricter production policy inputs:

- **Daily cap:** set conservative cap (example `25` USDC/day).
- **Allowlist:** only production provider payee accounts.
- **Expiry:** short session key lifetime (example 1-6 hours by ledger window).

Example environment snippet for agent runtime:

```bash
STELLAR_NETWORK=mainnet
AGENT_DAILY_CAP_USDC=25
AGENT_VAULT_CONTRACT_ID=<C...>
ALLOWED_PAYEES=<G...>,<G...>
SESSION_EXPIRY_LEDGERS=450
```

---

## 5) Deploy one-way-channel contract

> ⚠️ **UNAUDITED CONTRACT NOTICE:** `stellar-experimental/one-way-channel` is unaudited. Mainnet usage requires explicit organizational risk acceptance.

Deploy from upstream repo:

```bash
git clone https://github.com/stellar-experimental/one-way-channel
cd one-way-channel
stellar contract build
stellar contract deploy \
  --wasm target/wasm32v1-none/release/one_way_channel.wasm \
  --source <MAINNET_DEPLOYER_ALIAS> \
  --network mainnet
```

Record output as `CHANNEL_CONTRACT_ID` and set in provider + agent environments.

---

## 6) OpenZeppelin facilitator setup (x402)

RouteDock mainnet x402 uses OpenZeppelin Channels facilitator at:

- `https://channels.openzeppelin.com/x402`

Provision API token and configure bearer auth:

```bash
export OPENZEPPELIN_API_KEY="<oz-token>"
curl -i https://channels.openzeppelin.com/x402 \
  -H "Authorization: Bearer $OPENZEPPELIN_API_KEY"
```

Rotation guidance:

1. Create new token.
2. Deploy with both old/new valid in staged rollout.
3. Revoke old token after 100% cutover.
4. Document rotation timestamp and owner.

---

## 7) Switch `STELLAR_NETWORK=mainnet` in providers and agent

Update runtime env for all services.

`apps/provider-a/.env`:

```bash
STELLAR_NETWORK=mainnet
OPENZEPPELIN_API_KEY=<oz-token>
USDC_ASSET_CONTRACT=<mainnet-usdc-sac-contract>
```

`apps/provider-b/.env`:

```bash
STELLAR_NETWORK=mainnet
CHANNEL_CONTRACT_ID=<mainnet-channel-contract>
USDC_ASSET_CONTRACT=<mainnet-usdc-sac-contract>
```

`agent/.env`:

```bash
STELLAR_NETWORK=mainnet
AGENT_VAULT_CONTRACT_ID=<mainnet-agent-vault>
```

Smoke-check manifests and health endpoints:

```bash
curl -s http://localhost:3001/.well-known/routedock.json | jq '.network,.pricing.x402.facilitator'
curl -s http://localhost:3002/.well-known/routedock.json | jq '.network,.pricing["mpp-session"].contract'
```

---

## 8) Monitoring setup

### Stellar Expert webhooks

Configure alerts for:
- agent vault contract invocations
- channel open/close transactions
- failed transactions involving payee accounts

Example webhook filter values:

```text
network=public
entity=<AGENT_VAULT_CONTRACT_ID>
entity=<CHANNEL_CONTRACT_ID>
entity=<PAYEE_G_ADDRESS>
```

### Supabase alerts for `policy_reject`

Track local policy enforcement failures from `tx_log`.

SQL check:

```sql
select created_at, tx_type, error
from public.tx_log
where tx_type = 'policy_reject'
order by created_at desc
limit 50;
```

Alert threshold example:
- warning: `>= 5` rejects in 10 minutes
- critical: `>= 20` rejects in 10 minutes

---

## 9) Operational runbook

### Incident response

1. Freeze autonomous traffic by disabling agent runs.
2. Expire active session keys (set immediate/near-immediate ledger expiry).
3. Revoke compromised API tokens (OZ + service credentials).
4. Review latest on-chain tx + Supabase logs.

### Key rotation procedure

1. Generate new hardware-backed key.
2. Add new key to allowlists/config.
3. Shift traffic to new key.
4. Revoke old key and archive incident record.

### Emergency pause via session key expiry

Set minimal session expiry and redeploy agent env:

```bash
SESSION_EXPIRY_LEDGERS=5
```

Then restart agent service:

```bash
pnpm --filter @routedock/agent start
```

This keeps custody with primary vault controls while rapidly reducing session key blast radius.
