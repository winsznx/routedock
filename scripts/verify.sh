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

step "build sdk packages"
pnpm --filter @routedock/nulth-sdk build >/dev/null || fail "@routedock/nulth-sdk failed to build"
pnpm --filter @routedock/routedock build >/dev/null || fail "@routedock/routedock failed to build"
echo "  ok"

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

printf '\n\033[32m✔ verify passed\033[0m\n'
