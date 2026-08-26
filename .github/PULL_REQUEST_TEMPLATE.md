<!--
Before opening: read CONTRIBUTING.md. The most common red build here is Node 20 —
this repo needs Node >= 22 because wrangler 4 refuses to run on 20.
-->

Closes #

## What changed

<!-- One or two sentences. What was wrong, what does it do now. -->

## How I verified it

<!--
Paste real output, not a claim. For payment-path changes, a curl against
`pnpm dev` showing the 402 challenge is worth more than a green unit test.
-->

```
```

## Checklist

- [ ] `node --version` is v22 or newer
- [ ] Built the SDK first (`pnpm --filter @routedock/nulth-sdk build && pnpm --filter @routedock/routedock build`) — several packages import its built `dist/`
- [ ] `pnpm -r typecheck` passes
- [ ] Tests pass for every package I touched
- [ ] `pnpm --filter provider-a build` / `provider-b build` pass if I touched a provider or added a dependency to one
- [ ] No `as any`, `@ts-ignore`, or `@ts-expect-error`
- [ ] Added a changeset (`pnpm changeset`) if I changed anything under `packages/`
- [ ] No secrets in committed files — `wrangler.jsonc` is committed, `.dev.vars` is not

## Anything a maintainer needs to finish

<!--
Some issues need credentials no fork has: applying a Supabase migration,
deploying a Worker, attaching a hostname, or anything needing AGENT_SECRET.
If your change needs one of those, say so here and leave it undone.
-->
