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
  - Stellar Expert webhook configured for vault contract events (`payment_authorized`, `vault_frozen`, `vault_unfrozen`, `agent_key_rotated`, `expiry_updated`, `cap_updated`, `allowlist_updated`, `session_settled`, `admin_transfer_requested`, `admin_changed`, `upgrade_proposed`, `upgrade_cancelled`, `upgraded`) + channel contracts.
  - Command:
    ```bash
    curl -s https://stellar.expert/explorer/public | head -n 1
    ```
- [ ] **Rollback plan tested**
  - Procedure validated to stop the agent, sweep funds, rotate keys, and freeze/expire the vault (see Section 9).
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

Starting in SDK 0.2.0, each `client.pay()` call runs a trustline preflight check before submitting any on-chain transaction:

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

Record the output as `AGENT_VAULT_CONTRACT_ID`. This ID is used by operators in `stellar contract invoke` management commands (the reference agent does not read it from the environment).

### Constructor Parameter Units & Stricter Production Policy

Deploy-time arguments configure the vault atomically in `__constructor`:

- **`--admin`**: Vault administrator Stellar G-address holding exclusive authorization for admin entrypoints (`set_daily_cap`, `set_lifetime_cap`, `add_to_allowlist`, `remove_from_allowlist`, `set_expiry`, `set_agent_pubkey`, `freeze`/`unfreeze`, `propose_upgrade`, `execute_upgrade`, `cancel_upgrade`, `transfer_admin`).
- **`--agent_pk`**: Agent's 32-byte Ed25519 public key as 64 hex characters used to authorize payments via `__check_auth`.
- **`--daily_cap`**: Daily spend cap in USDC stroops, where 1 USDC = 10,000,000 stroops (`250000000` = 25 USDC/day conservative cap).
- **`--allowlist`**: Map of payee address to daily sub-cap in stroops (JSON object format, e.g. `'{"<PAYEE_G_ADDRESS>":"250000000"}'`). Restrict to production provider payee accounts.
- **`--expiry_ledger`**: Absolute ledger sequence (compared against `env.ledger().sequence()`, **not** a relative duration). Set a short session key lifetime (e.g. current ledger + 720 for ~1 hour, or 4,320 for ~6 hours).
- **`--lifetime_cap`**: Total USDC stroops the vault may ever spend over its lifetime. Set to `0` for unlimited.

Read back the deployed policy to confirm it landed on-chain (simulate-only via `--send=no`):

```bash
stellar contract invoke --id <AGENT_VAULT_CONTRACT_ID> --source-account <VAULT_ADMIN_ALIAS> --network mainnet --send=no -- daily_cap
stellar contract invoke --id <AGENT_VAULT_CONTRACT_ID> --source-account <VAULT_ADMIN_ALIAS> --network mainnet --send=no -- allowlist
stellar contract invoke --id <AGENT_VAULT_CONTRACT_ID> --source-account <VAULT_ADMIN_ALIAS> --network mainnet --send=no -- expiry_ledger
stellar contract invoke --id <AGENT_VAULT_CONTRACT_ID> --source-account <VAULT_ADMIN_ALIAS> --network mainnet --send=no -- agent_pubkey
```

### Vault Admin Functions Reference

| Function | Purpose |
| :--- | :--- |
| `freeze` | Freeze the contract to immediately block all agent transfers during an incident or key compromise. |
| `unfreeze` | Unfreeze the contract to restore agent transfer authorization once remediation is complete. |
| `set_expiry` | Extend or expire session keys (set ledger `<= latest` to immediately invalidate active keys). |
| `set_agent_pubkey` | Rotate the agent's authorized 32-byte Ed25519 public key (hex) after a key leak. |
| `set_daily_cap` | Adjust the global daily USDC spend cap (in stroops) across all payees. |
| `set_lifetime_cap` | Set the lifetime cap (stroops, 0 disables). |
| `add_to_allowlist` | Add or update an allowed payee address with a per-payee daily sub-cap (in stroops). |
| `remove_from_allowlist` | Remove a payee address from the allowlist so payments to it are rejected. |
| `propose_upgrade` | Propose a new contract wasm bytecode hash subject to the timelock delay (admin-only). |
| `execute_upgrade` | Execute a proposed contract wasm upgrade once the timelock delay has elapsed (admin-only). |
| `cancel_upgrade` | Cancel an active contract wasm upgrade proposal before or after readiness (admin-only). |
| `transfer_admin` | Propose transferring contract admin ownership to a new address (2-step transfer). |
| `accept_admin` | Called by the pending admin address to claim contract ownership. |

