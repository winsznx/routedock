#!/usr/bin/env bash
# Rehearse the release path against a throwaway npm registry (issue #718).
#
# .github/workflows/release.yml only runs on push to main, so a change to the
# release script, the changeset config, or @changesets/cli itself is normally
# first executed after merge, outside any PR's checks. This runs the same
# `pnpm run release` entrypoint release.yml uses (changesets/action's `publish:`)
# against a local Verdaccio and then asserts the contract the action depends on:
# one `New tag:` line per publishable package on stdout, and the package really
# present in the registry.
#
# Needs no secrets and never contacts registry.npmjs.org for @routedock/*.
#
# It MUTATES the working tree (strips publishConfig.provenance, renames pending
# changesets, adds a throwaway one, bumps versions, creates git tags). In CI the
# checkout is disposable. Locally it needs a clean tree and restores it on exit.
#
# Prerequisites: `pnpm install --frozen-lockfile` has been run.
# Overrides: REHEARSAL_PORT (default 4873), VERDACCIO_CMD (default
# `npx --yes verdaccio@6.11.3`).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

port="${REHEARSAL_PORT:-4873}"
registry="http://127.0.0.1:${port}/"
verdaccio_cmd="${VERDACCIO_CMD:-npx --yes verdaccio@6.11.3}"
work="$(mktemp -d)"
verdaccio_pid=""

if [ -z "${CI:-}" ] && [ -n "$(git status --porcelain)" ]; then
  echo "release-rehearsal: refusing to run on a dirty tree (it rewrites package.json files and creates tags)." >&2
  echo "Commit or stash first, or run it in a disposable checkout." >&2
  exit 2
fi

tags_before="$(git tag --list)"

cleanup() {
  status=$?
  if [ -n "$verdaccio_pid" ]; then
    kill "$verdaccio_pid" 2>/dev/null || true
  fi
  # Drop the tags `changeset publish` created, and in a local run restore the tree.
  comm -13 <(printf '%s\n' "$tags_before" | sort) <(git tag --list | sort) \
    | while read -r tag; do [ -n "$tag" ] && git tag -d "$tag" >/dev/null; done
  if [ -z "${CI:-}" ]; then
    git checkout -- . >/dev/null 2>&1 || true
    git clean -fdq >/dev/null 2>&1 || true
  fi
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT

# ── Throwaway registry ───────────────────────────────────────────────────────
cp scripts/verdaccio.yaml "$work/verdaccio.yaml"
# shellcheck disable=SC2086
$verdaccio_cmd --config "$work/verdaccio.yaml" --listen "127.0.0.1:${port}" \
  >"$work/verdaccio.log" 2>&1 &
verdaccio_pid=$!

for _ in $(seq 1 90); do
  if curl -fsS "${registry}-/ping" >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! curl -fsS "${registry}-/ping" >/dev/null 2>&1; then
  echo "release-rehearsal: Verdaccio did not start on ${registry}" >&2
  cat "$work/verdaccio.log" >&2 || true
  exit 1
fi

# A dummy token satisfies npm's "must be logged in to publish" check; the
# throwaway registry accepts anyone.
cat >"$work/npmrc" <<EOF
registry=${registry}
//127.0.0.1:${port}/:_authToken=rehearsal
EOF
export NPM_CONFIG_USERCONFIG="$work/npmrc"
export npm_config_registry="$registry"
export NPM_CONFIG_PROVENANCE=false
unset NPM_TOKEN NODE_AUTH_TOKEN || true

# `changeset publish` creates tags; git needs an identity even for them in some setups.
export GIT_AUTHOR_NAME="release-rehearsal" GIT_AUTHOR_EMAIL="release-rehearsal@localhost"
export GIT_COMMITTER_NAME="release-rehearsal" GIT_COMMITTER_EMAIL="release-rehearsal@localhost"

# ── Same steps as release.yml ────────────────────────────────────────────────
node scripts/release-rehearsal.mjs prepare

echo "::group::pnpm run version"
pnpm run version
echo "::endgroup::"

echo "::group::pnpm run release (publish: in release.yml)"
# changesets/action reads stdout only, so keep stdout separate for the assertion.
set +e
pnpm run release 2>"$work/release.stderr" | tee "$work/release.stdout"
release_status=${PIPESTATUS[0]}
set -e
cat "$work/release.stderr" >&2
echo "::endgroup::"
if [ "$release_status" -ne 0 ]; then
  echo "release-rehearsal: \`pnpm run release\` exited with status ${release_status}" >&2
  exit "$release_status"
fi

node scripts/release-rehearsal.mjs assert "$work/release.stdout"
