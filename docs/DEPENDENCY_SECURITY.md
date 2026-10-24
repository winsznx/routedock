# Dependency security maintenance

The workspace uses pnpm 9.15.9. Run `pnpm install --frozen-lockfile` and
`pnpm audit --prod --audit-level=high` to inspect the deployed dependency graph.
The dependency-audit CI job reports findings in its job summary without blocking
merges. Dependabot checks the npm workspace weekly and groups minor/patch updates.

## October 20, 2026 refresh

Next.js and eslint-config-next are pinned to 16.4.2. The Cloudflare adapter is
updated to 1.20.12, whose Next.js peer range includes 16.4.2; Wrangler and provider
Worker types are aligned with the adapter toolchain. The MCP server requires
@modelcontextprotocol/sdk ^1.32.1. The lockfile refresh also upgrades transitive
ws, proxy-addr, sharp, PostCSS and other patched packages within allowed ranges.

The production audit changed from 4 critical, 64 high, 68 moderate and 10 low
findings to 0 critical, 3 high, 6 moderate and 0 low findings. No Next.js advisory
remains. These are registry results on the date above, not a promise about future
advisories. Re-run the audit when reviewing or updating this change.

## Override

`axios@>=1.0.0 <1.20.0` resolves to `^1.20.0`. Axios is transitive, and a refreshed
Stellar dependency still selected 1.18.0. This compatible-major override clears
GHSA-c29m-xwm3-cm6r, GHSA-mghh-pgcx-3jjj, GHSA-x97p-jq2g-jp4f,
GHSA-3pq3-5fj3-cg6v, GHSA-542g-h47m-68v8, GHSA-m8m8-qj5v-23w3, and
GHSA-r4gj-5m52-g5wh. Remove the override when upstream requirements select patched
versions on every path without it.

## Remaining high findings

| Dependency | Advisory | Why it remains |
| --- | --- | --- |
| toml 3.0.0 | GHSA-82x6-q7mm-w9cf | The Stellar SDK depends on the 3.x parser; the fix is in 4.2.0. Replacing a protocol SDK's parser across a major version needs a separate compatibility change. |
| toml 3.0.0 | GHSA-v5mp-jgw5-2x6j | The same Stellar SDK dependency requires a 4.x migration for the prototype-pollution fix. |
| braces 3.0.3 | GHSA-vfj7-8cjw-p6xm | The advisory lists no patched release. It is reached through development/release glob tooling such as Changesets and Tailwind. |

The TOML findings are relevant when processing untrusted Stellar TOML documents;
this refresh does not claim to fix them. The remaining moderate findings include
mppx, sprintf-js and postcss-selector-parser. Keep them visible in CI until patched
upstream versions can be adopted and tested.
