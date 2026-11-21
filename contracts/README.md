# contracts/

Smart contracts for RouteDock on Stellar.

## agent-vault/

The RouteDock agent vault is a Soroban smart contract account built on top of
[Crossmint/stellar-smart-account](https://github.com/Crossmint/stellar-smart-account) v1.0.0.

**Status:** Implemented and covered by native contract tests. The contract and its dependencies have not received a production security audit.

### Policies

1. **Daily USDC cap** — rejects any transfer that would exceed the configured daily spend limit.
2. **Endpoint allowlist and per-payee caps** — rejects recipients outside the allowlist and enforces each payee's daily sub-cap.
3. **Session key with expiry** — the agent signing key expires at a configured ledger sequence.
4. **Lifetime USDC cap** — optionally bounds total lifetime spend without resetting on day boundaries.
5. **Freeze and two-step admin transfer** — support emergency control while preventing a mistyped admin transfer from orphaning the vault.

All signed authorizations are default-deny: only SAC `transfer` contexts accepted by the policies above can pass `__check_auth`.

### Storage layout and migration

The instance entry contains only admin and agent keys, caps, expiry, freeze state,
pending governance changes and a storage-version marker. Each allowlisted payee
has a separate persistent `(Symbol("payee"), Address) -> i128` entry; the
monotonic lifetime counter is a persistent `Symbol("ltspend") -> i128` entry.
Payments read only the payees in their authorization contexts and write the
small lifetime counter plus the existing temporary daily counters. Their write
bytes do not grow with the total allowlist.

`allowlist_sub_cap(payee)` returns `Some(sub_cap)` for an allowed payee and
`None` for a removed or absent entry. It replaces the full-map `allowlist()`
view. Index `allowlist_updated` events for enumeration: constructor and
migration entries emit `Some(sub_cap)`, updates replace that value, and removals
emit `None`. There is no instance-resident address index or aggregate 64 KiB
allowlist entry limit; constructor batches and individual transactions still
have the network's resource limits.

After upgrading an existing vault, the preserved admin must call
`migrate_storage()` repeatedly until its returned remaining count is zero. Each
call copies at most 64 payees, extends their persistent TTLs, and retains the
remaining legacy map plus lifetime counter in the instance. The final batch
moves the nonzero lifetime counter exactly once, removes the two legacy keys,
and marks migration complete. Other policy state and daily counters are retained.
A 500-payee vault needs eight calls; each batch stays below the network's
200-written-entry, 400-footprint-entry and 16,384-byte event/return limits.
Payments and allowlist mutations return `StorageMigrationRequired` until all
batches complete. Further migration calls return `StorageAlreadyMigrated`.
New deployments use the new layout immediately. Complete batches promptly or
restore any persistent entries archived during a long pause.

Instance and persistent entries extend to 2,000,000 ledgers only when their TTL
falls below 1,500,000. Payments and authenticated settlement records refresh the
payees they touch; admin upserts refresh the written payee. Authenticated admin
calls also refresh the lifetime counter so a frozen vault does not lose its
spend history. Inactive payee entries can archive independently and need a
ledger-entry restoration before reuse. Missing lifetime state fails closed with
`StorageUnavailable` rather than resetting to zero; restore an archived counter
before resuming payments. Read-only views do not refresh TTLs.

### Timelocked Wasm upgrades

Wasm replacement is a two-step process with a fixed **17,280-ledger notice period** (approximately one day at the vault's existing ledger-day accounting rate):

- `propose_upgrade(new_wasm_hash)` — admin only; stores the target and earliest executable ledger, extends the instance TTL through the notice period, and emits `upgrade_proposed`.
- `pending_upgrade()` — returns `Some((new_wasm_hash, ready_at_ledger))` until the proposal is executed or cancelled.
- `upgrade_timelock_ledgers()` — returns the fixed delay so clients do not need to hard-code it.
- `execute_upgrade()` — admin only; succeeds at or after `ready_at_ledger`, updates the executable, clears the proposal, and emits `upgraded`.
- `cancel_upgrade()` — admin only; clears a proposal even after it becomes executable and emits `upgrade_cancelled`.

A replacement proposal replaces the current target and restarts the full delay. The ledger calculation fails closed on overflow instead of saturating into immediate readiness. The target Wasm must already be uploaded on-chain when execution is attempted; a missing target rolls the transaction back and leaves the proposal pending.

The old immediate `upgrade(new_wasm_hash)` entry point has been removed. A contract already running the old Wasm needs one unavoidable bootstrap call through that old interface before it can expose this timelock; new deployments are protected from genesis.

This mechanism gives users notice before the enforcement code changes. It does **not** make the single-admin model trustless: the admin can still rotate agent keys and change caps, allowlists, expiry, and freeze state. Every target Wasm hash must be reviewed, and operators should monitor upgrade events.

### Prerequisites

- Rust 1.94.1 for the repository's locked Soroban dependency graph
- `wasm32v1-none` target for release builds
- Bash and Python 3 for the pinned Wasm build and checksum script
- Stellar CLI (`stellar`)
- Soroban SDK 22

### Test, build, and deploy

Run the native test suite from the repository root:

```bash
cargo +1.94.1 test --manifest-path contracts/agent-vault/Cargo.toml
cargo +1.94.1 test --manifest-path contracts/agent-vault/Cargo.toml --features testutils
```

**Snapshot rule:** `cargo test` writes `contracts/agent-vault/test_snapshots/tests/*.json`, which are
committed to the repo and checked in CI. The test key generator is seeded deterministically, so a
re-run produces byte-identical snapshots. CI deletes `contracts/agent-vault/test_snapshots` before
the first test run, so a committed snapshot that no test regenerates fails the check as a deletion.
If CI fails with “test_snapshots drifted”:

1. Re-run `cargo +1.94.1 test --manifest-path contracts/agent-vault/Cargo.toml`.
2. Commit the changed, added, or deleted snapshot files together with your contract change.

Never hand-edit a snapshot.

The four real Wasm upgrade tests are explicitly marked `ignored` in a native-only
run, with a message explaining the required build. To run **all** tests, including
the old immediate-upgrade bootstrap, pre-layout storage migration and
current-to-current state-retention paths:

```bash
rustup target add wasm32v1-none --toolchain 1.94.1
bash scripts/build-vault-legacy-wasm.sh
bash scripts/build-vault-wasm.sh
AGENT_VAULT_LEGACY_WASM="$PWD/contracts/agent-vault/target/legacy/wasm32v1-none/release/agent_vault.wasm" \
AGENT_VAULT_WASM="$PWD/contracts/agent-vault/target/wasm32v1-none/release/agent_vault.wasm" \
  cargo +1.94.1 test --locked --manifest-path contracts/agent-vault/Cargo.toml \
  --features testutils -- --include-ignored
```

Both Wasm paths are read at test runtime. An absent/unreadable path or the old
fixture fails the explicitly requested Wasm tests; it never silently substitutes
a stale fixture. Rebuild after changing contract source. The build script honors
`CARGO_TARGET_DIR` (relative to the repository root) and prints the matching test
command. The legacy build extracts upstream revision
`37329733a43b98754967e255dbc0a4d250312e50` into a temporary directory and uses a
separate target directory, so the migration test starts from the actual
pre-layout executable. That revision must be present locally; CI fetches its
history. Do not commit generated Wasm.

The `contract-wasm` CI job first builds that pinned legacy executable, then builds
the current release target with Rust 1.94.1 and the locked dependencies, enforces a **65,536-byte** budget (below Soroban's 128 KiB
contract-code ceiling), prints the byte size and SHA-256 in its job summary, runs
all tests against those bytes, and uploads `agent-vault-wasm-<commit>` for 90 days.
The artifact contains the Wasm, a `.wasm.sha256` checksum file and `.wasm.json`
metadata (commit, dirty-worktree flag, compiler, target, profile, size and hash).
For pull requests the commit is GitHub's tested merge commit; a push to `main`
produces the deployment artifact for that exact main commit. See the
[upgrade runbook](../docs/MAINNET_DEPLOYMENT.md#timelocked-wasm-upgrade-runbook)
for verification before proposing an upgrade.

Build and deploy the contract:

```bash
cd contracts/agent-vault
stellar contract build
stellar contract deploy \
  --wasm target/wasm32v1-none/release/agent_vault.wasm \
  --source $DEPLOYER_KEY \
  --network testnet \
  -- \
  --admin <ADMIN_G_ADDRESS> \
  --agent_pk <AGENT_ED25519_PUBKEY_64_HEX> \
  --daily_cap 250000000 \
  --allowlist '{"<PAYEE_G_ADDRESS>":"250000000"}' \
  --expiry_ledger <ABSOLUTE_LEDGER_SEQUENCE> \
  --lifetime_cap 0
```

#### Constructor Arguments & Units

Deploying the vault passes configuration arguments atomically to `__constructor`:

- `--admin`: Stellar G-address of the vault admin (can adjust caps, rotate keys, transfer admin, freeze/unfreeze, upgrade).
- `--agent_pk`: 32-byte Ed25519 public key of the agent as 64 hex characters.
- `--daily_cap`: Daily USDC spend limit in stroops (1 USDC = 10,000,000 stroops; `250000000` = 25 USDC).
- `--allowlist`: JSON map of payee address to daily sub-cap in stroops (e.g. `'{"<PAYEE_G_ADDRESS>":"250000000"}'`).
- `--expiry_ledger`: Absolute ledger sequence at which session expires (compared against `env.ledger().sequence()`; not a duration).
- `--lifetime_cap`: Lifetime USDC spend limit in stroops (`0` = unlimited).

> **⚠️ SECURITY WARNING:** The contract and the underlying
> `stellar-experimental/one-way-channel` contract are **unaudited**. RouteDock uses
> conservative defaults and durable server-side enforcement, but production use
> should await formal audits and a reviewed upgrade procedure.
>
> **Audit status:**
> - Shortlisted auditors: [OtterSec](https://ottersec.com/), [Hacken](https://hacken.io/), [Trail of Bits](https://trailofbits.com/)
> - SCF Audit Bank application: submitted
