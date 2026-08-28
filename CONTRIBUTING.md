# Contributing to RouteDock

RouteDock moves real money on Stellar. The bar for a change is that it is verified, not that it looks right. This document is the short path to a PR that passes CI on the first try.

## Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node | **>= 22** | `wrangler` 4 refuses to run on Node 20, and both providers build through it |
| pnpm | **9.15.9** | pinned in `packageManager` |
| Rust | 1.94.1 | only for `contracts/` |

Node 20 is the single most common cause of a red build here. Check before anything else:

```bash
node --version   # must be v22 or newer
```

## Setup

```bash
pnpm install
pnpm --filter @routedock/nulth-sdk build
pnpm --filter @routedock/routedock build
```

**Build order matters and is not optional.** `@routedock/routedock` depends on `nulth-sdk`'s output, and several packages import `@routedock/routedock/schema`, which resolves to the SDK's built `dist/` rather than its source. Skipping these two builds produces `ERR_MODULE_NOT_FOUND` in tests that pass for everyone else.

## Verify before you push

One command runs the same things CI does, in the same order:

```bash
pnpm verify          # build + typecheck + tests + provider bundles
pnpm verify --fast   # build + typecheck only
```

A **pre-push hook** runs `pnpm verify --fast` automatically. It is installed by
`pnpm install` (via `prepare`, which sets `core.hooksPath`), so you get it
without doing anything. Bypass with `git push --no-verify` when you need to.

It runs on push rather than on every commit deliberately: the check has to build
the SDK first, which is slow enough that a per-commit hook gets bypassed, and a
bypassed hook catches nothing. Pushing is the point where the work becomes
someone else's problem.

If you would rather run the steps individually:

```bash
# 1. Types across every package
pnpm -r typecheck

# 2. Tests
pnpm --filter @routedock/routedock test
pnpm --filter @routedock/mcp-server test
pnpm --filter provider-a test
pnpm --filter provider-b test

# 3. Builds — for the two providers this bundles a real Workers script
pnpm --filter @routedock/nulth-sdk build
pnpm --filter @routedock/routedock build
pnpm -r --filter '!@routedock/nulth-sdk' --filter '!@routedock/routedock' build

# 4. Contracts, only if you touched contracts/
cargo test --manifest-path contracts/agent-vault/Cargo.toml
cargo test --manifest-path contracts/agent-vault/Cargo.toml --features testutils
```

If all of that is green locally, CI will be green, with one exception noted below.

### A stale `dist/` will lie to you

Local `dist/` directories are gitignored but persist between branches, so a test can pass on your machine using output built from different code. When a test result surprises you:

```bash
rm -rf packages/*/dist apps/*/dist
pnpm --filter @routedock/nulth-sdk build && pnpm --filter @routedock/routedock build
```

### Cloudflare Workers changes

`apps/provider-a` and `apps/provider-b` are Cloudflare Workers. Their `build` script is `wrangler deploy --dry-run`, which bundles but deploys nothing and **needs no Cloudflare credentials** — it works in CI and on a fresh clone.

To run one locally:

```bash
cd apps/provider-a
cp .dev.vars.example .dev.vars   # fill in a throwaway testnet key
pnpm dev
```

`.dev.vars` is gitignored. Never put a secret in `wrangler.jsonc`; it is committed. Real secrets are set with `wrangler secret put` by a maintainer.

Adding a dependency to a provider is the highest-risk change in this repo. The Workers runtime rejects `eval` and `new Function`, which is why `ajv` validates manifests in a **test** rather than at startup. Always confirm your dependency bundles:

```bash
pnpm --filter provider-a build   # fails loudly if the dep is Workers-hostile
```

## Standards

These are enforced in review, not by a linter, so please self-check:

- **No `as any`, `@ts-ignore`, or `@ts-expect-error`.** If a cast seems necessary to compile, that is usually the type telling you something real — say so on the PR instead of silencing it. Several open issues exist precisely because casts hid a bug.
- **No empty `catch` blocks.**
- **Money is integers.** Use the helpers in `packages/sdk/src/internal/usdc.ts`. Do not hand-roll decimal parsing or accumulate amounts as floats.
- **Match the surrounding code.** Comment density, naming, and structure should be indistinguishable from the file you are editing.
- **Fix minimally.** A bugfix PR should not also refactor.

## Tests

Follow the existing style: `#given` / `#when` / `#then` comments, one logical assertion per test, descriptive names. Cover the failure path, not just the happy one.

Note that provider tests currently only validate manifest shape. If your change touches the payment path, say on the PR how you verified it — a `curl` against `pnpm dev` showing the 402 challenge is worth more than a green unit test here.

## Opening a PR

1. Branch from `main`.
2. Add a changeset if you changed anything under `packages/` — `pnpm changeset`. Without one, your change ships no version bump.
3. Reference the issue (`Closes #123`).
4. Describe how you verified it. Paste real output.

If a maintainer pushes a fix-up to your branch, it is because the wave is time-boxed, not a comment on your work. The reasoning will be in the commit message.

## Issues that need a maintainer

Some issues cannot be completed by a contributor alone, because they need credentials or settings no fork has. These are labelled **`needs-maintainer`**. You can still do the code, but say so on the PR and a maintainer will finish the deploy or migration step.

Typically that means:

- applying a Supabase migration (no public database access)
- deploying a Worker or attaching a hostname (needs `CLOUDFLARE_API_TOKEN`)
- anything requiring `AGENT_SECRET` or a funded testnet account
- repository or organisation settings

## Getting help

Comment on the issue. A partial PR with a clear question beats a silent stall.
