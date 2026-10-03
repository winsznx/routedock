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
- [ ] **Key custody & Cloudflare Workers secret management approved**
  - Signing keys live in HSM or Ledger-backed flow.
  - No raw seeds stored in `.env`, `.dev.vars`, shell history, CI logs, or chat.
  - **`wrangler.jsonc` is committed to git**: Never place secret seeds (`S...`) or API keys in the `vars` block of `wrangler.jsonc`.
  - All production secrets for Cloudflare Workers must be injected exclusively via `wrangler secret put`. Local development secrets must only exist in uncommitted `.dev.vars` files.
  - Command (sanity check for accidental secrets in env/config files):
    ```bash
    rg -n "(SECRET=|SEED|S[ABCDEFGHIJKLMNOPQRSTUVWXYZ234567]{55})" apps agent docs --glob "*.env*" --glob "*.dev.vars*" --glob "*.jsonc"
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

> ⚠️ **CRITICAL SECURITY NOTE:** Never place `S...` secret seeds in `.env` files or `wrangler.jsonc` `vars` (since `wrangler.jsonc` is committed to version control). Deployed Cloudflare Workers must receive secrets via `wrangler secret put`. For local development only, use uncommitted `.dev.vars`. For testing, use isolated ephemeral accounts only.

---

## 3) USDC trustline & asset contract (mainnet)

RouteDock mainnet flow expects USDC trustline to Circle's official Stellar issuer. If the payer account lacks a trustline, `client.pay()` now throws `RouteDockTrustlineError` preflight — before any transaction is submitted — with the exact remediation command.

- **Issuer:** `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`

Create trustline from the funding account:

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

### Runtime preflight

Starting in SDK v0.1.3+, each `client.pay()` call runs a trustline preflight check before submitting any on-chain transaction:

1. Queries Horizon for the payer account's balances.
2. Checks for a balance entry matching the manifest's `asset` code (e.g. `USDC`).
3. **Trustline found** → caches the result for 5 minutes (keyed by `network:pubkey:asset`) so subsequent payments to the same asset cost zero RPC calls.
4. **No trustline** → throws `RouteDockTrustlineError` with the exact `stellar tx new change-trust` CLI command for remediation.

The check is non-blocking in degraded scenarios: if Horizon is unreachable, the SDK logs a warning and continues without blocking the payment.

Call `client.preflight(manifest)` explicitly to validate a manifest's asset trustline without executing a payment.

### Mandatory `USDC_ASSET_CONTRACT` on Mainnet

> ⚠️ **MANDATORY CONFIGURATION:** `USDC_ASSET_CONTRACT` is **required** on mainnet for both providers and the agent. `resolveAssetContract` in `apps/provider-a/src/worker.ts` and `apps/provider-b/src/config.ts` throws an error if `USDC_ASSET_CONTRACT` is missing on mainnet, because only testnet has a default fallback contract address — each provider refuses to serve on mainnet without it, and `/health` returns 503 naming `USDC_ASSET_CONTRACT` as missing.

Obtain or deploy the Stellar Asset Contract (SAC) wrapper ID for mainnet USDC and record it as `USDC_ASSET_CONTRACT`.

---

## 4) Deploy agent vault contract (mainnet policies)

Build and deploy from `contracts/agent-vault`:

```bash
cd contracts/agent-vault
stellar contract build
stellar contract deploy \
  --wasm target/wasm32v1-none/release/agent_vault.wasm \
  --source <MAINNET_DEPLOYER_ALIAS> \
  --network mainnet \
  -- \
  --admin <ADMIN_G_ADDRESS> \
  --agent_pk <AGENT_ED25519_PUBKEY_64_HEX> \
  --daily_cap 250000000 \
  --allowlist '{"<PAYEE_G_ADDRESS>":"250000000"}' \
  --expiry_ledger <ABSOLUTE_LEDGER_SEQUENCE> \
  --lifetime_cap 0
