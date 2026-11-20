#!/usr/bin/env bash
# One publish path, two modes:
#
#   pnpm run release                      real release (what changesets/action runs)
#   RELEASE_REHEARSAL=1 pnpm run release  PR gate against a throwaway registry
#
# changesets/action v1.9.0 decides *what* to tag by scraping "New tag:" lines
# from `changeset publish` stdout. Nothing in CI used to run that command, so a
# dependency bump could break the contract while every check stayed green
# (#718). Both modes below run the same `pnpm run release`; the rehearsal only
# adds a local registry, a throwaway changeset and the stdout assertions.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

rehearsal="${RELEASE_REHEARSAL:-0}"

publishable=(
  "@routedock/mcp-server"
  "@routedock/nulth-sdk"
  "@routedock/routedock"
)
package_dirs=(
  "packages/mcp-server"
  "packages/nulth-sdk"
  "packages/sdk"
)
# Files `changeset version` rewrites. They are restored on exit so a local
# rehearsal leaves the checkout exactly as it found it.
mutable_files=()
for dir in "${package_dirs[@]}"; do
  mutable_files+=("$dir/package.json" "$dir/CHANGELOG.md")
done

tmp=""
verdaccio_pid=""
changeset_file=""
cleanup() {
  set +e
  if [[ -n "$verdaccio_pid" ]]; then
    kill "$verdaccio_pid" 2>/dev/null
    wait "$verdaccio_pid" 2>/dev/null
  fi
  if [[ -n "$changeset_file" && -f "$changeset_file" ]]; then
    rm -f "$changeset_file"
  fi
  if [[ "$rehearsal" == "1" && -n "$tmp" ]]; then
    for file in "${mutable_files[@]}"; do
      if [[ -f "$tmp/backup/$file" ]]; then
        cp "$tmp/backup/$file" "$root/$file"
      fi
    done
  fi
  if [[ -n "$tmp" ]]; then rm -rf "$tmp"; fi
}
trap cleanup EXIT

if [[ "$rehearsal" != "1" ]]; then
  # Production path: keep stdout exactly as `changeset publish` produced it so
  # changesets/action can scrape the "New tag:" lines.
  pnpm run release
  exit 0
fi

tmp="$(mktemp -d)"
mkdir -p "$tmp/backup"
for file in "${mutable_files[@]}"; do
  if [[ -f "$file" ]]; then
    mkdir -p "$tmp/backup/$(dirname "$file")"
    cp "$file" "$tmp/backup/$file"
  fi
done

# No uplink for @routedock/*: the rehearsal must never ask npmjs.org about
# packages it publishes itself. Everything else can be proxied so the publish
# tooling has what it needs.
registry="http://127.0.0.1:4873/"
config="$tmp/verdaccio.yaml"
cat > "$config" <<YAML
storage: $tmp/storage
auth:
  htpasswd:
    file: $tmp/htpasswd
listen: 0.0.0.0:4873
log: { type: stdout, format: pretty, level: warn }
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
packages:
  '@routedock/*':
    access: \$all
    publish: \$all
    unpublish: \$all
  '**':
    access: \$all
    publish: \$all
    unpublish: \$all
    proxy: npmjs
YAML

npx --yes verdaccio@6 --config "$config" >"$tmp/verdaccio.log" 2>&1 &
verdaccio_pid=$!
ready=0
# npx may need to download Verdaccio the first time, which can exceed a minute.
for _ in $(seq 1 180); do
  if curl -fsS "${registry}-/ping" >/dev/null 2>&1; then
    ready=1
    break
  fi
  if ! kill -0 "$verdaccio_pid" 2>/dev/null; then
    cat "$tmp/verdaccio.log" >&2
    echo "::error::Verdaccio exited before the release rehearsal could start" >&2
    exit 1
  fi
  sleep 1
done
if [[ "$ready" != "1" ]]; then
  cat "$tmp/verdaccio.log" >&2
  echo "::error::Verdaccio did not become ready on $registry" >&2
  exit 1
fi

cat > "$tmp/npmrc" <<EOF
registry=$registry
//127.0.0.1:4873/:_authToken=rehearsal
EOF
export npm_config_registry="$registry"
export NPM_CONFIG_REGISTRY="$registry"
export NPM_CONFIG_USERCONFIG="$tmp/npmrc"
export NPM_CONFIG_PROVENANCE=false

changeset_file=".changeset/rehearsal-$$.md"
cat > "$changeset_file" <<'EOF'
---
'@routedock/mcp-server': patch
'@routedock/nulth-sdk': patch
'@routedock/routedock': patch
---

Release rehearsal: verify the publish stdout contract.
EOF

if ! pnpm changeset version; then
  echo "::error::The rehearsal changeset could not be versioned" >&2
  exit 1
fi

versions=()
for i in "${!publishable[@]}"; do
  version="$(node -p "JSON.parse(require('node:fs').readFileSync('${package_dirs[$i]}/package.json', 'utf8')).version")"
  versions+=("${publishable[$i]}@$version")
done

# Provenance requires GitHub OIDC, which a rehearsal must not request. Strip
# it in this workspace only; cleanup puts the original files back.
node - <<'NODE'
const fs = require('node:fs')
for (const dir of ['packages/mcp-server', 'packages/nulth-sdk', 'packages/sdk']) {
  const file = `${dir}/package.json`
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (pkg.publishConfig?.provenance === undefined) continue
  delete pkg.publishConfig.provenance
  if (Object.keys(pkg.publishConfig).length === 0) delete pkg.publishConfig
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
}
NODE

stdout_log="$tmp/publish.stdout"
# Only stdout is captured: that is the stream changesets/action scrapes.
if ! pnpm run release | tee "$stdout_log"; then
  echo "::error::The release rehearsal failed before it could verify tag output" >&2
  exit 1
fi

# The same regex changesets/action v1.9.0 uses, extracted into a unit-tested
# script. Without this, a v3 publish succeeds but drops every tag and Release.
node scripts/check-release-tags.mjs "$stdout_log" "${publishable[@]}"

for spec in "${versions[@]}"; do
  if ! npm view "$spec" version >/dev/null 2>&1; then
    echo "::error::$spec was not published to the rehearsal registry at $registry" >&2
    exit 1
  fi
done

echo "Release rehearsal passed: ${#versions[@]} packages published to $registry with matching 'New tag:' lines."
