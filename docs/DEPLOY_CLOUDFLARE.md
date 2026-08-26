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