Example environment snippet for agent runtime:

```bash
STELLAR_NETWORK=mainnet
AGENT_DAILY_CAP_USDC=25
```

Note: `AGENT_DAILY_CAP_USDC` is the SDK's local client-side daily cap in decimal USDC (enforced before submitting transactions).

### Timelocked Wasm upgrade runbook

New deployments enforce a fixed 17,280-ledger delay (approximately one day) from the first proposal. Upgrades on a contract still running the previous Wasm require one unavoidable bootstrap invocation through its old immediate `upgrade` entry point; the old deployed code cannot enforce a rule it does not contain. After that transition, use the new flow exclusively:

1. Build and independently review the target Wasm, then upload it and record its exact 32-byte hash.
2. Call `propose_upgrade(new_wasm_hash)` with the vault admin. Record the `upgrade_proposed` event and verify `pending_upgrade` returns the expected hash and `ready_at_ledger`.
3. Notify vault operators and governed payers, link the reviewed build, and allow the full ledger delay. Rescheduling replaces the target and restarts the delay.
4. If the proposal is no longer approved, call `cancel_upgrade` before execution and verify `upgrade_cancelled` plus an empty `pending_upgrade`.
5. At or after `ready_at_ledger`, call `execute_upgrade()` with the vault admin. Verify the system executable update and custom `upgraded` event contain the approved hash.
6. Re-check `daily_cap`, `allowlist`, `agent_pubkey`, and `expiry_ledger`, then run a capped authorization smoke test before restoring traffic.

