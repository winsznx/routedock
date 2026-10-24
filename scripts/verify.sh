#!/usr/bin/env bash
#
# Local mirror of CI. Run before pushing:
#
#   pnpm verify          full run (build + typecheck + tests)
#   pnpm verify --fast   skip tests, keep build + typecheck
#
# The build steps are not optional. Several packages import
# @routedock/routedock/schema, which resolves to the SDK's built dist/ rather
# than its source, so typechecking against a stale or missing dist/ produces
# failures that do not exist and hides ones that do.
set -euo pipefail

FAST=0
[[ "${1:-}" == "--fast" ]] && FAST=1

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

fail() { printf '\n\033[31m✘ %s\033[0m\n' "$1" >&2; exit 1; }
step() { printf '\n\033[36m▸ %s\033[0m\n' "$1"; }

step "node version"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
if (( node_major < 22 )); then
  fail "Node $(node --version) is too old. wrangler 4 requires >= 22, and both providers build through it."
fi
echo "  $(node --version)"

step "lockfile is in sync"
# CI installs with --frozen-lockfile. A package.json edited without rerunning
# pnpm install fails there before a single test runs.
pnpm install --frozen-lockfile --prefer-offline >/dev/null 2>&1 \
  || fail "pnpm-lock.yaml is out of date with a package.json. Run 'pnpm install' at the root and commit the lockfile."
echo "  ok"

step "no legacy package name references"
# The package is published as @routedock/routedock. The old unpublised name
# (the one with "sdk" as the last path segment) does not exist on npm, so any
# copy-paste from it fails. The [d] keeps this guard from matching itself.
# CHANGELOG.md and MIGRATION.md keep historical references.
if grep -rn "@routedock/s[d]k" \
    --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
    --exclude=CHANGELOG.md --exclude=MIGRATION.md .; then
  fail "Found legacy @routedock/s[d]k references (use @routedock/routedock instead)"
fi
echo "  ok"

step "build sdk packages"
pnpm --filter @routedock/nulth-sdk build >/dev/null || fail "@routedock/nulth-sdk failed to build"
pnpm --filter @routedock/routedock build >/dev/null || fail "@routedock/routedock failed to build"
echo "  ok"

step "runtime-neutral bundles"
# client, react and provider/hono must not reach node:* built-ins or Buffer.
node scripts/check-runtime-neutral.mjs --self-test >/dev/null && node scripts/check-runtime-neutral.mjs \
  || fail "a runtime-neutral entry imports a Node built-in or Buffer (see above)"

step "typecheck Nulth README examples"
pnpm --filter @routedock/nulth-sdk check:readme || fail "Nulth README examples do not typecheck"

step "typecheck all packages"
pnpm -r typecheck || fail "typecheck failed"

if (( FAST )); then
  printf '\n\033[32m✔ verify --fast passed\033[0m (tests skipped)\n'
  exit 0
fi

step "tests"
pnpm --filter @routedock/routedock test
pnpm --filter @routedock/mcp-server test
pnpm --filter provider-a test
pnpm --filter provider-b test

step "provider bundles"
# Catches a dependency that cannot run on Workers — the runtime rejects eval
# and new Function, which is why ajv validates manifests in a test, not at
# startup. Needs no Cloudflare credentials.
pnpm --filter provider-a build >/dev/null || fail "provider-a does not bundle for Workers"
pnpm --filter provider-b build >/dev/null || fail "provider-b does not bundle for Workers"
echo "  ok"

step "package pack hygiene"
pnpm --filter @routedock/mcp-server build >/dev/null || fail "@routedock/mcp-server failed to build"
bash "$root/scripts/check-pack.sh" || fail "package pack check failed"

printf '\n\033[32m✔ verify passed\033[0m\n'
