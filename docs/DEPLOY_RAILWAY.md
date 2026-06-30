# Railway Deployment Guide

Both providers (`provider-a` and `provider-b`) deploy as separate Railway services.

## Prerequisites

- Railway CLI installed: `npm install -g @railway/cli`
- Railway account at [railway.app](https://railway.app)
- Supabase project created, migrations applied (`supabase db push`)
- Stellar keypairs generated for each provider (use `stellar keys generate`)

## provider-a (Price Endpoint)

### 1. Initialise the Railway project

```bash
cd apps/provider-a
railway login
railway init
# Select "Create new project" and name it "routedock-provider-a"
```

### 2. Link to the project root (required for pnpm workspace)

Railway's Nixpacks builder detects pnpm workspaces. It installs from the workspace root, then runs the service's build command. Ensure the root `pnpm-workspace.yaml` is committed.

### 3. Set environment variables

```bash
railway variables set \
  STELLAR_NETWORK=testnet \
  STELLAR_PAYEE_SECRET=S... \
  STELLAR_PAYEE_ADDRESS=G... \
  OPENZEPPELIN_API_KEY=your-oz-key \
  USDC_ASSET_CONTRACT=CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA \
  SUPABASE_URL=https://your-project.supabase.co \
  SUPABASE_SERVICE_KEY=eyJ...
```

> `PORT` is set automatically by Railway — do not set it manually.

### 4. Deploy

```bash
railway up
```

### 5. Get the deployed URL

```bash
railway domain
# e.g. https://routedock-provider-a.up.railway.app
```

Record this URL as `PROVIDER_A_URL` in the agent and frontend env vars.

### 6. Verify

```bash
curl https://routedock-provider-a.up.railway.app/health
# { "status": "ok", "network": "testnet", ... }

curl https://routedock-provider-a.up.railway.app/.well-known/routedock.json
# full manifest
```

---

## provider-b (Stream Endpoint)

### 1. Initialise

```bash
cd apps/provider-b
railway login
railway init
# Name it "routedock-provider-b"
```

### 2. Set environment variables

```bash
railway variables set \
  STELLAR_NETWORK=testnet \
  STELLAR_PAYEE_SECRET=S... \
  STELLAR_PAYEE_ADDRESS=G... \
  CHANNEL_CONTRACT_ID=C... \
  USDC_ASSET_CONTRACT=CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA \
  SUPABASE_URL=https://your-project.supabase.co \
  SUPABASE_SERVICE_KEY=eyJ...
```

### 3. Deploy

```bash
railway up
```

### 4. Get the deployed URL

```bash
railway domain
# e.g. https://routedock-provider-b.up.railway.app
```

Record this as `PROVIDER_B_URL`.

### 5. Verify

```bash
curl https://routedock-provider-b.up.railway.app/health
curl https://routedock-provider-b.up.railway.app/.well-known/routedock.json
```

---

## Shared env vars across services

Railway supports environment variable groups. Create a shared group for:
- `STELLAR_NETWORK`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`

Attach this group to both services to avoid duplicating secrets.

## Updating env vars after ROUTEDOCK_MASTER.md references

Once deployed, update:
- `apps/web/.env.local` → `NEXT_PUBLIC_PROVIDER_A_URL` and `NEXT_PUBLIC_PROVIDER_B_URL`
- `agent/.env` → `PROVIDER_A_URL` and `PROVIDER_B_URL`

---

## Monorepo note

Railway's Nixpacks builder handles pnpm workspaces correctly when the `pnpm-workspace.yaml` is at the repo root. The `railway.json` in each provider directory specifies the build and start commands relative to that service's working directory.

If Railway cannot find the workspace root automatically, set the **Root Directory** in the Railway service settings to the repo root (`/`), not the provider subdirectory. The `buildCommand` in `railway.json` runs `pnpm build` which compiles only the current package (via `tsc`).
