# Previous-release upgrade fixture

`agent_vault_pre_timelock.wasm` is the unchanged 26,278-byte fixture added in
commit [`65afa9a00e615692d1e77854dd645c6e606c9b8a`](https://github.com/winsznx/routedock/commit/65afa9a00e615692d1e77854dd645c6e606c9b8a)
(2026-09-28, PR #337). Its SHA-256 is:

```text
ffdba153a4c928afaba21a0c9a8e82d1cd46b1807bc5984a3411443e01260c02
```

The original test recorded this build command, from the repository root at that
revision (Rust 1.94):

```bash
cargo build --manifest-path contracts/agent-vault/Cargo.toml \
  --target wasm32v1-none --release
```

The bytes were retained from Git, not rebuilt during this change. This is the
previous release with `initialize` and immediate `upgrade`; it has no atomic
`__constructor`, `propose_upgrade` or `execute_upgrade`. Never replace it when updating the current contract, and
never use it as the destination of an upgrade from current code.

Use `bash scripts/build-vault-wasm.sh` at the repository root for the **current**
Wasm. It stays in the ignored target directory; see [contract testing](../../README.md#test-build-and-deploy)
for the explicit Wasm-test command. CI builds and tests fresh bytes on every PR.
`wasm32v1-none` avoids the reference-types instructions emitted by
`wasm32-unknown-unknown` on Rust 1.94, which the SDK 22 host cannot upload.
