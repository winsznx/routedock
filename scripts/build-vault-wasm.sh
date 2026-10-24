#!/usr/bin/env bash
# Build the pinned release target locally and in CI. No committed current fixture.
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
target_dir="${CARGO_TARGET_DIR:-$repo_root/contracts/agent-vault/target}"
mkdir -p "$target_dir"
target_dir="$(cd "$target_dir" && pwd)"
cargo +1.94.1 build --locked --manifest-path contracts/agent-vault/Cargo.toml \
  --target wasm32v1-none --release --target-dir "$target_dir"
python3 scripts/check-vault-wasm.py "$target_dir/wasm32v1-none/release/agent_vault.wasm"
printf 'Run Wasm upgrade tests with:\nAGENT_VAULT_WASM=%q cargo +1.94.1 test --locked --manifest-path contracts/agent-vault/Cargo.toml --features testutils -- --include-ignored\n' \
  "$target_dir/wasm32v1-none/release/agent_vault.wasm"