The timelock provides notice for code replacement only. The same admin can still rotate keys and change policy settings; use hardware-backed custody, alerts, and tested operator procedures.

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
USDC_ASSET_CONTRACT=<MAINNET_USDC_SAC_CONTRACT_ID>
PROVIDER_A_URL=https://api-a.routedock.xyz
PROVIDER_B_URL=https://api-b.routedock.xyz
SUPABASE_URL=https://<your-project>.supabase.co
SUPABASE_ANON_KEY=<your-anon-key>
```

### Smoke-check Manifests and Health Endpoints

```bash
curl -s https://api-a.routedock.xyz/.well-known/routedock.json | jq '.network,.pricing.x402.facilitator'
curl -s https://api-b.routedock.xyz/.well-known/routedock.json | jq '.network,.pricing["mpp-session"].channel_factory'
curl -s https://api-a.routedock.xyz/health
curl -s https://api-b.routedock.xyz/health
```

---

## 8) Monitoring setup

### Stellar Expert webhooks

Configure alerts for:
- Agent vault contract invocations and events:
  - `payment_authorized`
  - `vault_frozen`
  - `vault_unfrozen`
  - `agent_key_rotated`
  - `expiry_updated`
  - `cap_updated`
  - `allowlist_updated`
  - `session_settled`
  - `admin_transfer_requested`
  - `admin_changed`
  - `upgrade_proposed`
  - `upgrade_cancelled`
  - `upgraded`
  *(Note: Rejected transfers emit no event per `contracts/agent-vault/src/lib.rs`, so on-chain indexing cannot alert on policy rejections.)*
- Channel open/close transactions (`open`, `close`)
- Failed transactions involving payee accounts

Example webhook filter values:

```text
network=public
entity=<AGENT_VAULT_CONTRACT_ID>
entity=<CHANNEL_CONTRACT_ID>
entity=<PAYEE_G_ADDRESS>
```

---

## 9) Operational runbook

### Incident response

1. Freeze autonomous traffic by disabling agent runs.
2. Expire active session keys via `set_expiry` (setting ledger `<= latest` immediately invalidates keys).
3. Revoke compromised API tokens (OZ + service credentials).
4. Review latest on-chain tx + Supabase logs.

### Key rotation procedure

1. Generate new hardware-backed key.
2. Update key secrets in Cloudflare Workers (`wrangler secret put STELLAR_PAYEE_SECRET` / `STELLAR_PAYEE_ADDRESS`).
3. Shift traffic to new key and redeploy.
4. Revoke old key and archive incident record.

### Emergency pause and key compromise procedure

When an agent secret or session key is suspected compromised, follow this ordered procedure:

1. **Stop the agent process:**
   Immediately terminate the running agent process (`kill <pid>`, `systemctl stop`, etc.) to halt automated spending. Do **not** restart the agent until keys and balances are secured.

2. **Sweep agent account funds & rotate `AGENT_SECRET`:**
   Because the reference agent pays directly from its Stellar keypair, immediately transfer remaining USDC and XLM off the agent account to a cold storage account:
   ```bash
   # Sweep USDC
   stellar tx new payment \
     --source-account <AGENT_ALIAS> \
     --destination <COLD_G_ADDRESS> \
     --asset USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN \
     --amount <USDC_STROOPS> \
     --network mainnet

   # Sweep native XLM (leave the minimum base reserve)
   stellar tx new payment \
     --source-account <AGENT_ALIAS> \
     --destination <COLD_G_ADDRESS> \
     --amount <XLM_STROOPS> \
     --network mainnet
   ```
   Then generate a new `AGENT_SECRET` and update `agent/.env`. This fund sweep is the critical step that prevents a leaked `AGENT_SECRET` from draining the agent account.

3. **Freeze vault, rotate agent key, and restore session expiry (if using agent vault):**
   For any funds held in an agent vault, immediately freeze the contract with the admin key:
   ```bash
   stellar contract invoke \
     --id <AGENT_VAULT_CONTRACT_ID> \
     --source-account <VAULT_ADMIN_ALIAS> \
     --network mainnet \
     -- freeze
   ```
   Optionally, for containment, immediately expire active keys by passing the current or a past ledger sequence (`stellar ledger latest --network mainnet`):
   ```bash
   stellar contract invoke \
     --id <AGENT_VAULT_CONTRACT_ID> \
     --source-account <VAULT_ADMIN_ALIAS> \
     --network mainnet \
     -- set_expiry \
     --new_expiry <CURRENT_OR_PAST_LEDGER>
   ```
   Rotate the vault's authorized agent key to the new key's 32-byte Ed25519 public key (hex). Note that `set_agent_pubkey` already invalidates the old key on its own:
   ```bash
   stellar contract invoke \
     --id <AGENT_VAULT_CONTRACT_ID> \
     --source-account <VAULT_ADMIN_ALIAS> \
     --network mainnet \
     -- set_agent_pubkey \
     --new_pk <NEW_AGENT_PUBKEY_HEX>
   ```
   Reset `set_expiry` to a fresh future ledger sequence (e.g. current ledger + 720 for ~1 hour) so the newly installed agent key is not locked out (as `expiry_ledger` applies globally to the vault, not per-key):
   ```bash
   stellar contract invoke \
     --id <AGENT_VAULT_CONTRACT_ID> \
     --source-account <VAULT_ADMIN_ALIAS> \
     --network mainnet \
     -- set_expiry \
     --new_expiry <FUTURE_LEDGER>
   ```
   Only after the new key is installed and the fresh future expiry ledger is set, unfreeze the contract:
   ```bash
   stellar contract invoke \
     --id <AGENT_VAULT_CONTRACT_ID> \
     --source-account <VAULT_ADMIN_ALIAS> \
     --network mainnet \
     -- unfreeze
   ```
