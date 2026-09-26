# Cloudflare Workers deployment

Provider A and Provider B are deployed as Cloudflare Workers.

## Secrets and environment configuration

Before deploying, create each provider's `.dev.vars` file by copying `.dev.vars.example` and filling in real values. These files are gitignored and must never be committed to version control:

```bash
cp apps/provider-a/.dev.vars.example apps/provider-a/.dev.vars
cp apps/provider-b/.dev.vars.example apps/provider-b/.dev.vars
```

### Required secrets

- **Provider A (`apps/provider-a/.dev.vars`)**:
  - `STELLAR_PAYEE_SECRET`: Secret key for signing payouts and settlements.
  - `STELLAR_PAYEE_ADDRESS`: Corresponding public key.
  - `OPENZEPPELIN_API_KEY`: API key for gasless transaction sponsorship.
  - `USDC_ASSET_CONTRACT`: Address of the USDC asset contract on the target network. (*Note: Not in `.dev.vars.example`; add this before bulk upload, as Provider A requires it on mainnet.*)
  - `SUPABASE_URL` *(optional)*: Database URL if using the registry.
  - `SUPABASE_SERVICE_KEY` *(optional)*: Service key for Supabase registry access.

- **Provider B (`apps/provider-b/.dev.vars`)**:
  - `STELLAR_PAYEE_SECRET`: Secret key for signing settlements.
  - `STELLAR_PAYEE_ADDRESS`: Corresponding public key.
  - `CHANNEL_CONTRACT_ID`: Deployed state channel contract ID.
  - `COMMITMENT_PUBLIC_KEY`: Commitment signer public key (*required; the `ChannelSession` Durable Object throws without it*).
  - `USDC_ASSET_CONTRACT`: Address of the USDC asset contract on the target network. (*Note: Not in `.dev.vars.example`; add this before bulk upload.*)
  - `SUPABASE_URL` *(optional)*: Database URL if using the registry.
  - `SUPABASE_SERVICE_KEY` *(optional)*: Service key for Supabase registry access.

Non-secret environment variables (such as `STELLAR_NETWORK` and `PUBLIC_BASE_URL`) live directly in each provider's `wrangler.jsonc`.

When `SUPABASE_URL` is configured, apply the database migrations in [supabase/migrations/](../supabase/migrations/) to your Supabase project.

### Scheduled triggers

Provider B registers a `*/15 * * * *` cron trigger in its `wrangler.jsonc`. When deployed, Cloudflare Workers triggers this schedule every 15 minutes to forward periodic settlement reconciliation to the `ChannelSession` Durable Object.

## Deployment steps

From the repository root, upload secrets and deploy both Workers using `pnpm --filter`:

```bash
pnpm install --frozen-lockfile
pnpm --filter provider-a exec wrangler secret bulk .dev.vars
pnpm --filter provider-a run deploy
pnpm --filter provider-b exec wrangler secret bulk .dev.vars
pnpm --filter provider-b run deploy
```

> **Note**: `pnpm --filter <pkg> exec` executes in the package directory so `wrangler` resolves that package's local `wrangler.jsonc` and `.dev.vars`. `run deploy` ensures pnpm invokes the package's deploy script rather than pnpm's built-in `pnpm deploy` command.

## Verification

Verify deployments with health and metadata queries:

```bash
curl -fsS https://api-a.routedock.xyz/health
curl -fsS https://api-b.routedock.xyz/.well-known/routedock.json
```

## Database prerequisites

Apply the Supabase migrations in filename order (`001` through `005`).
Migration `004_settlement_retention.sql` creates the
`cleanup_stale_settlements(7)` function. Migration
`005_enable_pg_cron_retention.sql` then attempts to enable `pg_cron` and
register the daily `settlement-retention-cleanup` job at 03:00 UTC.

`pg_cron` must be available and permitted by the Postgres/Supabase project
for the automatic job to be installed. Check the result with:

```sql
select jobid, jobname, schedule, command
from cron.job
where jobname = 'settlement-retention-cleanup';
```

If the extension is unavailable or cannot be enabled, the migration emits a
warning and leaves the cleanup function available. Run
`select cleanup_stale_settlements(7);` from a trusted external scheduler once
per day instead.

## Related guides

- [docs/MAINNET_DEPLOYMENT.md](MAINNET_DEPLOYMENT.md) (Section 7: Step-by-step mainnet rollout and individual secret management)
- [docs/PROVIDER_REDEPLOY_ORDERING.md](PROVIDER_REDEPLOY_ORDERING.md) (Zero-downtime provider redeployment ordering)
