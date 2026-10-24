#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
packages=("packages/sdk" "packages/nulth-sdk" "packages/mcp-server")

for pkg_dir in "${packages[@]}"; do
  echo "Checking packed files for $pkg_dir..."
  npm pack --dry-run --json "$root/$pkg_dir" | node "$root/scripts/check-pack.mjs" "$root/$pkg_dir"
  echo "  $pkg_dir pack hygiene and entry points: OK"
done

node "$root/scripts/check-packed-nulth.mjs"

echo "All packages passed package hygiene and entry point checks."
