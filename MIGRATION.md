# Migration: apps/web Vercel → Cloudflare Workers (2026-08-02)

The **`apps/web`** Next.js app (the RouteDock site + dashboard) was moved off Vercel (Hobby account
soft-blocked for exceeding function-invocation fair-use limits) onto **Cloudflare Workers** via the
**OpenNext** adapter. It's dynamic (SSR / `force-dynamic` home page pulling live provider data), so
it runs as a real Worker — requires the **Workers Paid ($5/mo)** plan.

Scope: only `apps/web`. The `agent/`, `packages/`, and `contracts/` workspaces are unaffected.

## Changes made
| File | Change | Why |
|------|--------|-----|
| `apps/web/open-next.config.ts` | New | OpenNext Cloudflare adapter config. |
| `apps/web/wrangler.jsonc` | New | Workers config: `main: .open-next/worker.js`, `nodejs_compat`, assets binding. All 6 public `NEXT_PUBLIC_*` vars live here. |
| `apps/web/components/landing/HeroCodeBlock.tsx` | Stopped calling Shiki at runtime; now renders a **pre-highlighted** HTML constant | Cloudflare Workers disallow runtime WASM (Shiki's Oniguruma engine) and Shiki's hast serializer deps don't bundle under pnpm. |
| `apps/web/components/landing/heroCodeHtml.ts` | New — pre-generated highlighted HTML | Output of `scripts/gen-hero-code.mjs`. |
| `apps/web/scripts/gen-hero-code.mjs` | New — regenerates the hero HTML with Shiki (run in Node) | So the snippet can be re-highlighted if the code changes. |
| `apps/web/app/opengraph-image.tsx` | **Deleted** | `@vercel/og` also needs runtime WASM (blocked on Workers). |
| `apps/web/package.json` | Added `@opennextjs/cloudflare` + `wrangler` devDeps, `deploy`/`preview`/`gen:hero` scripts | Reproducible deploys. |

## Env
All 6 vars are public `NEXT_PUBLIC_*` (Supabase URL/anon, Stellar network/expert URL, provider A/B URLs)
— no secrets. Pulled from Vercel into `apps/web/.env.production.local` (gitignored) for the build and
mirrored into `wrangler.jsonc` `vars` for runtime.

## Deploy
```bash
cd apps/web && npm run deploy      # = opennextjs-cloudflare build && deploy
```
Needs `CLOUDFLARE_API_TOKEN` in env.

- **Live (Workers subdomain):** https://routedock.timjosh507.workers.dev
- **Cloudflare Worker name:** `routedock`

## Custom domain (routedock.xyz) — PENDING
`routedock.xyz` is not yet added to Cloudflare. To finish: add it as a zone, move nameservers at the
registrar, then attach `routedock.xyz` + `www.routedock.xyz` to the `routedock` Worker (delete stale
Vercel records first).
