# Cloudflare Workers deployment

Provider A and Provider B are deployed as Workers. From the repository root:

```bash
pnpm install --frozen-lockfile
wrangler secret bulk apps/provider-a/.dev.vars
wrangler deploy --config apps/provider-a/wrangler.jsonc
wrangler secret bulk apps/provider-b/.dev.vars
wrangler deploy --config apps/provider-b/wrangler.jsonc
```

Keep production secret files outside version control. Verify deployments with:

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
