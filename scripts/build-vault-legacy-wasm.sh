#!/usr/bin/env bash
# Build the actual pre-storage-layout vault for executable migration regressions.
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# This is the upstream revision before the #733 storage change, not a mock.
legacy_revision=37329733a43b98754967e255dbc0a4d250312e50
legacy_source="$(mktemp -d "${TMPDIR:-/tmp}/agent-vault-legacy.XXXXXX")"
trap 'rm -rf -- "$legacy_source"' EXIT
git archive "$legacy_revision" contracts/agent-vault | tar -x -C "$legacy_source"

# A separate output directory prevents the legacy build overwriting current Wasm.
target_dir="${CARGO_TARGET_DIR:-$repo_root/contracts/agent-vault/target}/legacy"
mkdir -p "$target_dir"
target_dir="$(cd "$target_dir" && pwd)"
cargo +1.94.1 build --locked \
  --manifest-path "$legacy_source/contracts/agent-vault/Cargo.toml" \
  --target wasm32v1-none --release --target-dir "$target_dir"
printf 'AGENT_VAULT_LEGACY_WASM=%q\n' \
  "$target_dir/wasm32v1-none/release/agent_vault.wasm"