```

Record the output as `AGENT_VAULT_CONTRACT_ID`.

### Constructor Parameter Units & Stricter Production Policy

Deploy-time arguments configure the vault atomically in `__constructor`:

- **`--admin`**: Vault administrator Stellar G-address holding exclusive authorization for admin entrypoints (`set_daily_cap`, `add_to_allowlist`, `remove_from_allowlist`, `set_expiry`, `set_agent_pubkey`, `freeze`/`unfreeze`, `upgrade`, `transfer_admin`).
- **`--agent_pk`**: Agent's 32-byte Ed25519 public key as 64 hex characters used to authorize payments via `__check_auth`.
- **`--daily_cap`**: Daily spend cap in USDC stroops, where 1 USDC = 10,000,000 stroops (`250000000` = 25 USDC/day conservative cap).
- **`--allowlist`**: Map of payee address to daily sub-cap in stroops (JSON object format, e.g. `'{"<PAYEE_G_ADDRESS>":"250000000"}'`). Restrict to production provider payee accounts.
- **`--expiry_ledger`**: Absolute ledger sequence (compared against `env.ledger().sequence()`, **not** a relative duration). Set a short session key lifetime (e.g. current ledger + 720 for ~1 hour, or 4,320 for ~6 hours).
- **`--lifetime_cap`**: Total USDC stroops the vault may ever spend over its lifetime. Set to `0` for unlimited.

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
2. Store securely via `wrangler secret put OPENZEPPELIN_API_KEY`.
3. Revoke old token after 100% cutover.
4. Document rotation timestamp and owner.

---

## 7) Cloudflare Workers & Agent Configuration (Mainnet Rollout)

Both `provider-a` and `provider-b` run as **Cloudflare Workers**. 

> ⚠️ **CUTOVER ORDERING CONSTRAINT (#265):**
> Do not redeploy providers to mainnet individually before the SDK package publishes to npm. Follow the strict ordering from tracking issue **#265**:
> 1. Publish `@routedock/routedock@0.2.0` to npm (which includes `signature_version: '2'`).
> 2. Configure production secrets via `wrangler secret put` on both Workers.
> 3. Redeploy **both** providers simultaneously (`pnpm --filter provider-a deploy` & `pnpm --filter provider-b deploy`).
> 4. Verify both serve `signature_version: '2'` and are reachable before sending agent traffic.

### Provider A (`apps/provider-a`) — Cloudflare Worker

Public variables in `apps/provider-a/wrangler.jsonc` (committed):
```jsonc
{
  "name": "routedock-provider-a",
  "vars": {
    "STELLAR_NETWORK": "mainnet",
    "USDC_ASSET_CONTRACT": "<MAINNET_USDC_SAC_CONTRACT_ID>",
    "SUPABASE_URL": "https://<your-project>.supabase.co"
  }
}
```

Upload sensitive secrets using `wrangler secret put`:
```bash
cd apps/provider-a
wrangler secret put STELLAR_PAYEE_SECRET
wrangler secret put STELLAR_PAYEE_ADDRESS
wrangler secret put OPENZEPPELIN_API_KEY
wrangler secret put SUPABASE_SERVICE_KEY
wrangler secret put USDC_ASSET_CONTRACT
```

Deploy Provider A:
```bash
wrangler deploy
```

### Provider B (`apps/provider-b`) — Cloudflare Worker

Public variables in `apps/provider-b/wrangler.jsonc` (committed):
```jsonc
{
  "name": "routedock-provider-b",
  "vars": {
    "STELLAR_NETWORK": "mainnet",
    "USDC_ASSET_CONTRACT": "<MAINNET_USDC_SAC_CONTRACT_ID>",
    "SUPABASE_URL": "https://<your-project>.supabase.co"
  }
}
```

Upload sensitive secrets using `wrangler secret put`:
```bash
cd apps/provider-b
wrangler secret put STELLAR_PAYEE_SECRET
wrangler secret put STELLAR_PAYEE_ADDRESS
wrangler secret put CHANNEL_CONTRACT_ID
wrangler secret put COMMITMENT_PUBLIC_KEY
wrangler secret put SUPABASE_SERVICE_KEY
wrangler secret put USDC_ASSET_CONTRACT
```

Deploy Provider B:
```bash
wrangler deploy
```

### Agent Service (`agent`) — Node Runtime

The agent runner runs as a standalone Node service configured via `agent/.env`:

`agent/.env`:
```bash
STELLAR_NETWORK=mainnet
AGENT_SECRET=<S...>
AGENT_VAULT_CONTRACT_ID=<MAINNET_AGENT_VAULT_CONTRACT_ID>
USDC_ASSET_CONTRACT=<MAINNET_USDC_SAC_CONTRACT_ID>
PROVIDER_A_URL=https://api-a.routedock.xyz
PROVIDER_B_URL=https://api-b.routedock.xyz
SUPABASE_URL=https://<your-project>.supabase.co
SUPABASE_ANON_KEY=<your-anon-key>
```

### Smoke-check Manifests and Health Endpoints

```bash
curl -s https://api-a.routedock.xyz/.well-known/routedock.json | jq '.network,.pricing.x402.facilitator'
curl -s https://api-b.routedock.xyz/.well-known/routedock.json | jq '.network,.pricing["mpp-session"].channel_contract'
curl -s https://api-a.routedock.xyz/health
curl -s https://api-b.routedock.xyz/health
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
2. Update key secrets in Cloudflare Workers (`wrangler secret put STELLAR_PAYEE_SECRET` / `STELLAR_PAYEE_ADDRESS`).
3. Shift traffic to new key and redeploy.
4. Revoke old key and archive incident record.

### Emergency pause via session key expiry

Set minimal session expiry in `agent/.env`:

```bash
SESSION_EXPIRY_LEDGERS=5
```

Then restart agent service:

```bash
pnpm --filter agent start
```

This keeps custody with primary vault controls while rapidly reducing session key blast radius.
