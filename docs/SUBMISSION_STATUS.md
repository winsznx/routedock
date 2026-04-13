# RouteDock Submission Status

Last updated: 2026-04-08

## Section 15 Checklist (from ROUTEDOCK_MASTER.md)

| # | Item | Status | Notes |
|---|---|---|---|
| 1 | Public GitHub repo with clean `README.md` | ⚠️ Needs user action | README written. Push repo to GitHub, make public. |
| 2 | `@routedock/sdk` published to npm | ⚠️ Needs user action | SDK built, checklist at `packages/sdk/PUBLISH_CHECKLIST.md` |
| 3 | Provider A live on Railway with `/.well-known/routedock.json` | ⚠️ Needs user action | Code complete. Deploy per `docs/DEPLOY_RAILWAY.md` |
| 4 | Provider B live on Railway with `/.well-known/routedock.json` | ⚠️ Needs user action | Code complete. Deploy per `docs/DEPLOY_RAILWAY.md` |
| 5 | Agent vault contract deployed to Stellar testnet | ✅ Complete | `CAX5IDLC2XHGQSEA2YN3LPLZ7EXLMRXYX3HFJGKFXS6B7OQXBKWO44LT` |
| 6a | x402 settlement tx hash in README | ⚠️ Needs user action | Placeholder in README. Run agent per `docs/AGENT_RUN_CHECKLIST.md` |
| 6b | MPP charge tx hash in README | ⚠️ Needs user action | Same — produced by agent run |
| 6c | Channel open tx hash in README | ⚠️ Needs user action | Same — requires `CHANNEL_CONTRACT_ID` (one-way-channel deploy) |
| 6d | Channel close tx hash in README | ⚠️ Needs user action | Same |
| 7 | Dashboard live on Vercel with Realtime working | ⚠️ Needs user action | Code complete. Deploy per Section 12.1 of master spec. Set all `NEXT_PUBLIC_*` env vars. |
| 8 | 2–3 minute demo video uploaded | ⚠️ Needs user action | Script at `docs/DEMO_SCRIPT.md` |
| 9 | DoraHacks submission form completed | ⚠️ Needs user action | After all above are done |

---

## TypeScript Status

| Package | Status |
|---|---|
| `packages/sdk` | ✅ 0 errors |
| `apps/web` | ✅ 0 errors |
| `apps/provider-a` | ✅ 0 errors |
| `apps/provider-b` | ✅ 0 errors |
| `agent` | ✅ 0 errors |

---

## Build Status

| Package | Status |
|---|---|
| `apps/web` (`pnpm build`) | ✅ Passes — `/` and `/dashboard` are Dynamic routes |
| `packages/sdk` (`pnpm build`) | ✅ Passes — ESM + CJS + .d.ts output in `dist/` |
| `apps/provider-a` (`tsc`) | ✅ Passes |
| `apps/provider-b` (`tsc`) | ✅ Passes |
| `agent` (`tsc`) | ✅ Passes |
| `contracts/agent-vault` (`cargo build`) | ✅ Passed (Phase 1) — wasm deployed to testnet |

---

## Blocking Items (in priority order)

### BLOCKER 1: one-way-channel contract deployment

`CHANNEL_CONTRACT_ID` is not yet populated. Provider B's MPP session middleware and the agent's Round 3 both require a deployed `stellar-experimental/one-way-channel` contract on Stellar testnet.

**Action:** Follow steps in `docs/AGENT_RUN_CHECKLIST.md` §4 to clone and deploy `stellar-experimental/one-way-channel`.

### BLOCKER 2: Agent run producing real tx hashes

Requires: funded agent keypair + USDC trustline + both providers running + `CHANNEL_CONTRACT_ID` set.

**Action:** Follow `docs/AGENT_RUN_CHECKLIST.md` fully. On success, `agent/RUN_RESULTS.md` contains all 4 hashes.

### BLOCKER 3: 4 tx hashes in README

After agent run, paste hashes from `agent/RUN_RESULTS.md` into the "Live Testnet Transactions" table in `README.md`.

---

## Required User Actions (ordered)

1. Deploy `stellar-experimental/one-way-channel` contract → get `CHANNEL_CONTRACT_ID`
2. Fill all `.env` files (provider-a, provider-b, agent)
3. Deploy provider-a and provider-b to Railway
4. Run agent: `pnpm --filter @routedock/agent start` → produces `agent/RUN_RESULTS.md`
5. Paste 4 tx hashes into `README.md`
6. Deploy dashboard to Vercel (set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_STELLAR_EXPERT_URL=https://stellar.expert/explorer/testnet`, `NEXT_PUBLIC_PROVIDER_A_URL`, `NEXT_PUBLIC_PROVIDER_B_URL`)
7. Enable Realtime on `sessions` and `tx_log` tables in Supabase dashboard
8. Publish `@routedock/sdk` (follow `packages/sdk/PUBLISH_CHECKLIST.md`)
9. Record demo video (follow `docs/DEMO_SCRIPT.md`)
10. Push repo to GitHub, make public, update README with live URLs
11. Submit to DoraHacks
