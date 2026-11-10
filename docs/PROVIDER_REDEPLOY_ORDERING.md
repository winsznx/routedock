# Provider redeploy ordering (SDK-first rollout rule)

When a change affects the manifest schema, manifest signing protocol, or advertised payment modes, `main` and the deployed Cloudflare Workers (`api-a.routedock.xyz`, `api-b.routedock.xyz`) must be rolled out in strict order so published `@routedock/routedock` clients never encounter a manifest version or payment mode they cannot validate.

## Why ordering matters

- Published `@routedock/routedock` SDK clients strictly validate the provider manifest (`/.well-known/routedock.json`), including `signature_version` and advertised `modes`.
- Redeploying either provider from `main` before the matching SDK release is published to npm can cause existing clients to reject the updated manifest.
- Redeploying only one provider while the other remains on an older build creates inconsistent behavior across endpoints.

## Required order

1. Merge the Changesets release PR on `main` and wait for the release workflow to publish the updated `@routedock/routedock` package to npm.
2. Confirm the new `@routedock/routedock` version is live on npm (`npm view @routedock/routedock version`).
3. Apply any pending database migrations in `supabase/migrations/` before deploying Worker code that depends on them.
4. Redeploy **both** providers together using `run deploy` (not pnpm's built-in `pnpm deploy` command):
   ```bash
   pnpm --filter provider-a run deploy
   pnpm --filter provider-b run deploy
   ```
5. Verify both providers serve valid signed manifests (`/.well-known/routedock.json`) and pass `/health` checks, and confirm a current `@routedock/routedock` client can pay each provider.

Keep the window between step 2 (SDK published on npm) and step 4 (both providers redeployed) as short as possible.
