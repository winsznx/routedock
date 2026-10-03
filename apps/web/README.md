RouteDock's dashboard — a Next.js app that reads session, voucher and settlement data from Supabase.

## Getting Started

Needs Node 22 or newer.

```bash
pnpm install                                   # from the repo root
pnpm --filter @routedock/nulth-sdk build       # lib/aggregateSessions.ts imports it
cp apps/web/.env.example apps/web/.env.local
pnpm --filter web dev
```

Open [http://localhost:3000/dashboard](http://localhost:3000/dashboard) with your browser to see the result. `.env.example` ships the public testnet Supabase project, so a plain copy gives a working dashboard with no further setup.

```bash
pnpm --filter web test
```

## Deploy

This app runs on Cloudflare Workers via the [OpenNext](https://opennext.js.org/cloudflare) adapter. Config lives in `wrangler.jsonc` and `open-next.config.ts`.

```bash
pnpm preview   # build + run the Worker locally
pnpm deploy    # build + deploy to Cloudflare
```

`deploy` needs `CLOUDFLARE_API_TOKEN` in the environment. See `MIGRATION.md` at the repo root for why this moved off Vercel and what changed.
