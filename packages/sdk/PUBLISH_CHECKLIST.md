# RouteDock npm Release Checklist

This repository publishes:

- `@routedock/nulth-sdk`
- `@routedock/routedock`
- `@routedock/mcp-server`

Changesets owns versioning and publication. Do not manually edit package versions or run `npm publish` from a contributor branch.

## Contributor checks

```bash
pnpm exec changeset status
pnpm run release:build
pnpm --filter @routedock/nulth-sdk test
pnpm --filter @routedock/nulth-sdk typecheck
pnpm --filter @routedock/routedock test
pnpm --filter @routedock/routedock typecheck
pnpm --filter @routedock/mcp-server typecheck
(cd packages/nulth-sdk && npm pack --dry-run)
(cd packages/sdk && npm pack --dry-run)
(cd packages/mcp-server && npm pack --dry-run)
```

Confirm that every archive contains the `dist` entrypoints declared in its `package.json` and contains no secrets.

## Automated release

1. Merge the PR containing the changeset.
2. The `Release` workflow opens or updates the Changesets version PR.
3. Review the generated versions and changelogs. For this repair, all three packages should resolve to `0.2.0`.
4. A maintainer confirms that `NPM_TOKEN` can publish the `@routedock` scope.
5. Merge the Changesets version PR. The workflow builds all publishable packages and runs `changeset publish` with public access.

## Post-publish verification

```bash
npm view @routedock/nulth-sdk version
npm view @routedock/routedock version
npm view @routedock/mcp-server version
```

All three commands should return `0.2.0` for this release.
