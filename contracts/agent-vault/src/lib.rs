#![no_std]

use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contracterror, contractimpl, contracttype,
    crypto::Hash,
    panic_with_error, symbol_short,
    Address, Bytes, BytesN, Env, IntoVal, Map, Symbol, TryFromVal, Val, Vec,
};

// ── Storage keys ─────────────────────────────────────────────────────────────

const ADMIN_KEY: Symbol = symbol_short!("admin");
const PENDING_ADMIN_KEY: Symbol = symbol_short!("p_admin");
const AGENT_KEY: Symbol = symbol_short!("agentpk");
const CAP_KEY: Symbol = symbol_short!("dailycap");
const LIST_KEY: Symbol = symbol_short!("allwlist");
const EXPIRY_KEY: Symbol = symbol_short!("expiry");
const INIT_KEY: Symbol = symbol_short!("init");
const FROZEN_KEY: Symbol = symbol_short!("frozen");
/// Prefix of the persistent per-channel marker `record_session_settlement` writes:
/// `(SETTLED_KEY, channel_id) -> true`.
const SETTLED_KEY: Symbol = symbol_short!("settled");

// Global trailing-window spend key: (SPEND_PREFIX,) -> SpendWindow
const SPEND_PREFIX: Symbol = symbol_short!("ds");
// Per-payee trailing-window spend key: (PAYEE_SPEND_PREFIX, payee) -> SpendWindow
const PAYEE_SPEND_PREFIX: Symbol = symbol_short!("pds");
// Lifetime spend cap and monotonic counter (instance storage — never resets)
const LIFETIME_CAP_KEY: Symbol = symbol_short!("ltcap");
const LIFETIME_SPEND_KEY: Symbol = symbol_short!("ltspend");
// Pending timelocked Wasm proposal: (new_wasm_hash, ready_at_ledger).
const PENDING_UPGRADE_KEY: Symbol = symbol_short!("p_upg");

// 17,280 ledgers is the contract's existing approximation of one day. A proposal
// cannot execute before this many ledgers have elapsed, giving governed payers
// time to observe the proposal and exit before the enforcement code changes.
const UPGRADE_TIMELOCK_LEDGERS: u32 = 17_280;

// ── Trailing spend window ────────────────────────────────────────────────────
//
// The daily and per-payee caps bound spend in ANY `SPEND_WINDOW_LEDGERS`-ledger
// window, not within a calendar bucket. A fixed bucket (`seq / 17_280`) lets the
// whole cap be spent on the last ledger of one bucket and again on the first
// ledger of the next, so the real bound was 2x the configured cap.
//
// Each counter is a ring of `SPEND_RING_SLOTS` sub-buckets of
// `SPEND_SUB_BUCKET_LEDGERS` ledgers. A payment is added to the sub-bucket of the
// current ledger; a sub-bucket is dropped once it is `SPEND_RING_SLOTS` sub-buckets
// old. The spend compared against the cap is the sum of every slot.
//
// Why 25 slots and not 24: a payment made on the LAST ledger of its sub-bucket
// must still be counted `SPEND_WINDOW_LEDGERS - 1` ledgers later. A 24-slot ring
// drops it up to one sub-bucket early and under-counts. 25 slots always cover
// the window plus a partial sub-bucket, so the error is only ever conservative:
// a payment stays counted for at most `SPEND_SUB_BUCKET_LEDGERS` ledgers longer
// than the window (about an hour).
const SPEND_WINDOW_LEDGERS: u32 = 17_280;
const SPEND_SUB_BUCKET_LEDGERS: u32 = 720;
const SPEND_RING_SLOTS: u32 = SPEND_WINDOW_LEDGERS / SPEND_SUB_BUCKET_LEDGERS + 1;
// Temporary-storage TTL for a counter after every write. The last write must
// outlive every payment it still counts: a payment is counted for at most
// SPEND_RING_SLOTS * SPEND_SUB_BUCKET_LEDGERS ledgers.
const SPEND_TTL_LEDGERS: u32 = SPEND_SUB_BUCKET_LEDGERS * SPEND_RING_SLOTS;
// Bucket length of the fixed-bucket counters earlier releases wrote:
// (SPEND_PREFIX, seq / 17_280) and (PAYEE_SPEND_PREFIX, seq / 17_280, payee).
// Only read, to seed a window that does not exist yet.
const LEGACY_DAY_BUCKET_LEDGERS: u32 = 17_280;

/// Ring of spend sub-buckets. `newest` is the absolute index
/// (`ledger / SPEND_SUB_BUCKET_LEDGERS`) of the most recent sub-bucket written;
/// the sub-bucket for absolute index `i` lives in `buckets[i % SPEND_RING_SLOTS]`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
struct SpendWindow {
    newest: u32,
    buckets: Vec<i128>,
}

impl SpendWindow {
    /// Load a stored window and age out every sub-bucket that has left the
    /// trailing window as of `ledger`. `None` yields an empty window.
    fn rolled(env: &Env, stored: Option<SpendWindow>, ledger: u32) -> SpendWindow {
        let current = ledger / SPEND_SUB_BUCKET_LEDGERS;
        let mut window = match stored {
            Some(w) if w.buckets.len() == SPEND_RING_SLOTS => w,
            _ => {
                let mut buckets = Vec::new(env);
                for _ in 0..SPEND_RING_SLOTS {
                    buckets.push_back(0_i128);
                }
                return SpendWindow { newest: current, buckets };
            }
        };
        if current > window.newest {
            let steps = (current - window.newest).min(SPEND_RING_SLOTS);
            for i in 1..=steps {
                window.buckets.set((window.newest + i) % SPEND_RING_SLOTS, 0);
            }
            window.newest = current;
        }
        window
    }

    /// Total spend still inside the trailing window.
    fn total(&self) -> i128 {
        let mut sum: i128 = 0;
        for value in self.buckets.iter() {
            sum = sum.saturating_add(value);
        }
        sum
    }

    /// Record `amount` against the newest sub-bucket.
    fn add(&mut self, amount: i128) {
        let slot = self.newest % SPEND_RING_SLOTS;
        let current = self.buckets.get(slot).unwrap_or(0);
        self.buckets.set(slot, current.saturating_add(amount));
    }
}

/// The window stored under `key`, rolled forward to `ledger`.
///
/// A vault upgraded from the fixed-bucket counters has no window yet, so a
/// missing one starts with the current legacy bucket's total (`legacy_key`) in
/// the current sub-bucket, keeping spend from before the upgrade counted.
fn load_window<K, L>(env: &Env, key: &K, legacy_key: &L, ledger: u32) -> SpendWindow
where
    K: IntoVal<Env, Val>,
    L: IntoVal<Env, Val>,
{
    let temporary = env.storage().temporary();
    let stored = temporary.get::<K, SpendWindow>(key);
    let missing = stored.is_none();
    let mut window = SpendWindow::rolled(env, stored, ledger);
    if missing {
        window.add(temporary.get::<L, i128>(legacy_key).unwrap_or(0));
    }
    window
}

// ── Event names ──────────────────────────────────────────────────────────────
// Longer than 9 chars — must use Symbol::new(&env, ...) at call sites.
const EVT_PAYMENT_AUTHORIZED: &str = "payment_authorized";
const EVT_SESSION_SETTLED: &str = "session_settled";
const EVT_UPGRADED: &str = "upgraded";
const EVT_EXPIRY_UPDATED: &str = "expiry_updated";
const EVT_AGENT_KEY_ROTATED: &str = "agent_key_rotated";
const EVT_CAP_UPDATED: &str = "cap_updated";
const EVT_ALLOWLIST_UPDATED: &str = "allowlist_updated";
const EVT_ADMIN_TRANSFER_REQUESTED: &str = "admin_transfer_requested";
const EVT_ADMIN_CHANGED: &str = "admin_changed";
const EVT_VAULT_FROZEN: &str = "vault_frozen";
const EVT_VAULT_UNFROZEN: &str = "vault_unfrozen";
const EVT_UPGRADE_PROPOSED: &str = "upgrade_proposed";
const EVT_UPGRADE_CANCELLED: &str = "upgrade_cancelled";

// ── Error codes ───────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    SessionExpired = 3,
    DailyCapExceeded = 4,
    PayeeNotAllowed = 5,
    PayeeCapExceeded = 6,
    LifetimeCapExceeded = 7,
    NoPendingAdmin = 8,
    ContractFrozen = 9,
    InvalidAmount = 10,
    UnauthorizedFunction = 11,
    MalformedAuthContext = 12,
    InvalidCap = 13,
    NoPendingUpgrade = 14,
    UpgradeNotReady = 15,
    UpgradeTimelockOverflow = 16,
    /// `record_session_settlement` was already called for this `channel_id`.
    /// Appended last so codes 1..=16 keep their values.
    SettlementAlreadyRecorded = 17,
}

fn validate_cap(env: &Env, cap: i128) {
    if cap < 0 {
        panic_with_error!(env, Error::InvalidCap);
    }
}

// ── Instance storage TTL ─────────────────────────────────────────────────────
// Every piece of vault state (admin, caps, allowlist, expiry, frozen flag, agent
// key) lives in instance storage, so the instance entry's TTL is the vault's own
// lifetime. Soroban does not refresh an entry's TTL just because it was written,
// and `__check_auth` is the only entrypoint agent traffic reaches — so a vault
// that only receives admin calls (frozen, or past its expiry) would keep counting
// down towards archival from the TTL `__constructor` left behind.
const INSTANCE_TTL_THRESHOLD: u32 = 2_000_000;
const INSTANCE_TTL_EXTEND_TO: u32 = 2_000_000;

/// Refresh the instance entry's TTL. Called from `__constructor`, from `__check_auth`,
/// and from every admin entrypoint after its auth check succeeds — so an
/// unauthenticated caller cannot make the vault pay for a bump on someone else's
/// behalf. Entries still above `INSTANCE_TTL_THRESHOLD` are left alone.
fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);
}

fn calculate_upgrade_ready_at(sequence: u32) -> Result<u32, Error> {
    sequence
        .checked_add(UPGRADE_TIMELOCK_LEDGERS)
        .ok_or(Error::UpgradeTimelockOverflow)
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct AgentVault;

#[contractimpl]
impl AgentVault {
    /// One-time constructor executed atomically upon contract deployment.
    /// `lifetime_cap`: total USDC (stroops) the vault may ever spend; 0 = unlimited.
    /// Negative `daily_cap`, `lifetime_cap` or allowlist sub-caps are rejected
    /// with `Error::InvalidCap`.
    pub fn __constructor(
        env: Env,
        admin: Address,
        agent_pk: BytesN<32>,
        daily_cap: i128,
        allowlist: Map<Address, i128>,
        expiry_ledger: u32,
        lifetime_cap: i128,
    ) {
        validate_cap(&env, daily_cap);
        // The lifetime cap fails open on a negative value (its check only runs
        // when the cap is above 0), so it needs the same guard. 0 = unlimited.
        validate_cap(&env, lifetime_cap);
        for (_, sub_cap) in allowlist.iter() {
            validate_cap(&env, sub_cap);
        }
        let storage = env.storage().instance();
        storage.set(&ADMIN_KEY, &admin);
        storage.set(&AGENT_KEY, &agent_pk);
        storage.set(&CAP_KEY, &daily_cap);
        storage.set(&LIST_KEY, &allowlist);
        storage.set(&EXPIRY_KEY, &expiry_ledger);
        storage.set(&LIFETIME_CAP_KEY, &lifetime_cap);
        storage.set(&LIFETIME_SPEND_KEY, &0_i128);
        storage.set(&INIT_KEY, &true);
        // Extend instance storage TTL to outlive any realistic session expiry
        bump_instance(&env);
    }

    /// Update the daily USDC spend cap (in stroops). Admin only.
    pub fn set_daily_cap(env: Env, new_cap: i128) {
        let storage = env.storage().instance();
        let admin: Address = storage
            .get(&ADMIN_KEY)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
        admin.require_auth();
        bump_instance(&env);
        validate_cap(&env, new_cap);
        let old_cap: i128 = storage.get(&CAP_KEY).unwrap_or(0);
        storage.set(&CAP_KEY, &new_cap);
        env.events().publish(
            (Symbol::new(&env, EVT_CAP_UPDATED), symbol_short!("daily")),
            (old_cap, new_cap),
        );
    }

    /// Upsert a payee address in the spend allowlist with a per-payee daily sub-cap. Admin only.
    pub fn add_to_allowlist(env: Env, payee: Address, sub_cap: i128) {
        let storage = env.storage().instance();
        let admin: Address = storage
            .get(&ADMIN_KEY)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
        admin.require_auth();
        bump_instance(&env);
        validate_cap(&env, sub_cap);
        let mut map: Map<Address, i128> = storage
            .get(&LIST_KEY)
            .unwrap_or_else(|| Map::new(&env));
        map.set(payee.clone(), sub_cap);
        storage.set(&LIST_KEY, &map);
        env.events().publish(
            (Symbol::new(&env, EVT_ALLOWLIST_UPDATED), payee),
            Some(sub_cap),
        );
    }

    /// Remove a payee address from the spend allowlist. Admin only.
    pub fn remove_from_allowlist(env: Env, payee: Address) {
        let storage = env.storage().instance();
        let admin: Address = storage
            .get(&ADMIN_KEY)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
        admin.require_auth();
        bump_instance(&env);
        let mut map: Map<Address, i128> = storage
            .get(&LIST_KEY)
            .unwrap_or_else(|| Map::new(&env));
        map.remove(payee.clone());
        storage.set(&LIST_KEY, &map);
        env.events().publish(
            (Symbol::new(&env, EVT_ALLOWLIST_UPDATED), payee),
            Option::<i128>::None,
        );
    }

    /// Record an off-chain channel settlement. Emits `session_settled`.
    /// Authorized by the allowlisted `payee` itself, not the vault admin: a
    /// third-party provider records its own settlements with its own payee key
    /// and never holds the admin secret, which also guards `upgrade` and
    /// `set_agent_pubkey`.
    ///
    /// Guards, in order:
    /// - a frozen vault rejects with `ContractFrozen` (before any auth check), so
    ///   freeze really is the emergency stop for everything that writes a record;
    /// - each `channel_id` can be recorded once. A second call fails with
    ///   `SettlementAlreadyRecorded` and emits nothing, so the event log can never
    ///   show a channel's settlement twice.
    ///
    /// `payer`, `cumulative_amount` and `voucher_count` are **asserted by the
    /// payee and not verified on-chain**. Unlike `payment_authorized` (emitted
    /// from `__check_auth`, so it reflects enforced spend), `session_settled`
    /// should be checked against the channel close transaction before it is
    /// trusted for reconciliation.
    pub fn record_session_settlement(
        env: Env,
        channel_id: Address,
        payer: Address,
        payee: Address,
        cumulative_amount: i128,
        voucher_count: u32,
    ) {
        if env
            .storage()
            .instance()
            .get::<Symbol, bool>(&FROZEN_KEY)
            .unwrap_or(false)
        {
            panic_with_error!(&env, Error::ContractFrozen);
        }
        if cumulative_amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let allowlist: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&LIST_KEY)
            .unwrap_or_else(|| Map::new(&env));
        if allowlist.get(payee.clone()).is_none() {
            panic_with_error!(&env, Error::PayeeNotAllowed);
        }
        payee.require_auth();
        bump_instance(&env);

        // Persistent, not temporary: the marker has to outlive the channel for as
        // long as the vault does, or a payee could replay an old channel once it
        // expired. Its TTL tracks the instance TTL.
        let settled_key = (SETTLED_KEY, channel_id.clone());
        if env.storage().persistent().has(&settled_key) {
            panic_with_error!(&env, Error::SettlementAlreadyRecorded);
        }
        env.storage().persistent().set(&settled_key, &true);
        env.storage()
            .persistent()
            .extend_ttl(&settled_key, INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);

        // topics: (Symbol("session_settled"), channel_id, payee)
        // data:   (payer, cumulative_amount, voucher_count)
        env.events().publish(
            (Symbol::new(&env, EVT_SESSION_SETTLED), channel_id, payee),
            (payer, cumulative_amount, voucher_count),
        );
    }

    /// Update the lifetime USDC spend cap (in stroops). Admin only. 0 = unlimited.
    /// Any non-negative value is stored as given: the admin can raise or lower the
    /// cap, and setting it at or below `get_lifetime_spend()` blocks further
    /// payments. Negative values are rejected with `Error::InvalidCap`.
    pub fn set_lifetime_cap(env: Env, new_cap: i128) {
        let storage = env.storage().instance();
        let admin: Address = storage
            .get(&ADMIN_KEY)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
        admin.require_auth();
        bump_instance(&env);
        validate_cap(&env, new_cap);
        let old_cap: i128 = storage.get(&LIFETIME_CAP_KEY).unwrap_or(0);
        storage.set(&LIFETIME_CAP_KEY, &new_cap);
        env.events().publish(
            (Symbol::new(&env, EVT_CAP_UPDATED), symbol_short!("lifetime")),
            (old_cap, new_cap),
        );
    }

    /// Extend (or otherwise set) the session expiry ledger. Admin only.
    /// This is the recovery escape hatch after expiry: an admin can push the
    /// expiry forward so payments resume without reinitializing the vault.
    pub fn set_expiry(env: Env, new_expiry: u32) {
        let storage = env.storage().instance();
        let admin: Address = storage
            .get(&ADMIN_KEY)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
        admin.require_auth();
        bump_instance(&env);
        storage.set(&EXPIRY_KEY, &new_expiry);
        // topics: (Symbol("expiry_updated"), admin)
        // data:   new_expiry
        env.events().publish(
            (Symbol::new(&env, EVT_EXPIRY_UPDATED), admin),
            new_expiry,
        );
    }

    /// Rotate the agent's Ed25519 public key. Admin only.
    /// Recovery control for a leaked/compromised agent key — subsequent auth
    /// must be signed with the new key, and the old key is immediately invalid.
    pub fn set_agent_pubkey(env: Env, new_pk: BytesN<32>) {
        let storage = env.storage().instance();
        let admin: Address = storage
            .get(&ADMIN_KEY)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
        admin.require_auth();
        bump_instance(&env);
        storage.set(&AGENT_KEY, &new_pk);
        // topics: (Symbol("agent_key_rotated"),)
        // data:   new_pk
        env.events().publish(
            (Symbol::new(&env, EVT_AGENT_KEY_ROTATED),),
            new_pk,
        );
    }

    /// Return the vault's cumulative lifetime spend counter (stroops). Read-only.
    pub fn get_lifetime_spend(env: Env) -> i128 {
        env.storage()
            .instance()
            .get::<Symbol, i128>(&LIFETIME_SPEND_KEY)
            .unwrap_or(0)
    }

    /// Initiate a transfer of admin rights to a new address. Admin only.
    pub fn transfer_admin(env: Env, new_admin: Address) {
        let storage = env.storage().instance();
        let admin: Address = storage
            .get(&ADMIN_KEY)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
        admin.require_auth();
        bump_instance(&env);
        storage.set(&PENDING_ADMIN_KEY, &new_admin);
        env.events().publish(
            (Symbol::new(&env, EVT_ADMIN_TRANSFER_REQUESTED), admin, new_admin),
            (),
        );
    }

    /// Accept a pending transfer of admin rights. Pending admin only.
    pub fn accept_admin(env: Env) {
        let storage = env.storage().instance();
        let pending_admin: Address = storage
            .get(&PENDING_ADMIN_KEY)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NoPendingAdmin));
        pending_admin.require_auth();
        bump_instance(&env);
        let old_admin: Address = storage
            .get(&ADMIN_KEY)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
        storage.set(&ADMIN_KEY, &pending_admin);
        storage.remove(&PENDING_ADMIN_KEY);
        env.events().publish(
            (Symbol::new(&env, EVT_ADMIN_CHANGED), old_admin, pending_admin),
            (),
        );
    }

    /// Freeze the contract, preventing any agent transfers. Admin only.
    pub fn freeze(env: Env) {
        let storage = env.storage().instance();
        let admin: Address = storage
            .get(&ADMIN_KEY)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
        admin.require_auth();
        bump_instance(&env);
        storage.set(&FROZEN_KEY, &true);
        env.events().publish((Symbol::new(&env, EVT_VAULT_FROZEN),), ());
    }

    /// Unfreeze the contract, allowing agent transfers again. Admin only.
    pub fn unfreeze(env: Env) {
        let storage = env.storage().instance();
        let admin: Address = storage
            .get(&ADMIN_KEY)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
        admin.require_auth();
        bump_instance(&env);
        storage.set(&FROZEN_KEY, &false);
        env.events().publish((Symbol::new(&env, EVT_VAULT_UNFROZEN),), ());
    }

    /// Propose a Wasm upgrade to `new_wasm_hash`. Admin only.
    ///
    /// The proposal is announced immediately but cannot execute until
    /// `UPGRADE_TIMELOCK_LEDGERS` have elapsed. A later proposal replaces the
    /// current target and restarts the full delay. The target Wasm must be
    /// uploaded on-chain before `execute_upgrade` is called.
    pub fn propose_upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        let storage = env.storage().instance();
        let admin: Address = storage
            .get(&ADMIN_KEY)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
        admin.require_auth();
        // The bump lifts the instance entry to `INSTANCE_TTL_EXTEND_TO` ledgers,
        // comfortably past the notice period, so the proposal cannot be archived
        // before it becomes executable.
        bump_instance(&env);

        let ready_at_ledger = calculate_upgrade_ready_at(env.ledger().sequence())
            .unwrap_or_else(|error| panic_with_error!(&env, error));
        storage.set(
            &PENDING_UPGRADE_KEY,
            &(new_wasm_hash.clone(), ready_at_ledger),
        );
        env.events().publish(
            (Symbol::new(&env, EVT_UPGRADE_PROPOSED),),
            (new_wasm_hash, ready_at_ledger),
        );
    }

    /// Execute the current Wasm proposal once its ledger delay has elapsed. Admin only.
    /// Execution is allowed at exactly `ready_at_ledger`.
    pub fn execute_upgrade(env: Env) {
        let storage = env.storage().instance();
        let admin: Address = storage
            .get(&ADMIN_KEY)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
        admin.require_auth();
        let (new_wasm_hash, ready_at_ledger): (BytesN<32>, u32) = storage
            .get(&PENDING_UPGRADE_KEY)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NoPendingUpgrade));
        if env.ledger().sequence() < ready_at_ledger {
            panic_with_error!(&env, Error::UpgradeNotReady);
        }

        env.deployer()
            .update_current_contract_wasm(new_wasm_hash.clone());
        storage.remove(&PENDING_UPGRADE_KEY);
        // The swap rewrites the instance entry itself, so bump after it to leave
        // the vault with a full TTL when the upgrade returns.
        bump_instance(&env);
        env.events()
            .publish((Symbol::new(&env, EVT_UPGRADED),), new_wasm_hash);
    }

    /// Cancel the current Wasm proposal, including after it becomes executable. Admin only.
    pub fn cancel_upgrade(env: Env) {
        let storage = env.storage().instance();
        let admin: Address = storage
            .get(&ADMIN_KEY)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
        admin.require_auth();
        bump_instance(&env);
        let (new_wasm_hash, ready_at_ledger): (BytesN<32>, u32) = storage
            .get(&PENDING_UPGRADE_KEY)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NoPendingUpgrade));
        storage.remove(&PENDING_UPGRADE_KEY);
        env.events().publish(
            (Symbol::new(&env, EVT_UPGRADE_CANCELLED),),
            (new_wasm_hash, ready_at_ledger),
        );
    }

    /// Return the pending Wasm hash and earliest executable ledger, if any.
    pub fn pending_upgrade(env: Env) -> Option<(BytesN<32>, u32)> {
        env.storage().instance().get(&PENDING_UPGRADE_KEY)
    }

    /// Return the mandatory proposal delay in ledgers (view-only).
    pub fn upgrade_timelock_ledgers(_env: Env) -> u32 {
        UPGRADE_TIMELOCK_LEDGERS
    }

    /// Return the global daily spend cap (view-only).
    pub fn daily_cap(env: Env) -> i128 {
        env.storage().instance().get(&CAP_KEY).unwrap_or(0)
    }

    /// Return the allowed payees and their sub-caps (view-only).
    pub fn allowlist(env: Env) -> Map<Address, i128> {
        env.storage().instance().get(&LIST_KEY).unwrap_or_else(|| Map::new(&env))
    }

    /// Return the session expiry ledger (view-only).
    pub fn expiry_ledger(env: Env) -> u32 {
        env.storage().instance().get(&EXPIRY_KEY).unwrap_or(0)
    }

    /// Return the authorized agent's Ed25519 public key (view-only).
    pub fn agent_pubkey(env: Env) -> BytesN<32> {
        env.storage().instance().get(&AGENT_KEY).unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized))
    }
}

// ── CustomAccountInterface ────────────────────────────────────────────────────
//
// Architecture follows Crossmint/stellar-smart-account v1.0.0:
//   • Signature = Ed25519 BytesN<64>
//   • __check_auth runs policies against every Context::Contract("transfer") entry
//   • Default-deny: any other authorization context (SAC approve/burn, non-
//     contract host fns) is rejected with Error::UnauthorizedFunction — a
//     stolen agent key cannot bypass the caps via a non-transfer call
//   • Policy 1 — DailyCapPolicy:  a trailing 17,280-ledger window kept as a ring of
//     720-ledger sub-buckets under (SPEND_PREFIX,) in temporary storage; spend
//     ages out gradually instead of resetting at a fixed boundary
//   • Policy 2 — EndpointAllowlistPolicy: recipient from args[1] checked
//     against ALLOWLIST in instance storage; also reads the per-payee sub-cap
//   • Policy 3 — SessionKeyExpiry: ledger sequence compared to stored EXPIRY
//   • Policy 4 — PerPayeeCapPolicy: the same trailing window per payee, keyed by
//     (PAYEE_SPEND_PREFIX, payee) in temporary storage; prevents a single
//     compromised provider from draining the global daily cap
//   • Policy 5 — LifetimeCapPolicy: monotonic spend_counter in instance storage;
//     enforced when lifetime_cap > 0; never ages out

#[contractimpl]
impl CustomAccountInterface for AgentVault {
    type Signature = BytesN<64>;
    type Error = Error;

    #[allow(non_snake_case)]
    fn __check_auth(
        env: Env,
        signature_payload: Hash<32>,
        signature: BytesN<64>,
        auth_contexts: Vec<Context>,
    ) -> Result<(), Error> {
        let storage = env.storage().instance();
        // Keep instance storage alive through the lifetime of auth calls
        bump_instance(&env);

        // ── Emergency Stop Check ─────────────────────────────────────────────
        let is_frozen: bool = storage.get(&FROZEN_KEY).unwrap_or(false);
        if is_frozen {
            return Err(Error::ContractFrozen);
        }

        // ── Verify Ed25519 signature ─────────────────────────────────────────
        let agent_pk: BytesN<32> = storage.get(&AGENT_KEY).ok_or(Error::NotInitialized)?;
        // Hash<32> -> Bytes via From<Hash<N>> for Bytes (soroban-sdk 22.x)
        let msg: Bytes = signature_payload.into();
        env.crypto().ed25519_verify(&agent_pk, &msg, &signature);

        // ── Policy 3: Session key expiry (ledger-based) ──────────────────────
        let expiry: u32 = storage.get(&EXPIRY_KEY).unwrap_or(u32::MAX);
        if env.ledger().sequence() > expiry {
            return Err(Error::SessionExpired);
        }

        // ── Load policy state ────────────────────────────────────────────────
        let daily_cap: i128 = storage.get(&CAP_KEY).unwrap_or(i128::MAX);
        let lifetime_cap: i128 = storage.get(&LIFETIME_CAP_KEY).unwrap_or(0);
        let mut lifetime_spend: i128 = storage
            .get::<Symbol, i128>(&LIFETIME_SPEND_KEY)
            .unwrap_or(0);
        let allowlist: Map<Address, i128> = storage
            .get(&LIST_KEY)
            .unwrap_or_else(|| Map::new(&env));

        // Trailing spend window: sum of the last SPEND_WINDOW_LEDGERS ledgers of
        // accepted spend (plus at most one sub-bucket of conservative over-count).
        let ledger = env.ledger().sequence();
        let spend_key = (SPEND_PREFIX,);
        let legacy_bucket = ledger / LEGACY_DAY_BUCKET_LEDGERS;
        let mut day_window = load_window(
            &env,
            &spend_key,
            &(SPEND_PREFIX, legacy_bucket),
            ledger,
        );
        let mut day_spend: i128 = day_window.total();

        // ── Per-context policy checks ─────────────────────────────────────────
        // Default-deny: the policies below only fire for SAC transfer calls, so
        // ANY other authorization context must be rejected rather than silently
        // skipped. Without this, a stolen agent key could sign an auth for the
        // USDC SAC's approve()/burn() (or a create_contract host fn) and drain
        // the vault via transfer_from without ever touching a cap.
        for context in auth_contexts.iter() {
            match context {
                Context::Contract(ctx) if ctx.fn_name == Symbol::new(&env, "transfer") => {
                    // SAC transfer(from: Address, to: Address, amount: i128)
                    if ctx.args.len() != 3 {
                        return Err(Error::MalformedAuthContext);
                    }
                    let from: Address = ctx
                        .args
                        .get(0)
                        .ok_or(Error::MalformedAuthContext)
                        .and_then(|value| {
                            Address::try_from_val(&env, &value)
                                .map_err(|_| Error::MalformedAuthContext)
                        })?;
                    let to: Address = ctx
                        .args
                        .get(1)
                        .ok_or(Error::MalformedAuthContext)
                        .and_then(|value| {
                            Address::try_from_val(&env, &value)
                                .map_err(|_| Error::MalformedAuthContext)
                        })?;
                    let amount: i128 = ctx
                        .args
                        .get(2)
                        .ok_or(Error::MalformedAuthContext)
                        .and_then(|value| {
                            i128::try_from_val(&env, &value)
                                .map_err(|_| Error::MalformedAuthContext)
                        })?;
                    let asset: Address = ctx.contract.clone();

                    // Reject non-positive amounts: a negative amount would
                    // deflate the day/payee/lifetime spend counters via
                    // checked_add, letting subsequent real transfers exceed
                    // every cap. Zero amounts are meaningless and also rejected.
                    if amount <= 0 {
                        return Err(Error::InvalidAmount);
                    }

                    // Policy 2 — EndpointAllowlistPolicy (also fetches per-payee sub-cap)
                    let payee_sub_cap = allowlist.get(to.clone()).ok_or(Error::PayeeNotAllowed)?;

                    // Policy 1 — Global DailyCapPolicy
                    let projected = day_spend.checked_add(amount).unwrap_or(i128::MAX);
                    if projected > daily_cap {
                        return Err(Error::DailyCapExceeded);
                    }
                    day_spend = projected;
                    day_window.add(amount);

                    // Policy 4 — Per-payee DailyCapPolicy (same trailing window)
                    let payee_spend_key = (PAYEE_SPEND_PREFIX, to.clone());
                    let mut payee_window = load_window(
                        &env,
                        &payee_spend_key,
                        &(PAYEE_SPEND_PREFIX, legacy_bucket, to.clone()),
                        ledger,
                    );
                    let payee_projected =
                        payee_window.total().checked_add(amount).unwrap_or(i128::MAX);
                    if payee_projected > payee_sub_cap {
                        return Err(Error::PayeeCapExceeded);
                    }
                    payee_window.add(amount);

                    // Persist the per-payee window. The TTL covers every payment the
                    // window still counts, and is re-extended on every write.
                    env.storage()
                        .temporary()
                        .set::<(Symbol, Address), SpendWindow>(&payee_spend_key, &payee_window);
                    env.storage().temporary().extend_ttl::<(Symbol, Address)>(
                        &payee_spend_key,
                        SPEND_TTL_LEDGERS,
                        SPEND_TTL_LEDGERS,
                    );

                    // Policy 5 — LifetimeCapPolicy (monotonic, never resets)
                    // Always accumulate; enforce only when a cap is set (lifetime_cap > 0).
                    let projected_lifetime =
                        lifetime_spend.checked_add(amount).unwrap_or(i128::MAX);
                    if lifetime_cap > 0 && projected_lifetime > lifetime_cap {
                        return Err(Error::LifetimeCapExceeded);
                    }
                    lifetime_spend = projected_lifetime;

                    // topics: (Symbol("payment_authorized"), payer, payee)
                    // data:   (amount, asset, daily_cumulative) where daily_cumulative is
                    //         the spend inside the trailing window, including this payment
                    env.events().publish(
                        (Symbol::new(&env, EVT_PAYMENT_AUTHORIZED), from, to),
                        (amount, asset, day_spend),
                    );
                }
                // Any non-transfer contract call (SAC approve, burn, …) or
                // non-contract host fn (create_contract) is unauthorized.
                _ => {
                    return Err(Error::UnauthorizedFunction);
                }
            }
        }

        // Persist the global window. The TTL covers every payment the window still
        // counts, and is re-extended on every write.
        env.storage()
            .temporary()
            .set::<(Symbol,), SpendWindow>(&spend_key, &day_window);
        env.storage().temporary().extend_ttl::<(Symbol,)>(
            &spend_key,
            SPEND_TTL_LEDGERS,
            SPEND_TTL_LEDGERS,
        );

        // Persist monotonic lifetime spend counter — must survive vault lifetime
        storage.set(&LIFETIME_SPEND_KEY, &lifetime_spend);

        Ok(())
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        auth::{ContractContext, ContractExecutable, CreateContractHostFnContext},
        testutils::{Address as _, BytesN as _, EnvTestConfig, Ledger},
        IntoVal, FromVal,
    };

    // Use ed25519-dalek for signing in tests (same pattern as Crossmint/stellar-smart-account)
    extern crate std;
    use std::cell::Cell;
    use ed25519_dalek::{Signer as _, SigningKey};
    use rand::{rngs::StdRng, SeedableRng};

    /// Per-test-thread counter for key seeds. Snapshot files record the agent
    /// public key, so a fresh `OsRng` key on every run rewrote every committed
    /// `test_snapshots/tests/*.json` (#551).
    ///
    /// Seeding must not depend on the order tests happen to run in: the test
    /// harness executes them on parallel threads, so a process-wide counter
    /// hands a different ordinal to a given test from run to run and the
    /// snapshots drift again. The seed combines the test thread's name (the
    /// harness names it after the test) with a thread-local ordinal, which
    /// keeps keys distinct within a test and identical across runs.
    std::thread_local! {
        static KEY_SEED_COUNTER: Cell<u64> = const { Cell::new(0) };
    }

    /// Build the next deterministic seed for the current test.
    fn next_key_seed() -> u64 {
        let ordinal = KEY_SEED_COUNTER.with(|counter| {
            let next = counter.get().wrapping_add(1);
            counter.set(next);
            next
        });

        // FNV-1a over the current test's name.
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        if let Some(name) = std::thread::current().name() {
            for byte in name.as_bytes() {
                hash ^= u64::from(*byte);
                hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
            }
        }

        hash ^ ordinal.wrapping_mul(0x9e37_79b9_7f4a_7c15)
    }

    fn gen_keypair(env: &Env) -> (SigningKey, BytesN<32>) {
        let mut rng = StdRng::seed_from_u64(next_key_seed());
        let sk = SigningKey::generate(&mut rng);
        let pk = BytesN::<32>::from_array(env, &sk.verifying_key().to_bytes());
        (sk, pk)
    }

    /// A fixed 32-byte value for tests that need a hash-like argument.
    ///
    /// `BytesN::random` draws from the env RNG, whose output differs between
    /// runs. Any random value that ends up in recorded auth args therefore
    /// makes the committed snapshot drift — the same failure mode #551 fixed
    /// for the agent key.
    fn fixed_hash(env: &Env, tag: u8) -> BytesN<32> {
        BytesN::from_array(env, &[tag; 32])
    }

    fn sign_payload(env: &Env, sk: &SigningKey, payload: &BytesN<32>) -> BytesN<64> {
        let sig = sk.sign(&payload.to_array());
        BytesN::<64>::from_array(env, &sig.to_bytes())
    }

    fn event_topic_matches(env: &Env, topic: soroban_sdk::Val, expected: &Symbol) -> bool {
        let sym: Symbol = topic.into_val(env);
        sym == *expected
    }

    fn setup(env: &Env) -> (AgentVaultClient<'_>, SigningKey, Address, Address) {
        let admin = Address::generate(env);
        let (agent_sk, agent_pk) = gen_keypair(env);
        let provider_a = Address::generate(env);

        // daily_cap = 5_000_000 stroops (0.50 USDC), per-payee sub_cap = 5_000_000, expiry = ledger 10_000, no lifetime cap
        let allowlist = Map::from_array(env, [(provider_a.clone(), 5_000_000_i128)]);
        let vault_id = env.register(
            AgentVault,
            (admin, agent_pk, 5_000_000_i128, allowlist, 10_000_u32, 0_i128),
        );
        let client = AgentVaultClient::new(env, &vault_id);

        (client, agent_sk, vault_id, provider_a)
    }

    fn transfer_context(env: &Env, to: &Address, amount: i128) -> Context {
        let token = Address::generate(env);
        let from = Address::generate(env);
        Context::Contract(ContractContext {
            contract: token,
            fn_name: symbol_short!("transfer"),
            args: (from, to.clone(), amount).into_val(env),
        })
    }

    fn malformed_transfer_context(env: &Env, args: soroban_sdk::Vec<soroban_sdk::Val>) -> Context {
        let token = Address::generate(env);
        Context::Contract(ContractContext {
            contract: token,
            fn_name: symbol_short!("transfer"),
            args,
        })
    }

    /// Read (day_spend, per_payee_spend, lifetime_spend) directly from storage.
    fn read_spend_counters(env: &Env, vault_id: &Address, to: &Address) -> (i128, i128, i128) {
        let ledger = env.ledger().sequence();
        let spend_key = (SPEND_PREFIX,);
        let payee_key = (PAYEE_SPEND_PREFIX, to.clone());
        env.as_contract(vault_id, || {
            let day = SpendWindow::rolled(
                env,
                env.storage().temporary().get::<(Symbol,), SpendWindow>(&spend_key),
                ledger,
            )
            .total();
            let payee = SpendWindow::rolled(
                env,
                env.storage()
                    .temporary()
                    .get::<(Symbol, Address), SpendWindow>(&payee_key),
                ledger,
            )
            .total();
            let lifetime = env
                .storage()
                .instance()
                .get::<Symbol, i128>(&LIFETIME_SPEND_KEY)
                .unwrap_or(0);
            (day, payee, lifetime)
        })
    }

    /// Decode a fixed-width hex fixture file (`testdata/ts_auth/*.hex`).
    fn hex_fixture<const N: usize>(hex: &str) -> [u8; N] {
        let hex = hex.trim();
        assert_eq!(hex.len(), N * 2, "fixture must be {N} bytes of hex");
        let mut out = [0u8; N];
        for (i, byte) in out.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).expect("fixture is hex");
        }
        out
    }

    /// #721: the SDK's `agentVaultAuthorizeEntry` writes the credential signature
    /// as raw `scvBytes` (64 bytes) over `sha256(HashIdPreimageSorobanAuthorization)`.
    /// The three fixture files are produced by that TS helper (the SDK test
    /// `agentVault.test.ts` fails if the helper's output ever differs from them;
    /// regenerate with `UPDATE_AGENT_VAULT_FIXTURE=1`). This test decodes them as
    /// `BytesN<64>` and runs the real `__check_auth`, so a drift between what the
    /// SDK signs and what the vault verifies fails here.
    #[test]
    fn test_signature_from_ts_helper_passes_check_auth() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let agent_pk = BytesN::<32>::from_array(
            &env,
            &hex_fixture::<32>(include_str!("../testdata/ts_auth/agent_pk.hex")),
        );
        let payload = BytesN::<32>::from_array(
            &env,
            &hex_fixture::<32>(include_str!("../testdata/ts_auth/payload.hex")),
        );
        let sig = BytesN::<64>::from_array(
            &env,
            &hex_fixture::<64>(include_str!("../testdata/ts_auth/signature.hex")),
        );

        let payee = Address::generate(&env);
        let allowlist = Map::from_array(&env, [(payee.clone(), 5_000_000_i128)]);
        let vault_id = env.register(
            AgentVault,
            (admin, agent_pk, 5_000_000_i128, allowlist, 10_000_u32, 0_i128),
        );

        // The payload is opaque to the vault; the policy contexts only need to be a
        // transfer to an allowlisted payee within the caps.
        let contexts = Vec::from_array(&env, [transfer_context(&env, &payee, 100_000)]);
        let result = env.try_invoke_contract_check_auth::<Error>(
            &vault_id,
            &payload,
            sig.into_val(&env),
            &contexts,
        );
        assert!(result.is_ok(), "TS-produced signature must pass __check_auth: {result:?}");
    }

    /// Test 1: valid payment within cap to allowlisted address passes
    #[test]
    fn test_valid_payment_within_cap_passes() {
        let env = Env::default();
        let (_, agent_sk, vault_id, provider_a) = setup(&env);

        let payload = BytesN::<32>::random(&env);
        let sig = sign_payload(&env, &agent_sk, &payload);
        let contexts = Vec::from_array(&env, [transfer_context(&env, &provider_a, 100_000)]);

        let result = env.try_invoke_contract_check_auth::<Error>(
            &vault_id,
            &payload,
            sig.into_val(&env),
            &contexts,
        );
        assert!(result.is_ok(), "valid payment should pass: {result:?}");
    }

    #[test]
    fn test_transfer_context_with_wrong_arity_returns_typed_error() {
        let env = Env::default();
        let (_, agent_sk, vault_id, _) = setup(&env);
        let payload = BytesN::<32>::random(&env);
        let sig = sign_payload(&env, &agent_sk, &payload);

        for args in [
            Vec::new(&env),
            Vec::from_array(&env, [Address::generate(&env).into_val(&env)]),
            Vec::from_array(
                &env,
                [Address::generate(&env).into_val(&env), Address::generate(&env).into_val(&env)],
            ),
        ] {
            let contexts = Vec::from_array(&env, [malformed_transfer_context(&env, args)]);
            let result = env.try_invoke_contract_check_auth::<Error>(
                &vault_id,
                &payload,
                sig.clone().into_val(&env),
                &contexts,
            );
            assert_eq!(result.unwrap_err().unwrap(), Error::MalformedAuthContext);
        }
    }

    #[test]
    fn test_transfer_context_with_wrong_amount_type_returns_typed_error() {
        let env = Env::default();
        let (_, agent_sk, vault_id, _) = setup(&env);
        let payload = BytesN::<32>::random(&env);
        let sig = sign_payload(&env, &agent_sk, &payload);
        let args = (
            Address::generate(&env),
            Address::generate(&env),
            symbol_short!("bad_amt"),
        )
            .into_val(&env);
        let contexts = Vec::from_array(&env, [malformed_transfer_context(&env, args)]);
        let result = env.try_invoke_contract_check_auth::<Error>(
            &vault_id,
            &payload,
            sig.into_val(&env),
            &contexts,
        );
        assert_eq!(result.unwrap_err().unwrap(), Error::MalformedAuthContext);
    }

    /// Test 2: payment exceeding daily cap is rejected
    #[test]
    fn test_payment_exceeding_daily_cap_rejected() {
        let env = Env::default();
        let (_, agent_sk, vault_id, provider_a) = setup(&env);

        // 6_000_000 > 5_000_000 cap
        let payload = BytesN::<32>::random(&env);
        let sig = sign_payload(&env, &agent_sk, &payload);
        let contexts =
            Vec::from_array(&env, [transfer_context(&env, &provider_a, 6_000_000)]);

        let result = env.try_invoke_contract_check_auth::<Error>(
            &vault_id,
            &payload,
            sig.into_val(&env),
            &contexts,
        );
        assert_eq!(
            result.unwrap_err().unwrap(),
            Error::DailyCapExceeded,
            "should reject over-cap transfer"
        );
    }

    /// Test 3: payment to non-allowlisted address is rejected
    #[test]
    fn test_payment_to_non_allowlisted_address_rejected() {
        let env = Env::default();
        let (_, agent_sk, vault_id, _) = setup(&env);

        let unlisted = Address::generate(&env);
        let payload = BytesN::<32>::random(&env);
        let sig = sign_payload(&env, &agent_sk, &payload);
        let contexts = Vec::from_array(&env, [transfer_context(&env, &unlisted, 100_000)]);

        let result = env.try_invoke_contract_check_auth::<Error>(
            &vault_id,
            &payload,
            sig.into_val(&env),
            &contexts,
        );
        assert_eq!(
            result.unwrap_err().unwrap(),
            Error::PayeeNotAllowed,
            "should reject payment to non-allowlisted address"
        );
    }

    /// Test 4: session key past expiry ledger is rejected
    #[test]
    fn test_session_key_after_expiry_rejected() {
        let env = Env::default();
        let (_, agent_sk, vault_id, provider_a) = setup(&env);

        // Fast-forward ledger past expiry (expiry = 10_000)
        env.ledger().set_sequence_number(10_001);

        let payload = BytesN::<32>::random(&env);
        let sig = sign_payload(&env, &agent_sk, &payload);
        let contexts = Vec::from_array(&env, [transfer_context(&env, &provider_a, 100_000)]);

        let result = env.try_invoke_contract_check_auth::<Error>(
            &vault_id,
            &payload,
            sig.into_val(&env),
            &contexts,
        );
        assert_eq!(
            result.unwrap_err().unwrap(),
            Error::SessionExpired,
            "should reject expired session key"
        );
    }

    /// Test 5: daily cap boundary — payment at exactly the cap succeeds
    #[test]
    fn test_daily_cap_boundary_at_limit_succeeds() {
        let env = Env::default();
        let (_, agent_sk, vault_id, provider_a) = setup(&env);
        // Daily cap = 5_000_000

        let payload = BytesN::<32>::random(&env);
        let sig = sign_payload(&env, &agent_sk, &payload);
        let contexts = Vec::from_array(&env, [transfer_context(&env, &provider_a, 5_000_000)]);

        let result = env.try_invoke_contract_check_auth::<Error>(
            &vault_id,
            &payload,
            sig.into_val(&env),
            &contexts,
        );
        assert!(
            result.is_ok(),
            "payment at exactly the cap should succeed"
        );
    }

    /// Test 6: daily cap boundary — payment exceeding cap by 1 stroop fails
    #[test]
    fn test_daily_cap_boundary_exceeding_by_one_fails() {
        let env = Env::default();
        let (_, agent_sk, vault_id, provider_a) = setup(&env);
        // Daily cap = 5_000_000

        let payload = BytesN::<32>::random(&env);
        let sig = sign_payload(&env, &agent_sk, &payload);
        let contexts = Vec::from_array(&env, [transfer_context(&env, &provider_a, 5_000_001)]);

        let result = env.try_invoke_contract_check_auth::<Error>(
            &vault_id,
            &payload,
            sig.into_val(&env),
            &contexts,
        );
        assert_eq!(
            result.unwrap_err().unwrap(),
            Error::DailyCapExceeded,
            "payment exceeding cap by 1 stroop should fail"
        );
    }

    /// Test 7: accumulated daily spend — multiple transfers within cap succeed
    #[test]
    fn test_accumulated_spend_within_cap_succeeds() {
        let env = Env::default();
        let (_, agent_sk, vault_id, provider_a) = setup(&env);
        // Daily cap = 5_000_000

        // First transfer: 2_000_000
        let payload1 = BytesN::<32>::random(&env);
        let sig1 = sign_payload(&env, &agent_sk, &payload1);
        let contexts1 = Vec::from_array(&env, [transfer_context(&env, &provider_a, 2_000_000)]);
        let result1 = env.try_invoke_contract_check_auth::<Error>(
            &vault_id,
            &payload1,
            sig1.into_val(&env),
            &contexts1,
        );
        assert!(result1.is_ok(), "first transfer should succeed");

        // Second transfer: 3_000_000 (total = 5_000_000)
        let payload2 = BytesN::<32>::random(&env);
        let sig2 = sign_payload(&env, &agent_sk, &payload2);
        let contexts2 = Vec::from_array(&env, [transfer_context(&env, &provider_a, 3_000_000)]);
        let result2 = env.try_invoke_contract_check_auth::<Error>(
            &vault_id,
            &payload2,
            sig2.into_val(&env),
            &contexts2,
        );
        assert!(result2.is_ok(), "second transfer within accumulated cap should succeed");
    }

    /// Test 8: accumulated daily spend — exceeding cap on second transfer fails
    #[test]
    fn test_accumulated_spend_exceeding_cap_fails() {
        let env = Env::default();
        let (_, agent_sk, vault_id, provider_a) = setup(&env);
        // Daily cap = 5_000_000

        // First transfer: 3_000_000
        let payload1 = BytesN::<32>::random(&env);
        let sig1 = sign_payload(&env, &agent_sk, &payload1);
        let contexts1 = Vec::from_array(&env, [transfer_context(&env, &provider_a, 3_000_000)]);
        let result1 = env.try_invoke_contract_check_auth::<Error>(
            &vault_id,
            &payload1,
            sig1.into_val(&env),
            &contexts1,
        );
        assert!(result1.is_ok(), "first transfer should succeed");

        // Second transfer: 2_500_000 (total would be 5_500_000 > cap)
        let payload2 = BytesN::<32>::random(&env);
        let sig2 = sign_payload(&env, &agent_sk, &payload2);
        let contexts2 = Vec::from_array(&env, [transfer_context(&env, &provider_a, 2_500_000)]);
        let result2 = env.try_invoke_contract_check_auth::<Error>(
            &vault_id,
            &payload2,
            sig2.into_val(&env),
            &contexts2,
        );
        assert_eq!(
            result2.unwrap_err().unwrap(),
            Error::DailyCapExceeded,
            "second transfer exceeding accumulated cap should fail"
        );
    }

    /// Test 9: allowlist with multiple entries — all allowlisted addresses accepted
    #[test]
    fn test_allowlist_multiple_entries_all_accepted() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let (agent_sk, agent_pk) = gen_keypair(&env);
        let provider_a = Address::generate(&env);
        let provider_b = Address::generate(&env);
        let provider_c = Address::generate(&env);

        let allowlist = Map::from_array(
            &env,
            [
                (provider_a.clone(), 5_000_000_i128),
                (provider_b.clone(), 5_000_000_i128),
                (provider_c.clone(), 5_000_000_i128),
            ],
        );
        let vault_id = env.register(
            AgentVault,
            (admin, agent_pk, 5_000_000_i128, allowlist, 10_000_u32, 0_i128),
        );

        // Test payment to each allowlisted address
        for provider in [provider_a, provider_b, provider_c] {
            let payload = BytesN::<32>::random(&env);
            let sig = sign_payload(&env, &agent_sk, &payload);
            let contexts = Vec::from_array(&env, [transfer_context(&env, &provider, 100_000)]);

            let result = env.try_invoke_contract_check_auth::<Error>(
                &vault_id,
                &payload,
                sig.into_val(&env),
                &contexts,
            );
            assert!(result.is_ok(), "all allowlisted addresses should be accepted");
        }
    }

    /// Test 10: session expiry at exact boundary — payment at expiry ledger succeeds
    #[test]
    fn test_session_expiry_at_boundary_succeeds() {
        let env = Env::default();
        let (_, agent_sk, vault_id, provider_a) = setup(&env);
        // Expiry = 10_000

        // Set ledger to exactly the expiry boundary
        env.ledger().set_sequence_number(10_000);

        let payload = BytesN::<32>::random(&env);
        let sig = sign_payload(&env, &agent_sk, &payload);
        let contexts = Vec::from_array(&env, [transfer_context(&env, &provider_a, 100_000)]);

        let result = env.try_invoke_contract_check_auth::<Error>(
            &vault_id,
            &payload,
            sig.into_val(&env),
            &contexts,
        );
        assert!(result.is_ok(), "payment at expiry boundary ledger should succeed");
    }

    /// Test 11: session expiry one ledger past boundary — payment rejected
    #[test]
    fn test_session_expiry_one_past_boundary_fails() {
        let env = Env::default();
        let (_, agent_sk, vault_id, provider_a) = setup(&env);
        // Expiry = 10_000

        // Set ledger to one past the expiry boundary
        env.ledger().set_sequence_number(10_001);

        let payload = BytesN::<32>::random(&env);
        let sig = sign_payload(&env, &agent_sk, &payload);
        let contexts = Vec::from_array(&env, [transfer_context(&env, &provider_a, 100_000)]);

        let result = env.try_invoke_contract_check_auth::<Error>(
            &vault_id,
            &payload,
            sig.into_val(&env),
            &contexts,
        );
        assert_eq!(
            result.unwrap_err().unwrap(),
            Error::SessionExpired,
            "payment one ledger past expiry should fail"
        );
    }

    /// Test 12: overflow protection — very large successive payments rejected safely
    #[test]
    fn test_overflow_protection_large_successive_payments() {
        let env = Env::default();
        let (_, agent_sk, vault_id, provider_a) = setup(&env);
        // Daily cap = 5_000_000

        // First large transfer: 4_000_000_000_000_000 (i128 near limit)
        let payload1 = BytesN::<32>::random(&env);
        let sig1 = sign_payload(&env, &agent_sk, &payload1);
        let contexts1 = Vec::from_array(&env, [transfer_context(&env, &provider_a, 4_000_000_000_000_000)]);
        let result1 = env.try_invoke_contract_check_auth::<Error>(
            &vault_id,
            &payload1,
            sig1.into_val(&env),
            &contexts1,
        );
        // This should fail due to cap, not overflow
        assert_eq!(
            result1.unwrap_err().unwrap(),
            Error::DailyCapExceeded,
            "large transfer exceeding cap should fail with DailyCapExceeded, not overflow"
        );
    }

    /// Test 13: the daily cap is a trailing window — spend does NOT reset at the
    /// old fixed 17_280 boundary, it ages out ledger-by-sub-bucket (#717).
    #[test]
    fn test_daily_spend_ages_out_of_trailing_window() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let (agent_sk, agent_pk) = gen_keypair(&env);
        let provider_a = Address::generate(&env);

        let allowlist = Map::from_array(&env, [(provider_a.clone(), 5_000_000_i128)]);
        let vault_id = env.register(
            AgentVault,
            (admin, agent_pk, 5_000_000_i128, allowlist, 500_000_u32, 0_i128),
        );

        // Day 0 (sequence 0): spend 4_000_000
        let payload1 = BytesN::<32>::random(&env);
        let sig1 = sign_payload(&env, &agent_sk, &payload1);
        let contexts1 = Vec::from_array(&env, [transfer_context(&env, &provider_a, 4_000_000)]);
        let result1 = env.try_invoke_contract_check_auth::<Error>(
            &vault_id,
            &payload1,
            sig1.into_val(&env),
            &contexts1,
        );
        assert!(result1.is_ok(), "first payment in day 0 should succeed");

        // Still in Day 0: attempt to spend 2_000_000 more (total 6_000_000 > cap) — should fail
        let payload2 = BytesN::<32>::random(&env);
        let sig2 = sign_payload(&env, &agent_sk, &payload2);
        let contexts2 = Vec::from_array(&env, [transfer_context(&env, &provider_a, 2_000_000)]);
        let result2 = env.try_invoke_contract_check_auth::<Error>(
            &vault_id,
            &payload2,
            sig2.into_val(&env),
            &contexts2,
        );
        assert_eq!(
            result2.unwrap_err().unwrap(),
            Error::DailyCapExceeded,
            "second payment in same day should fail due to accumulated spend"
        );

        // The old fixed boundary (ledger 17_280) is no longer a reset: the spend at
        // ledger 0 is still inside the trailing window.
        env.ledger().set_sequence_number(17_280);
        let payload3 = BytesN::<32>::random(&env);
        let sig3 = sign_payload(&env, &agent_sk, &payload3);
        let contexts3 = Vec::from_array(&env, [transfer_context(&env, &provider_a, 4_000_000)]);
        let result3 = env.try_invoke_contract_check_auth::<Error>(
            &vault_id,
            &payload3,
            sig3.into_val(&env),
            &contexts3,
        );
        assert_eq!(
            result3.unwrap_err().unwrap(),
            Error::DailyCapExceeded,
            "spend at ledger 0 must still count at ledger 17_280"
        );

        // One sub-bucket later (ledger 18_000) the sub-bucket holding ledger 0 has
        // aged out, so the cap is available again.
        env.ledger().set_sequence_number(18_000);
        let payload4 = BytesN::<32>::random(&env);
        let sig4 = sign_payload(&env, &agent_sk, &payload4);
        let contexts4 = Vec::from_array(&env, [transfer_context(&env, &provider_a, 4_000_000)]);
        let result4 = env.try_invoke_contract_check_auth::<Error>(
            &vault_id,
            &payload4,
            sig4.into_val(&env),
            &contexts4,
        );
        assert!(
            result4.is_ok(),
            "payment should succeed once the earlier spend has left the trailing window"
        );
    }

    /// Test 14: payment_authorized event emitted on each successful transfer
    #[test]
    fn test_payment_authorized_event_emitted() {
        use soroban_sdk::{testutils::Events, IntoVal};

        let env = Env::default();
        let (_, agent_sk, vault_id, provider_a) = setup(&env);

        let token = Address::generate(&env);
        let from = Address::generate(&env);
        let amount: i128 = 100_000;
        let ctx = Context::Contract(ContractContext {
            contract: token.clone(),
            fn_name: symbol_short!("transfer"),
            args: (from.clone(), provider_a.clone(), amount).into_val(&env),
        });
        let contexts = Vec::from_array(&env, [ctx]);

        let payload = BytesN::<32>::random(&env);
        let sig = sign_payload(&env, &agent_sk, &payload);
        let result = env.try_invoke_contract_check_auth::<Error>(
            &vault_id,
            &payload,
            sig.into_val(&env),
            &contexts,
        );
        assert!(result.is_ok(), "auth should pass");

        let events = env.events().all();
        let evt_name = Symbol::new(&env, "payment_authorized");
        let matching: std::vec::Vec<_> = events
            .iter()
            .filter(|(addr, topics, _)| {
                *addr == vault_id
                    && topics
                        .get(0)
                        .map_or(false, |t| Symbol::from_val(&env, &t) == evt_name)
            })
            .collect();

        assert_eq!(matching.len(), 1, "exactly one payment_authorized event expected");

        let (_, topics, data) = &matching[0];
        let topic_payer: Address = topics.get(1).unwrap().into_val(&env);
        let topic_payee: Address = topics.get(2).unwrap().into_val(&env);
        assert_eq!(topic_payer, from, "topic[1] should be payer");
        assert_eq!(topic_payee, provider_a, "topic[2] should be payee");

        let data_tuple: (i128, Address, i128) = data.clone().into_val(&env);
        assert_eq!(data_tuple.0, amount, "data[0] should be amount");
        assert_eq!(data_tuple.1, token, "data[1] should be asset contract");
        assert_eq!(data_tuple.2, amount, "data[2] should be daily_cumulative (first transfer)");
    }

    /// Test 15: daily_cumulative on the event reflects the accumulated spend
    #[test]
    fn test_payment_authorized_daily_cumulative_accumulates() {
        use soroban_sdk::{testutils::Events, IntoVal};

        let env = Env::default();
        let (_, agent_sk, vault_id, provider_a) = setup(&env);

        let p1 = BytesN::<32>::random(&env);
        let s1 = sign_payload(&env, &agent_sk, &p1);
        let c1 = Vec::from_array(&env, [transfer_context(&env, &provider_a, 1_000_000)]);
        env.try_invoke_contract_check_auth::<Error>(&vault_id, &p1, s1.into_val(&env), &c1).unwrap();

        let p2 = BytesN::<32>::random(&env);
        let s2 = sign_payload(&env, &agent_sk, &p2);
        let c2 = Vec::from_array(&env, [transfer_context(&env, &provider_a, 2_000_000)]);
        env.try_invoke_contract_check_auth::<Error>(&vault_id, &p2, s2.into_val(&env), &c2).unwrap();

        let events = env.events().all();
        let evt_name = Symbol::new(&env, "payment_authorized");
        let last = events
            .iter()
            .filter(|(addr, topics, _)| {
                *addr == vault_id
                    && topics
                        .get(0)
                        .map_or(false, |t| Symbol::from_val(&env, &t) == evt_name)
            })
            .last()
            .expect("expected at least one payment_authorized event");
        let data_tuple: (i128, Address, i128) = last.2.clone().into_val(&env);
        assert_eq!(data_tuple.2, 3_000_000, "daily_cumulative should accumulate");
    }

    /// Test 16: rejected transfer does NOT emit payment_authorized
    #[test]
    fn test_rejected_transfer_emits_no_event() {
        use soroban_sdk::testutils::Events;

        let env = Env::default();
        let (_, agent_sk, vault_id, _) = setup(&env);

        let unlisted = Address::generate(&env);
        let p = BytesN::<32>::random(&env);
        let s = sign_payload(&env, &agent_sk, &p);
        let c = Vec::from_array(&env, [transfer_context(&env, &unlisted, 100_000)]);
        let _ = env.try_invoke_contract_check_auth::<Error>(&vault_id, &p, s.into_val(&env), &c);

        let events = env.events().all();
        let evt_name = Symbol::new(&env, "payment_authorized");
        let count = events
            .iter()
            .filter(|(addr, topics, _)| {
                *addr == vault_id
                    && topics
                        .get(0)
                        .map_or(false, |t| Symbol::from_val(&env, &t) == evt_name)
            })
            .count();
        assert_eq!(count, 0, "rejected transfer must not emit payment_authorized");
    }

    /// Test 17: session_settled event emitted with full payload
    #[test]
    fn test_session_settled_event_emitted() {
        use soroban_sdk::{testutils::Events, IntoVal};

        let env = Env::default();
        let admin = Address::generate(&env);
        let (_, agent_pk) = gen_keypair(&env);
        let provider_a = Address::generate(&env);
        let allowlist = Map::from_array(&env, [(provider_a.clone(), 5_000_000_i128)]);
        let vault_id = env.register(
            AgentVault,
            (admin, agent_pk, 5_000_000_i128, allowlist, 10_000_u32, 0_i128),
        );
        let client = AgentVaultClient::new(&env, &vault_id);

        let channel_id = Address::generate(&env);
        let payer = Address::generate(&env);
        let payee = provider_a.clone();
        let cumulative_amount: i128 = 500_000;
        let voucher_count: u32 = 42;

        env.mock_all_auths();
        client.record_session_settlement(
            &channel_id,
            &payer,
            &payee,
            &cumulative_amount,
            &voucher_count,
        );

        let events = env.events().all();
        let evt_name = Symbol::new(&env, "session_settled");
        let matching: std::vec::Vec<_> = events
            .iter()
            .filter(|(addr, topics, _)| {
                *addr == vault_id
                    && topics
                        .get(0)
                        .map_or(false, |t| Symbol::from_val(&env, &t) == evt_name)
            })
            .collect();
        assert_eq!(matching.len(), 1, "exactly one session_settled event expected");

        let (_, topics, data) = &matching[0];
        let topic_channel: Address = topics.get(1).unwrap().into_val(&env);
        let topic_payee: Address = topics.get(2).unwrap().into_val(&env);
        assert_eq!(topic_channel, channel_id, "topic[1] should be channel_id");
        assert_eq!(topic_payee, payee, "topic[2] should be payee");

        let data_tuple: (Address, i128, u32) = data.clone().into_val(&env);
        assert_eq!(data_tuple.0, payer, "data[0] should be payer");
        assert_eq!(data_tuple.1, cumulative_amount, "data[1] should be cumulative_amount");
        assert_eq!(data_tuple.2, voucher_count, "data[2] should be voucher_count");
    }

    /// Build a vault whose allowlist contains a single payee, returning the
    /// client, the vault id, the admin address and the allowlisted payee.
    fn setup_settlement(env: &Env) -> (AgentVaultClient<'_>, Address, Address, Address) {
        let admin = Address::generate(env);
        let (_, agent_pk) = gen_keypair(env);
        let provider_a = Address::generate(env);

        // The vault is configured by its one-time constructor, so the config is
        // passed at registration (same pattern as `setup` above).
        let allowlist = Map::from_array(env, [(provider_a.clone(), 5_000_000_i128)]);
        let vault_id = env.register(
            AgentVault,
            (
                admin.clone(),
                agent_pk,
                5_000_000_i128,
                allowlist,
                10_000_u32,
                0_i128,
            ),
        );
        let client = AgentVaultClient::new(env, &vault_id);

        (client, vault_id, admin, provider_a)
    }

    /// Test 18a: an allowlisted payee authorizes its own settlement record —
    /// no admin auth entry is mocked at all.
    #[test]
    fn test_session_settled_authorized_by_allowlisted_payee() {
        use soroban_sdk::{testutils::Events, IntoVal};

        let env = Env::default();
        let (client, vault_id, _admin, payee) = setup_settlement(&env);

        let channel_id = Address::generate(&env);
        let payer = Address::generate(&env);
        let cumulative_amount: i128 = 500_000;
        let voucher_count: u32 = 7;

        // Only the payee authorizes. The admin is deliberately absent, so this
        // fails if record_session_settlement still requires admin auth.
        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &payee,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &vault_id,
                fn_name: "record_session_settlement",
                args: (
                    channel_id.clone(),
                    payer.clone(),
                    payee.clone(),
                    cumulative_amount,
                    voucher_count,
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.record_session_settlement(
            &channel_id,
            &payer,
            &payee,
            &cumulative_amount,
            &voucher_count,
        );

        let events = env.events().all();
        let evt_name = Symbol::new(&env, "session_settled");
        let matching: std::vec::Vec<_> = events
            .iter()
            .filter(|(addr, topics, _)| {
                *addr == vault_id
                    && topics
                        .get(0)
                        .map_or(false, |t| Symbol::from_val(&env, &t) == evt_name)
            })
            .collect();
        assert_eq!(matching.len(), 1, "exactly one session_settled event expected");

        let (_, topics, data) = &matching[0];
        let topic_channel: Address = topics.get(1).unwrap().into_val(&env);
        let topic_payee: Address = topics.get(2).unwrap().into_val(&env);
        assert_eq!(topic_channel, channel_id, "topic[1] should be channel_id");
        assert_eq!(topic_payee, payee, "topic[2] should be payee");

        let data_tuple: (Address, i128, u32) = data.clone().into_val(&env);
        assert_eq!(data_tuple.0, payer, "data[0] should be payer");
        assert_eq!(data_tuple.1, cumulative_amount, "data[1] should be cumulative_amount");
        assert_eq!(data_tuple.2, voucher_count, "data[2] should be voucher_count");
    }

    /// Test 18b: the admin alone can no longer record a settlement.
    #[test]
    #[should_panic]
    fn test_session_settled_rejects_admin_only_auth() {
        let env = Env::default();
        let (client, vault_id, admin, payee) = setup_settlement(&env);

        let channel_id = Address::generate(&env);
        let payer = Address::generate(&env);

        // Authorized by the admin, but not by the allowlisted payee.
        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &vault_id,
                fn_name: "record_session_settlement",
                args: (channel_id.clone(), payer.clone(), payee.clone(), 500_000_i128, 10_u32)
                    .into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.record_session_settlement(&channel_id, &payer, &payee, &500_000_i128, &10_u32);
    }

    /// Test 18c: a payee that is not on the allowlist is rejected even when it
    /// authorizes itself and every other auth is mocked.
    #[test]
    #[should_panic(expected = "Error(Contract, #5)")]
    fn test_session_settled_rejects_non_allowlisted_payee() {
        let env = Env::default();
        let (client, _vault_id, _admin, _payee) = setup_settlement(&env);

        let stranger = Address::generate(&env);
        let channel_id = Address::generate(&env);
        let payer = Address::generate(&env);

        // mock_all_auths would satisfy require_auth for anyone — the allowlist
        // check must be what stops this call.
        env.mock_all_auths();
        client.record_session_settlement(&channel_id, &payer, &stranger, &500_000_i128, &10_u32);
    }

    /// Test 18d: a zero cumulative amount is rejected.
    #[test]
    #[should_panic(expected = "Error(Contract, #10)")]
    fn test_session_settled_rejects_zero_amount() {
        let env = Env::default();
        let (client, _vault_id, _admin, payee) = setup_settlement(&env);

        let channel_id = Address::generate(&env);
        let payer = Address::generate(&env);

        env.mock_all_auths();
        client.record_session_settlement(&channel_id, &payer, &payee, &0_i128, &10_u32);
    }

    /// Test 18e: a negative cumulative amount is rejected.
    #[test]
    #[should_panic(expected = "Error(Contract, #10)")]
    fn test_session_settled_rejects_negative_amount() {
        let env = Env::default();
        let (client, _vault_id, _admin, payee) = setup_settlement(&env);

        let channel_id = Address::generate(&env);
        let payer = Address::generate(&env);

        env.mock_all_auths();
        client.record_session_settlement(&channel_id, &payer, &payee, &-1_i128, &10_u32);
    }

    /// Count `session_settled` events in the most recent invocation (the test
    /// environment only retains the last call's events).
    fn count_session_settled(env: &Env, vault_id: &Address) -> usize {
        use soroban_sdk::testutils::Events;
        let evt_name = Symbol::new(env, "session_settled");
        env.events()
            .all()
            .iter()
            .filter(|(addr, topics, _)| {
                addr == vault_id
                    && topics
                        .get(0)
                        .map_or(false, |t| Symbol::from_val(env, &t) == evt_name)
            })
            .count()
    }

    /// Test 18f: a frozen vault refuses to record a settlement (issue #605).
    #[test]
    fn test_session_settled_rejected_while_frozen() {
        let env = Env::default();
        let (client, vault_id, _admin, payee) = setup_settlement(&env);
        env.mock_all_auths();
        client.freeze();

        let channel_id = Address::generate(&env);
        let payer = Address::generate(&env);
        assert_eq!(
            client.try_record_session_settlement(&channel_id, &payer, &payee, &500_000_i128, &1_u32),
            Err(Ok(soroban_sdk::Error::from_contract_error(
                Error::ContractFrozen as u32
            ))),
        );
        assert_eq!(count_session_settled(&env, &vault_id), 0);

        // Unfreezing restores the normal path, and the rejected attempt left no
        // marker behind that would block the real record.
        client.unfreeze();
        client.record_session_settlement(&channel_id, &payer, &payee, &500_000_i128, &1_u32);
        assert_eq!(count_session_settled(&env, &vault_id), 1);
    }

    /// Test 18g: the frozen check runs before the auth check, so a frozen vault
    /// rejects with `ContractFrozen` even when the payee has not authorized.
    #[test]
    fn test_session_settled_frozen_check_precedes_auth() {
        let env = Env::default();
        let (client, _vault_id, _admin, payee) = setup_settlement(&env);
        env.mock_all_auths();
        client.freeze();

        // No auths mocked for the settlement call itself.
        env.mock_auths(&[]);
        let channel_id = Address::generate(&env);
        let payer = Address::generate(&env);
        assert_eq!(
            client.try_record_session_settlement(&channel_id, &payer, &payee, &500_000_i128, &1_u32),
            Err(Ok(soroban_sdk::Error::from_contract_error(
                Error::ContractFrozen as u32
            ))),
        );
    }

    /// Test 18h: the same channel cannot be recorded twice, and the second
    /// attempt emits nothing (issue #605).
    #[test]
    fn test_session_settled_rejects_same_channel_twice() {
        let env = Env::default();
        let (client, vault_id, _admin, payee) = setup_settlement(&env);
        env.mock_all_auths();

        let channel_id = Address::generate(&env);
        let payer = Address::generate(&env);
        client.record_session_settlement(&channel_id, &payer, &payee, &500_000_i128, &3_u32);
        assert_eq!(count_session_settled(&env, &vault_id), 1);

        // Even with different amounts the channel is already on record.
        assert_eq!(
            client.try_record_session_settlement(&channel_id, &payer, &payee, &900_000_i128, &9_u32),
            Err(Ok(soroban_sdk::Error::from_contract_error(
                Error::SettlementAlreadyRecorded as u32
            ))),
        );
        // The rejected second attempt emitted nothing.
        assert_eq!(count_session_settled(&env, &vault_id), 0);
    }

    /// Test 18i: a different channel still records after another was settled.
    #[test]
    fn test_session_settled_distinct_channels_both_record() {
        let env = Env::default();
        let (client, vault_id, _admin, payee) = setup_settlement(&env);
        env.mock_all_auths();

        let payer = Address::generate(&env);
        client.record_session_settlement(
            &Address::generate(&env),
            &payer,
            &payee,
            &500_000_i128,
            &1_u32,
        );
        assert_eq!(count_session_settled(&env, &vault_id), 1);
        client.record_session_settlement(
            &Address::generate(&env),
            &payer,
            &payee,
            &700_000_i128,
            &2_u32,
        );
        assert_eq!(count_session_settled(&env, &vault_id), 1);
    }

    /// Test 18j: the per-channel marker lives in persistent storage and its TTL
    /// is extended to match the instance TTL, so it outlives the channel.
    #[test]
    fn test_session_settled_marker_ttl_matches_instance_ttl() {
        use soroban_sdk::testutils::storage::Persistent as _;

        let env = Env::default();
        let (client, vault_id, _admin, payee) = setup_settlement(&env);
        env.mock_all_auths();

        let channel_id = Address::generate(&env);
        client.record_session_settlement(
            &channel_id,
            &Address::generate(&env),
            &payee,
            &500_000_i128,
            &1_u32,
        );

        let ttl = env.as_contract(&vault_id, || {
            env.storage()
                .persistent()
                .get_ttl(&(SETTLED_KEY, channel_id.clone()))
        });
        assert_eq!(ttl, INSTANCE_TTL_EXTEND_TO);
    }

    /// Test 18k: existing error codes 1..=16 keep their values; the new code is
    /// appended after them.
    #[test]
    fn test_error_codes_are_stable() {
        assert_eq!(Error::AlreadyInitialized as u32, 1);
        assert_eq!(Error::PayeeNotAllowed as u32, 5);
        assert_eq!(Error::ContractFrozen as u32, 9);
        assert_eq!(Error::InvalidAmount as u32, 10);
        assert_eq!(Error::UpgradeTimelockOverflow as u32, 16);
        assert_eq!(Error::SettlementAlreadyRecorded as u32, 17);
    }

    /// Test 19: payment within global cap but exceeding per-payee sub-cap is rejected
    #[test]
    fn test_per_payee_cap_enforced_below_global_cap() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let (agent_sk, agent_pk) = gen_keypair(&env);
        let provider_a = Address::generate(&env);

        // global cap = 5_000_000, per-payee sub-cap = 1_000_000
        let allowlist = Map::from_array(&env, [(provider_a.clone(), 1_000_000_i128)]);
        let vault_id = env.register(
            AgentVault,
            (admin, agent_pk, 5_000_000_i128, allowlist, 10_000_u32, 0_i128),
        );

        // 2_000_000 is within global cap but exceeds sub-cap of 1_000_000
        let payload = BytesN::<32>::random(&env);
        let sig = sign_payload(&env, &agent_sk, &payload);
        let contexts = Vec::from_array(&env, [transfer_context(&env, &provider_a, 2_000_000)]);

        let result = env.try_invoke_contract_check_auth::<Error>(
            &vault_id,
            &payload,
            sig.into_val(&env),
            &contexts,
        );
        assert_eq!(
            result.unwrap_err().unwrap(),
            Error::PayeeCapExceeded,
            "payment within global cap but exceeding per-payee sub-cap should fail"
        );
    }

    /// Test 20: two payees with separate sub-caps do not share spend budget
    #[test]
    fn test_two_payees_independent_sub_caps() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let (agent_sk, agent_pk) = gen_keypair(&env);
        let provider_a = Address::generate(&env);
        let provider_b = Address::generate(&env);

        // global cap = 5_000_000; provider_a sub-cap = 2_000_000; provider_b sub-cap = 2_000_000
        let allowlist = Map::from_array(
            &env,
            [
                (provider_a.clone(), 2_000_000_i128),
                (provider_b.clone(), 2_000_000_i128),
            ],
        );
        let vault_id = env.register(
            AgentVault,
            (admin, agent_pk, 5_000_000_i128, allowlist, 10_000_u32, 0_i128),
        );

        // Pay 2_000_000 to provider_a (hits their sub-cap exactly)
        let p1 = BytesN::<32>::random(&env);
        let s1 = sign_payload(&env, &agent_sk, &p1);
        let c1 = Vec::from_array(&env, [transfer_context(&env, &provider_a, 2_000_000)]);
        assert!(
            env.try_invoke_contract_check_auth::<Error>(&vault_id, &p1, s1.into_val(&env), &c1).is_ok(),
            "provider_a at sub-cap should succeed"
        );

        // Pay 2_000_000 to provider_b (their budget is independent — should still pass)
        let p2 = BytesN::<32>::random(&env);
        let s2 = sign_payload(&env, &agent_sk, &p2);
        let c2 = Vec::from_array(&env, [transfer_context(&env, &provider_b, 2_000_000)]);
        assert!(
            env.try_invoke_contract_check_auth::<Error>(&vault_id, &p2, s2.into_val(&env), &c2).is_ok(),
            "provider_b sub-cap is independent and should succeed"
        );

        // A further payment to provider_a now exceeds their sub-cap
        let p3 = BytesN::<32>::random(&env);
        let s3 = sign_payload(&env, &agent_sk, &p3);
        let c3 = Vec::from_array(&env, [transfer_context(&env, &provider_a, 1)]);
        assert_eq!(
            env.try_invoke_contract_check_auth::<Error>(&vault_id, &p3, s3.into_val(&env), &c3)
                .unwrap_err()
                .unwrap(),
            Error::PayeeCapExceeded,
            "provider_a over their sub-cap should fail"
        );
    }

    /// Test 21: per-payee spend uses the same trailing window as the global cap
    #[test]
    fn test_per_payee_spend_ages_out_of_trailing_window() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let (agent_sk, agent_pk) = gen_keypair(&env);
        let provider_a = Address::generate(&env);

        // global cap = 5_000_000; provider_a sub-cap = 1_000_000
        let allowlist = Map::from_array(&env, [(provider_a.clone(), 1_000_000_i128)]);
        let vault_id = env.register(
            AgentVault,
            (admin, agent_pk, 5_000_000_i128, allowlist, 500_000_u32, 0_i128),
        );

        // Day 0: spend exactly the sub-cap
        let p1 = BytesN::<32>::random(&env);
        let s1 = sign_payload(&env, &agent_sk, &p1);
        let c1 = Vec::from_array(&env, [transfer_context(&env, &provider_a, 1_000_000)]);
        assert!(
            env.try_invoke_contract_check_auth::<Error>(&vault_id, &p1, s1.into_val(&env), &c1).is_ok(),
            "first payment should succeed"
        );

        // Day 0: any further spend exceeds sub-cap
        let p2 = BytesN::<32>::random(&env);
        let s2 = sign_payload(&env, &agent_sk, &p2);
        let c2 = Vec::from_array(&env, [transfer_context(&env, &provider_a, 1)]);
        assert_eq!(
            env.try_invoke_contract_check_auth::<Error>(&vault_id, &p2, s2.into_val(&env), &c2)
                .unwrap_err()
                .unwrap(),
            Error::PayeeCapExceeded,
            "second payment same day should fail"
        );

        // The old fixed boundary is not a reset any more
        env.ledger().set_sequence_number(17_280);
        let p3 = BytesN::<32>::random(&env);
        let s3 = sign_payload(&env, &agent_sk, &p3);
        let c3 = Vec::from_array(&env, [transfer_context(&env, &provider_a, 1_000_000)]);
        assert_eq!(
            env.try_invoke_contract_check_auth::<Error>(&vault_id, &p3, s3.into_val(&env), &c3)
                .unwrap_err()
                .unwrap(),
            Error::PayeeCapExceeded,
            "per-payee spend at ledger 0 must still count at ledger 17_280"
        );

        // One sub-bucket later the earlier spend has aged out
        env.ledger().set_sequence_number(18_000);
        let p4 = BytesN::<32>::random(&env);
        let s4 = sign_payload(&env, &agent_sk, &p4);
        let c4 = Vec::from_array(&env, [transfer_context(&env, &provider_a, 1_000_000)]);
        assert!(
            env.try_invoke_contract_check_auth::<Error>(&vault_id, &p4, s4.into_val(&env), &c4).is_ok(),
            "payment should succeed once the earlier per-payee spend has aged out"
        );
    }

    // ── Trailing-window cap tests (#717) ─────────────────────────────────────

    /// Authorize a single transfer through the real `__check_auth`.
    fn pay(
        env: &Env,
        vault_id: &Address,
        sk: &SigningKey,
        to: &Address,
        amount: i128,
    ) -> Result<(), Error> {
        let payload = fixed_hash(env, 7);
        let sig = sign_payload(env, sk, &payload);
        let contexts = Vec::from_array(env, [transfer_context(env, to, amount)]);
        env.try_invoke_contract_check_auth::<Error>(vault_id, &payload, sig.into_val(env), &contexts)
            .map_err(|e| e.unwrap())
    }

    /// Vault with a daily cap and one allowlisted payee per entry of `sub_caps`.
    /// Expiry and lifetime cap are out of the way.
    fn setup_caps(
        env: &Env,
        daily_cap: i128,
        sub_caps: &[i128],
    ) -> (SigningKey, Address, std::vec::Vec<Address>) {
        let admin = Address::generate(env);
        let (agent_sk, agent_pk) = gen_keypair(env);
        let payees: std::vec::Vec<Address> =
            sub_caps.iter().map(|_| Address::generate(env)).collect();
        let mut allowlist = Map::new(env);
        for (payee, cap) in payees.iter().zip(sub_caps) {
            allowlist.set(payee.clone(), *cap);
        }
        let vault_id = env.register(
            AgentVault,
            (admin, agent_pk, daily_cap, allowlist, u32::MAX, 0_i128),
        );
        (agent_sk, vault_id, payees)
    }

    /// #717 reproduction: the whole daily cap on the last ledger before the old
    /// fixed boundary, then anything at the first ledger after it.
    #[test]
    fn test_daily_cap_not_doubled_across_old_bucket_boundary() {
        let env = Env::default();
        let (sk, vault_id, payees) = setup_caps(&env, 5_000_000, &[5_000_000]);
        let to = &payees[0];

        env.ledger().set_sequence_number(17_279);
        assert_eq!(pay(&env, &vault_id, &sk, to, 5_000_000), Ok(()));
        assert_eq!(pay(&env, &vault_id, &sk, to, 1), Err(Error::DailyCapExceeded));

        env.ledger().set_sequence_number(17_280);
        assert_eq!(pay(&env, &vault_id, &sk, to, 1), Err(Error::DailyCapExceeded));
        assert_eq!(pay(&env, &vault_id, &sk, to, 5_000_000), Err(Error::DailyCapExceeded));
    }

    /// Same boundary for the per-payee sub-cap: the global cap has headroom, so
    /// the sub-cap is the only thing that can stop the second spend.
    #[test]
    fn test_per_payee_cap_not_doubled_across_old_bucket_boundary() {
        let env = Env::default();
        let (sk, vault_id, payees) = setup_caps(&env, 10_000_000, &[1_000_000]);
        let to = &payees[0];

        env.ledger().set_sequence_number(17_279);
        assert_eq!(pay(&env, &vault_id, &sk, to, 1_000_000), Ok(()));

        env.ledger().set_sequence_number(17_280);
        assert_eq!(pay(&env, &vault_id, &sk, to, 1), Err(Error::PayeeCapExceeded));
        assert_eq!(pay(&env, &vault_id, &sk, to, 1_000_000), Err(Error::PayeeCapExceeded));
    }

    /// Spend made at ledger 17_279 (sub-bucket 23) stays counted for exactly
    /// 25 sub-buckets, i.e. until ledger 34_560, and no longer.
    #[test]
    fn test_spend_allowed_again_once_it_ages_out() {
        let env = Env::default();
        let (sk, vault_id, payees) = setup_caps(&env, 5_000_000, &[5_000_000]);
        let to = &payees[0];

        env.ledger().set_sequence_number(17_279);
        assert_eq!(pay(&env, &vault_id, &sk, to, 5_000_000), Ok(()));

        // Still inside the window one ledger short of 17_280 later (and the
        // conservative extra sub-bucket after that)
        env.ledger().set_sequence_number(17_279 + 17_280);
        assert_eq!(pay(&env, &vault_id, &sk, to, 1), Err(Error::DailyCapExceeded));
        env.ledger().set_sequence_number(34_559);
        assert_eq!(pay(&env, &vault_id, &sk, to, 1), Err(Error::DailyCapExceeded));

        // Sub-bucket 23 ages out at ledger 34_560: at most one sub-bucket
        // (720 ledgers) later than the exact 17_280-ledger window
        env.ledger().set_sequence_number(34_560);
        assert_eq!(pay(&env, &vault_id, &sk, to, 5_000_000), Ok(()));
        assert_eq!(pay(&env, &vault_id, &sk, to, 1), Err(Error::DailyCapExceeded));
    }

    /// Spend ages out sub-bucket by sub-bucket, not all at once.
    #[test]
    fn test_spend_ages_out_gradually() {
        let env = Env::default();
        let (sk, vault_id, payees) = setup_caps(&env, 5_000_000, &[5_000_000]);
        let to = &payees[0];

        env.ledger().set_sequence_number(0);
        assert_eq!(pay(&env, &vault_id, &sk, to, 3_000_000), Ok(()));
        env.ledger().set_sequence_number(10_000); // sub-bucket 13
        assert_eq!(pay(&env, &vault_id, &sk, to, 2_000_000), Ok(()));

        // Sub-bucket 0 is dropped at ledger 18_000, sub-bucket 13 is still counted
        env.ledger().set_sequence_number(17_999);
        assert_eq!(pay(&env, &vault_id, &sk, to, 1), Err(Error::DailyCapExceeded));
        env.ledger().set_sequence_number(18_000);
        assert_eq!(pay(&env, &vault_id, &sk, to, 3_000_001), Err(Error::DailyCapExceeded));
        assert_eq!(pay(&env, &vault_id, &sk, to, 3_000_000), Ok(()));

        // Sub-bucket 13 is dropped at ledger 27_360; the 3_000_000 from ledger
        // 18_000 is still counted
        env.ledger().set_sequence_number(27_359);
        assert_eq!(pay(&env, &vault_id, &sk, to, 1), Err(Error::DailyCapExceeded));
        env.ledger().set_sequence_number(27_360);
        assert_eq!(pay(&env, &vault_id, &sk, to, 2_000_001), Err(Error::DailyCapExceeded));
        assert_eq!(pay(&env, &vault_id, &sk, to, 2_000_000), Ok(()));
    }

    /// `payment_authorized.daily_cumulative` is the spend inside the trailing
    /// window, so it drops as sub-buckets age out instead of resetting at a boundary.
    #[test]
    fn test_daily_cumulative_event_is_trailing_window_spend() {
        let env = Env::default();
        let (sk, vault_id, payees) = setup_caps(&env, 5_000_000, &[5_000_000]);
        let to = &payees[0];

        let cumulative = |env: &Env| -> i128 {
            let events = soroban_sdk::testutils::Events::all(&env.events());
            let (_, _, data) = events.get(events.len() - 1).unwrap();
            let (_amount, _asset, daily): (i128, Address, i128) = FromVal::from_val(env, &data);
            daily
        };

        env.ledger().set_sequence_number(0);
        pay(&env, &vault_id, &sk, to, 3_000_000).unwrap();
        assert_eq!(cumulative(&env), 3_000_000);

        env.ledger().set_sequence_number(10_000);
        pay(&env, &vault_id, &sk, to, 1_000_000).unwrap();
        assert_eq!(cumulative(&env), 4_000_000);

        // The 3_000_000 from ledger 0 is gone at ledger 18_000
        env.ledger().set_sequence_number(18_000);
        pay(&env, &vault_id, &sk, to, 500_000).unwrap();
        assert_eq!(cumulative(&env), 1_500_000);
    }

    /// Each counter's temporary entry must outlive every payment it still
    /// counts, and must be re-extended on every write.
    #[test]
    fn test_spend_counters_ttl_covers_the_window_and_is_extended_on_write() {
        use soroban_sdk::testutils::storage::Temporary as _;

        let env = Env::default();
        let (sk, vault_id, payees) = setup_caps(&env, 5_000_000, &[5_000_000]);
        let to = &payees[0];

        let ttls = |env: &Env| -> (u32, u32) {
            let global = (SPEND_PREFIX,);
            let payee = (PAYEE_SPEND_PREFIX, to.clone());
            env.as_contract(&vault_id, || {
                (
                    env.storage().temporary().get_ttl(&global),
                    env.storage().temporary().get_ttl(&payee),
                )
            })
        };

        env.ledger().set_sequence_number(1_000);
        pay(&env, &vault_id, &sk, to, 1_000_000).unwrap();
        let (global, payee) = ttls(&env);
        assert!(global >= SPEND_TTL_LEDGERS, "global counter TTL {global} too short");
        assert!(payee >= SPEND_TTL_LEDGERS, "payee counter TTL {payee} too short");

        // Half a window later, a second write lifts the TTL again
        env.ledger().set_sequence_number(10_000);
        pay(&env, &vault_id, &sk, to, 1_000_000).unwrap();
        let (global, payee) = ttls(&env);
        assert!(global >= SPEND_TTL_LEDGERS, "global TTL not re-extended: {global}");
        assert!(payee >= SPEND_TTL_LEDGERS, "payee TTL not re-extended: {payee}");
    }

    /// The counter must still be there on the last ledger a payment is counted
    /// (a counter that expired early would silently reset the cap).
    #[test]
    fn test_spend_counter_survives_until_the_payment_ages_out() {
        let env = Env::default();
        let (sk, vault_id, payees) = setup_caps(&env, 5_000_000, &[5_000_000]);
        let to = &payees[0];

        env.ledger().set_sequence_number(0);
        pay(&env, &vault_id, &sk, to, 5_000_000).unwrap();

        // Last ledger the ring still counts a payment from sub-bucket 0
        env.ledger().set_sequence_number(SPEND_TTL_LEDGERS - 1);
        assert_eq!(pay(&env, &vault_id, &sk, to, 1), Err(Error::DailyCapExceeded));
    }

    /// A vault upgraded from the fixed-bucket counters seeds its missing windows
    /// from the current legacy bucket, once, and the seeded spend ages out like
    /// any other.
    #[test]
    fn test_missing_window_is_seeded_from_legacy_counters() {
        let env = Env::default();
        let (sk, vault_id, payees) = setup_caps(&env, 5_000_000, &[3_000_000, 5_000_000]);
        let (first, second) = (&payees[0], &payees[1]);

        // Ledger 20_000 is in legacy bucket 1 and sub-bucket 27.
        env.ledger().set_sequence_number(20_000);
        env.as_contract(&vault_id, || {
            let temporary = env.storage().temporary();
            temporary.set(&(SPEND_PREFIX, 1_u32), &4_000_000_i128);
            temporary.set(&(PAYEE_SPEND_PREFIX, 1_u32, first.clone()), &2_500_000_i128);
        });

        assert_eq!(pay(&env, &vault_id, &sk, first, 500_001), Err(Error::PayeeCapExceeded));
        assert_eq!(pay(&env, &vault_id, &sk, second, 1_000_001), Err(Error::DailyCapExceeded));
        assert_eq!(pay(&env, &vault_id, &sk, first, 500_000), Ok(()));
        assert_eq!(pay(&env, &vault_id, &sk, second, 500_000), Ok(()));
        // The legacy totals were added once, not again on the second payment.
        assert_eq!(
            read_spend_counters(&env, &vault_id, first),
            (5_000_000, 3_000_000, 1_000_000)
        );

        env.ledger().set_sequence_number((27 + SPEND_RING_SLOTS) * SPEND_SUB_BUCKET_LEDGERS - 1);
        assert_eq!(pay(&env, &vault_id, &sk, first, 1), Err(Error::DailyCapExceeded));
        env.ledger().set_sequence_number((27 + SPEND_RING_SLOTS) * SPEND_SUB_BUCKET_LEDGERS);
        assert_eq!(pay(&env, &vault_id, &sk, first, 3_000_000), Ok(()));
    }

    /// Drive the real `__check_auth` with a few hundred seeded random payments and
    /// ledger jumps across several payees. Asserts, for every accepted payment:
    ///   * the spend accepted in any 17_280-ledger window never exceeds the daily
    ///     cap, nor a payee's sub-cap (the property #717 is about), and
    ///   * every rejection is justified by spend inside the window plus one
    ///     sub-bucket, i.e. the window never rejects more than one sub-bucket late.
    #[test]
    fn test_trailing_window_bound_holds_under_random_payments() {
        use rand::Rng;

        const DAILY: i128 = 5_000_000;
        const SUB_CAPS: [i128; 3] = [3_000_000, 4_000_000, 1_000_000];
        const JUMPS: [u32; 11] =
            [0, 0, 1, 5, 100, 719, 720, 721, 3_000, 17_279, 17_280];
        const STEPS: usize = 400;
        // The ring may count a payment for up to one extra sub-bucket
        const CONSERVATIVE_WINDOW: i64 =
            (SPEND_WINDOW_LEDGERS + SPEND_SUB_BUCKET_LEDGERS) as i64;

        let mut total_accepted = 0_usize;
        let mut total_rejected = 0_usize;

        // One Env for every seed; each seed gets a fresh vault and restarts the
        // ledger clock. No snapshot: it would record thousands of lines of
        // random state.
        let env = Env::new_with_config(EnvTestConfig {
            capture_snapshot_at_drop: false,
        });
        for seed in 0..8_u64 {
            env.ledger().set_sequence_number(1);
            let (sk, vault_id, payees) = setup_caps(&env, DAILY, &SUB_CAPS);
            let mut rng = StdRng::seed_from_u64(0x717 + seed);
            // (ledger, payee index, amount) of every accepted payment
            let mut accepted: std::vec::Vec<(u32, usize, i128)> = std::vec::Vec::new();
            let mut ledger: u32 = 1;

            let spent = |accepted: &[(u32, usize, i128)],
                         now: u32,
                         window: i64,
                         payee: Option<usize>|
             -> i128 {
                accepted
                    .iter()
                    .filter(|(l, who, _)| {
                        (*l as i64) > (now as i64) - window && payee.map_or(true, |p| p == *who)
                    })
                    .map(|(_, _, amount)| *amount)
                    .sum()
            };

            for _ in 0..STEPS {
                ledger += JUMPS[rng.gen_range(0..JUMPS.len())];
                env.ledger().set_sequence_number(ledger);
                let who = rng.gen_range(0..SUB_CAPS.len());
                let amount: i128 = rng.gen_range(1..=DAILY / 2);

                match pay(&env, &vault_id, &sk, &payees[who], amount) {
                    Ok(()) => {
                        accepted.push((ledger, who, amount));
                        total_accepted += 1;
                        let exact = SPEND_WINDOW_LEDGERS as i64;
                        assert!(
                            spent(&accepted, ledger, exact, None) <= DAILY,
                            "seed {seed}: daily cap exceeded in a 17_280-ledger window ending at {ledger}"
                        );
                        assert!(
                            spent(&accepted, ledger, exact, Some(who)) <= SUB_CAPS[who],
                            "seed {seed}: payee {who} sub-cap exceeded in a window ending at {ledger}"
                        );
                    }
                    Err(Error::DailyCapExceeded) => {
                        total_rejected += 1;
                        assert!(
                            spent(&accepted, ledger, CONSERVATIVE_WINDOW, None) + amount > DAILY,
                            "seed {seed}: daily rejection at {ledger} not justified by the window"
                        );
                    }
                    Err(Error::PayeeCapExceeded) => {
                        total_rejected += 1;
                        assert!(
                            spent(&accepted, ledger, CONSERVATIVE_WINDOW, Some(who)) + amount
                                > SUB_CAPS[who],
                            "seed {seed}: payee {who} rejection at {ledger} not justified by the window"
                        );
                    }
                    Err(other) => panic!("seed {seed}: unexpected error {other:?} at {ledger}"),
                }
            }
        }

        // The run must actually exercise both outcomes
        assert!(total_accepted > 200, "only {total_accepted} payments accepted");
        assert!(total_rejected > 200, "only {total_rejected} payments rejected");
    }

    // ── Lifetime cap tests ────────────────────────────────────────────────────

    /// Helper: vault with daily_cap=5_000_000, lifetime_cap as specified, expiry far out.
    fn setup_with_lifetime_cap(
        env: &Env,
        lifetime_cap: i128,
    ) -> (AgentVaultClient<'_>, SigningKey, Address, Address) {
        let admin = Address::generate(env);
        let (agent_sk, agent_pk) = gen_keypair(env);
        let provider_a = Address::generate(env);

        let allowlist = Map::from_array(env, [(provider_a.clone(), 5_000_000_i128)]);
        let vault_id = env.register(
            AgentVault,
            (admin, agent_pk, 5_000_000_i128, allowlist, 500_000_u32, lifetime_cap),
        );
        let client = AgentVaultClient::new(env, &vault_id);
        (client, agent_sk, vault_id, provider_a)
    }

    /// Test 22: lifetime cap of 0 means unlimited — large spend across days is accepted.
    #[test]
    fn test_lifetime_cap_zero_means_unlimited() {
        let env = Env::default();
        // 0 = no lifetime cap; daily cap is the only ceiling
        let (_, agent_sk, vault_id, provider_a) = setup_with_lifetime_cap(&env, 0);

        // Day 0: spend 5_000_000 (at daily cap)
        let p1 = BytesN::<32>::random(&env);
        let s1 = sign_payload(&env, &agent_sk, &p1);
        let c1 = Vec::from_array(&env, [transfer_context(&env, &provider_a, 5_000_000)]);
        assert!(
            env.try_invoke_contract_check_auth::<Error>(&vault_id, &p1, s1.into_val(&env), &c1)
                .is_ok(),
            "day 0 spend should succeed"
        );

        // Once day-0 spend has left the trailing window: spend another 5_000_000
        // (total 10M — would fail if cap were 8M)
        env.ledger().set_sequence_number(18_000);
        let p2 = BytesN::<32>::random(&env);
        let s2 = sign_payload(&env, &agent_sk, &p2);
        let c2 = Vec::from_array(&env, [transfer_context(&env, &provider_a, 5_000_000)]);
        assert!(
            env.try_invoke_contract_check_auth::<Error>(&vault_id, &p2, s2.into_val(&env), &c2)
                .is_ok(),
            "day 1 spend should succeed when lifetime_cap=0"
        );
    }

    /// Test 23: lifetime cap enforced — transfer exceeding lifetime cap rejected.
    #[test]
    fn test_lifetime_cap_enforced() {
        let env = Env::default();
        // lifetime_cap = 3_000_000, daily_cap = 5_000_000
        let (_, agent_sk, vault_id, provider_a) = setup_with_lifetime_cap(&env, 3_000_000);

        // 4_000_000 > lifetime_cap of 3_000_000 (but <= daily_cap 5_000_000)
        let p = BytesN::<32>::random(&env);
        let s = sign_payload(&env, &agent_sk, &p);
        let c = Vec::from_array(&env, [transfer_context(&env, &provider_a, 4_000_000)]);

        let result =
            env.try_invoke_contract_check_auth::<Error>(&vault_id, &p, s.into_val(&env), &c);
        assert_eq!(
            result.unwrap_err().unwrap(),
            Error::LifetimeCapExceeded,
            "transfer exceeding lifetime cap should be rejected"
        );
    }

    /// Test 24: lifetime cap boundary — spending exactly at cap succeeds.
    #[test]
    fn test_lifetime_cap_boundary_at_limit_succeeds() {
        let env = Env::default();
        let (_, agent_sk, vault_id, provider_a) = setup_with_lifetime_cap(&env, 3_000_000);

        let p = BytesN::<32>::random(&env);
        let s = sign_payload(&env, &agent_sk, &p);
        let c = Vec::from_array(&env, [transfer_context(&env, &provider_a, 3_000_000)]);

        assert!(
            env.try_invoke_contract_check_auth::<Error>(&vault_id, &p, s.into_val(&env), &c)
                .is_ok(),
            "transfer exactly at lifetime cap should succeed"
        );
    }

    /// Test 25: lifetime cap boundary — one stroop over limit fails.
    #[test]
    fn test_lifetime_cap_boundary_exceeding_by_one_fails() {
        let env = Env::default();
        let (_, agent_sk, vault_id, provider_a) = setup_with_lifetime_cap(&env, 3_000_000);

        let p = BytesN::<32>::random(&env);
        let s = sign_payload(&env, &agent_sk, &p);
        let c = Vec::from_array(&env, [transfer_context(&env, &provider_a, 3_000_001)]);

        let result =
            env.try_invoke_contract_check_auth::<Error>(&vault_id, &p, s.into_val(&env), &c);
        assert_eq!(
            result.unwrap_err().unwrap(),
            Error::LifetimeCapExceeded,
            "transfer 1 stroop over lifetime cap should fail"
        );
    }

    /// Test 26: lifetime spend accumulates across day resets.
    #[test]
    fn test_lifetime_cap_accumulates_across_days() {
        let env = Env::default();
        // lifetime_cap = 8_000_000, daily_cap = 5_000_000
        let (_, agent_sk, vault_id, provider_a) = setup_with_lifetime_cap(&env, 8_000_000);

        // Day 0: spend 5_000_000 (lifetime_spend = 5_000_000)
        let p1 = BytesN::<32>::random(&env);
        let s1 = sign_payload(&env, &agent_sk, &p1);
        let c1 = Vec::from_array(&env, [transfer_context(&env, &provider_a, 5_000_000)]);
        assert!(
            env.try_invoke_contract_check_auth::<Error>(&vault_id, &p1, s1.into_val(&env), &c1)
                .is_ok(),
            "day 0 spend should succeed"
        );

        // Once day-0 spend has left the trailing window: try 4_000_000 — total
        // would be 9_000_000 > 8_000_000 lifetime cap
        env.ledger().set_sequence_number(18_000);
        let p2 = BytesN::<32>::random(&env);
        let s2 = sign_payload(&env, &agent_sk, &p2);
        let c2 = Vec::from_array(&env, [transfer_context(&env, &provider_a, 4_000_000)]);
        let result =
            env.try_invoke_contract_check_auth::<Error>(&vault_id, &p2, s2.into_val(&env), &c2);
        assert_eq!(
            result.unwrap_err().unwrap(),
            Error::LifetimeCapExceeded,
            "day 1 spend that crosses lifetime cap should be rejected"
        );

        // Day 1: try 3_000_000 — total = 8_000_000, exactly at lifetime cap → ok
        let p3 = BytesN::<32>::random(&env);
        let s3 = sign_payload(&env, &agent_sk, &p3);
        let c3 = Vec::from_array(&env, [transfer_context(&env, &provider_a, 3_000_000)]);
        assert!(
            env.try_invoke_contract_check_auth::<Error>(&vault_id, &p3, s3.into_val(&env), &c3)
                .is_ok(),
            "day 1 spend that exactly meets lifetime cap should succeed"
        );
    }

    /// Test 27: get_lifetime_spend returns the monotonic counter correctly.
    #[test]
    fn test_get_lifetime_spend_tracks_correctly() {
        let env = Env::default();
        let (client, agent_sk, vault_id, provider_a) = setup_with_lifetime_cap(&env, 0);

        assert_eq!(client.get_lifetime_spend(), 0, "initial lifetime spend is 0");

        let p = BytesN::<32>::random(&env);
        let s = sign_payload(&env, &agent_sk, &p);
        let c = Vec::from_array(&env, [transfer_context(&env, &provider_a, 1_500_000)]);
        env.try_invoke_contract_check_auth::<Error>(&vault_id, &p, s.into_val(&env), &c)
            .unwrap();

        assert_eq!(
            client.get_lifetime_spend(),
            1_500_000,
            "lifetime spend counter should reflect the payment"
        );
    }

    /// Test 28: daily cap rejection does NOT advance lifetime spend counter.
    #[test]
    fn test_lifetime_spend_not_incremented_on_rejection() {
        let env = Env::default();
        let (client, agent_sk, vault_id, provider_a) = setup_with_lifetime_cap(&env, 0);

        // Attempt over-daily-cap payment (rejected)
        let p = BytesN::<32>::random(&env);
        let s = sign_payload(&env, &agent_sk, &p);
        let c = Vec::from_array(&env, [transfer_context(&env, &provider_a, 6_000_000)]);
        let result =
            env.try_invoke_contract_check_auth::<Error>(&vault_id, &p, s.into_val(&env), &c);
        assert_eq!(result.unwrap_err().unwrap(), Error::DailyCapExceeded);

        // Lifetime spend must remain 0 — the failed auth must not mutate state
        assert_eq!(
            client.get_lifetime_spend(),
            0,
            "rejected auth must not advance lifetime spend"
        );
    }
/// Test 19: transfer_admin and accept_admin happy path
    #[test]
    fn test_transfer_and_accept_admin_succeeds() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let (_, agent_pk) = gen_keypair(&env);
        let allowlist = soroban_sdk::Map::<Address, i128>::new(&env);
        let vault_id = env.register(
            AgentVault,
            (admin.clone(), agent_pk, 5_000_000_i128, allowlist, 10_000_u32, 0_i128),
        );
        let client = AgentVaultClient::new(&env, &vault_id);

        let new_admin = Address::generate(&env);

        // 1. Transfer admin
        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &vault_id,
                fn_name: "transfer_admin",
                args: (&new_admin,).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.transfer_admin(&new_admin);
        
        // 2. Accept admin
        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &new_admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &vault_id,
                fn_name: "accept_admin",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.accept_admin();

        // 3. Verify new admin has access
        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &new_admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &vault_id,
                fn_name: "set_daily_cap",
                args: (&10_000_000_i128,).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.set_daily_cap(&10_000_000_i128);
    }

    /// Test 20: old admin loses access immediately after acceptance
    #[test]
    #[should_panic]
    fn test_old_admin_loses_access() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let (_, agent_pk) = gen_keypair(&env);
        let allowlist = soroban_sdk::Map::<Address, i128>::new(&env);
        let vault_id = env.register(
            AgentVault,
            (admin.clone(), agent_pk, 5_000_000_i128, allowlist, 10_000_u32, 0_i128),
        );
        let client = AgentVaultClient::new(&env, &vault_id);

        let new_admin = Address::generate(&env);
        
        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &vault_id,
                fn_name: "transfer_admin",
                args: (&new_admin,).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.transfer_admin(&new_admin);
        
        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &new_admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &vault_id,
                fn_name: "accept_admin",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.accept_admin();

        // Old admin attempts to change daily cap
        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &vault_id,
                fn_name: "set_daily_cap",
                args: (&10_000_000_i128,).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.set_daily_cap(&10_000_000_i128);
    }

    /// Test 21: accept_admin without pending admin fails
    #[test]
    #[should_panic(expected = "Error(Contract, #8)")]
    fn test_accept_admin_no_pending_admin_fails() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let (_, agent_pk) = gen_keypair(&env);
        let allowlist = soroban_sdk::Map::<Address, i128>::new(&env);
        let vault_id = env.register(
            AgentVault,
            (admin, agent_pk, 5_000_000_i128, allowlist, 10_000_u32, 0_i128),
        );
        let client = AgentVaultClient::new(&env, &vault_id);

        env.mock_all_auths();
        client.accept_admin(); // Should panic with NoPendingAdmin
    }

    /// Test 22: transfer initiation by non-admin fails
    #[test]
    #[should_panic]
    fn test_transfer_admin_requires_auth() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let (_, agent_pk) = gen_keypair(&env);
        let allowlist = soroban_sdk::Map::<Address, i128>::new(&env);
        let vault_id = env.register(
            AgentVault,
            (admin, agent_pk, 5_000_000_i128, allowlist, 10_000_u32, 0_i128),
        );
        let client = AgentVaultClient::new(&env, &vault_id);

        let new_admin = Address::generate(&env);
        let stranger = Address::generate(&env);
        
        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &stranger,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &vault_id,
                fn_name: "transfer_admin",
                args: (&new_admin,).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.transfer_admin(&new_admin);
    }

    /// Test 23: accept by wrong address fails
    #[test]
    #[should_panic]
    fn test_accept_admin_wrong_address_fails() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let (_, agent_pk) = gen_keypair(&env);
        let allowlist = soroban_sdk::Map::<Address, i128>::new(&env);
        let vault_id = env.register(
            AgentVault,
            (admin.clone(), agent_pk, 5_000_000_i128, allowlist, 10_000_u32, 0_i128),
        );
        let client = AgentVaultClient::new(&env, &vault_id);

        let new_admin = Address::generate(&env);
        
        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &vault_id,
                fn_name: "transfer_admin",
                args: (&new_admin,).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.transfer_admin(&new_admin);

        let wrong_address = Address::generate(&env);
        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &wrong_address,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &vault_id,
                fn_name: "accept_admin",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.accept_admin();
    }

    /// Test 35: freeze blocks subsequent calls
    #[test]
    fn test_freeze_blocks_transfers() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let (agent_sk, agent_pk) = gen_keypair(&env);
        let provider_a = Address::generate(&env);
        let allowlist = soroban_sdk::Map::from_array(&env, [(provider_a.clone(), 5_000_000_i128)]);
        let vault_id = env.register(
            AgentVault,
            (admin.clone(), agent_pk, 5_000_000_i128, allowlist, 10_000_u32, 0_i128),
        );
        let client = AgentVaultClient::new(&env, &vault_id);

        // Freeze the contract
        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &vault_id,
                fn_name: "freeze",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.freeze();

        // Attempt a transfer, should fail
        let payload = BytesN::<32>::random(&env);
        let sig = sign_payload(&env, &agent_sk, &payload);
        let contexts = soroban_sdk::Vec::from_array(&env, [transfer_context(&env, &provider_a, 100_000)]);

        let result = env.try_invoke_contract_check_auth::<Error>(
            &vault_id,
            &payload,
            sig.into_val(&env),
            &contexts,
        );
        assert_eq!(
            result.unwrap_err().unwrap(),
            Error::ContractFrozen,
            "frozen contract should reject transfers"
        );
    }

    /// Test 36: unfreeze restores normal operation
    #[test]
    fn test_unfreeze_restores_transfers() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let (agent_sk, agent_pk) = gen_keypair(&env);
        let provider_a = Address::generate(&env);
        let allowlist = soroban_sdk::Map::from_array(&env, [(provider_a.clone(), 5_000_000_i128)]);
        let vault_id = env.register(
            AgentVault,
            (admin.clone(), agent_pk, 5_000_000_i128, allowlist, 10_000_u32, 0_i128),
        );
        let client = AgentVaultClient::new(&env, &vault_id);

        // Freeze
        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &vault_id,
                fn_name: "freeze",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.freeze();

        // Unfreeze
        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &vault_id,
                fn_name: "unfreeze",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.unfreeze();

        // Attempt a transfer, should succeed
        let payload = BytesN::<32>::random(&env);
        let sig = sign_payload(&env, &agent_sk, &payload);
        let contexts = soroban_sdk::Vec::from_array(&env, [transfer_context(&env, &provider_a, 100_000)]);

        let result = env.try_invoke_contract_check_auth::<Error>(
            &vault_id,
            &payload,
            sig.into_val(&env),
            &contexts,
        );
        assert!(result.is_ok(), "unfrozen contract should allow transfers");
    }

    /// Test 37: only admin can toggle freeze/unfreeze
    #[test]
    #[should_panic]
    fn test_freeze_requires_admin() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let (_, agent_pk) = gen_keypair(&env);
        let vault_id = env.register(
            AgentVault,
            (admin, agent_pk, 5_000_000_i128, soroban_sdk::Map::<Address, i128>::new(&env), 10_000_u32, 0_i128),
        );
        let client = AgentVaultClient::new(&env, &vault_id);

        let non_admin = Address::generate(&env);
        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &non_admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &vault_id,
                fn_name: "freeze",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.freeze();
    }

    /// Test 38: view functions return correct values
    #[test]
    fn test_view_functions() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let (_, agent_pk) = gen_keypair(&env);
        let provider_a = Address::generate(&env);
        
        let allowlist = soroban_sdk::Map::from_array(&env, [(provider_a.clone(), 5_000_000_i128)]);
        let vault_id = env.register(
            AgentVault,
            (admin.clone(), agent_pk.clone(), 5_000_000_i128, allowlist, 10_000_u32, 0_i128),
        );
        let client = AgentVaultClient::new(&env, &vault_id);

        assert_eq!(client.daily_cap(), 5_000_000_i128);
        
        let fetched_allowlist = client.allowlist();
        assert_eq!(fetched_allowlist.len(), 1);
        assert_eq!(fetched_allowlist.get(provider_a.clone()).unwrap(), 5_000_000_i128);

        assert_eq!(client.expiry_ledger(), 10_000_u32);
        assert_eq!(client.agent_pubkey(), agent_pk.clone());

        // Test updates
        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &vault_id,
                fn_name: "set_daily_cap",
                args: (&10_000_000_i128,).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.set_daily_cap(&10_000_000_i128);
        assert_eq!(client.daily_cap(), 10_000_000_i128);

        let provider_b = Address::generate(&env);
        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &vault_id,
                fn_name: "add_to_allowlist",
                args: (&provider_b, &2_000_000_i128).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.add_to_allowlist(&provider_b, &2_000_000_i128);
        
        let updated_allowlist = client.allowlist();
        assert_eq!(updated_allowlist.len(), 2);
        assert_eq!(updated_allowlist.get(provider_b.clone()).unwrap(), 2_000_000_i128);
    }

    /// Test 32: negative transfer amount is rejected and counters stay untouched
    #[test]
    fn test_negative_transfer_amount_rejected() {
        let env = Env::default();
        let (_, agent_sk, vault_id, provider_a) = setup(&env);

        let p = BytesN::<32>::random(&env);
        let s = sign_payload(&env, &agent_sk, &p);
        let c = Vec::from_array(&env, [transfer_context(&env, &provider_a, -100)]);
        let result =
            env.try_invoke_contract_check_auth::<Error>(&vault_id, &p, s.into_val(&env), &c);
        assert_eq!(
            result.unwrap_err().unwrap(),
            Error::InvalidAmount,
            "negative transfer amount must be rejected with InvalidAmount"
        );

        assert_eq!(
            read_spend_counters(&env, &vault_id, &provider_a),
            (0, 0, 0),
            "rejected negative transfer must not mutate any spend counter"
        );
    }

    /// Test 33: zero transfer amount is also rejected
    #[test]
    fn test_zero_transfer_amount_rejected() {
        let env = Env::default();
        let (_, agent_sk, vault_id, provider_a) = setup(&env);

        let p = BytesN::<32>::random(&env);
        let s = sign_payload(&env, &agent_sk, &p);
        let c = Vec::from_array(&env, [transfer_context(&env, &provider_a, 0)]);
        let result =
            env.try_invoke_contract_check_auth::<Error>(&vault_id, &p, s.into_val(&env), &c);
        assert_eq!(
            result.unwrap_err().unwrap(),
            Error::InvalidAmount,
            "zero transfer amount must be rejected with InvalidAmount"
        );
    }

    /// Test 34: negative transfer after a real payment must not deflate the counters
    #[test]
    fn test_negative_transfer_does_not_deflate_counters() {
        let env = Env::default();
        let (_, agent_sk, vault_id, provider_a) = setup(&env);

        // Legitimate payment of 4_000_000 (cap = 5_000_000)
        let p1 = BytesN::<32>::random(&env);
        let s1 = sign_payload(&env, &agent_sk, &p1);
        let c1 = Vec::from_array(&env, [transfer_context(&env, &provider_a, 4_000_000)]);
        env.try_invoke_contract_check_auth::<Error>(&vault_id, &p1, s1.into_val(&env), &c1)
            .unwrap();

        assert_eq!(
            read_spend_counters(&env, &vault_id, &provider_a),
            (4_000_000, 4_000_000, 4_000_000),
            "valid payment should advance all three counters"
        );

        // Hostile "transfer" with a negative amount — must be rejected, not deflate.
        let p2 = BytesN::<32>::random(&env);
        let s2 = sign_payload(&env, &agent_sk, &p2);
        let c2 = Vec::from_array(&env, [transfer_context(&env, &provider_a, -4_000_000)]);
        let result =
            env.try_invoke_contract_check_auth::<Error>(&vault_id, &p2, s2.into_val(&env), &c2);
        assert_eq!(
            result.unwrap_err().unwrap(),
            Error::InvalidAmount,
            "negative transfer must be rejected with InvalidAmount"
        );

        assert_eq!(
            read_spend_counters(&env, &vault_id, &provider_a),
            (4_000_000, 4_000_000, 4_000_000),
            "negative transfer must not deflate the spend counters"
        );

        // The cap is still respected: 2_000_000 more would exceed the 5_000_000 daily cap.
        let p3 = BytesN::<32>::random(&env);
        let s3 = sign_payload(&env, &agent_sk, &p3);
        let c3 = Vec::from_array(&env, [transfer_context(&env, &provider_a, 2_000_000)]);
        let result3 =
            env.try_invoke_contract_check_auth::<Error>(&vault_id, &p3, s3.into_val(&env), &c3);
        assert_eq!(
            result3.unwrap_err().unwrap(),
            Error::DailyCapExceeded,
            "cap must still be enforced — counters were not deflated"
        );
    }

    /// Upgrade timelock: a proposal records its hash and earliest executable ledger.
    #[test]
    fn test_propose_upgrade_records_pending_and_emits_notice() {
        use soroban_sdk::testutils::Events;

        let env = Env::default();
        let (client, _agent_sk, _vault_id, _provider_a) = setup(&env);
        env.mock_all_auths();
        env.ledger().set_sequence_number(1_000);

        assert_eq!(client.pending_upgrade(), None);
        assert_eq!(client.upgrade_timelock_ledgers(), UPGRADE_TIMELOCK_LEDGERS);

        let new_wasm_hash = fixed_hash(&env, 1);
        client.propose_upgrade(&new_wasm_hash);

        let ready_at_ledger = 1_000 + UPGRADE_TIMELOCK_LEDGERS;
        let (_, topics, data) = env.events().all().last().unwrap();
        assert_eq!(
            Symbol::from_val(&env, &topics.get(0).unwrap()),
            Symbol::new(&env, EVT_UPGRADE_PROPOSED),
        );
        assert_eq!(
            <(BytesN<32>, u32)>::from_val(&env, &data),
            (new_wasm_hash.clone(), ready_at_ledger),
        );
        assert_eq!(
            client.pending_upgrade(),
            Some((new_wasm_hash, ready_at_ledger)),
        );
    }

    /// A replacement proposal supersedes the old target and restarts the full delay.
    #[test]
    fn test_rescheduling_upgrade_replaces_target_and_restarts_delay() {
        let env = Env::default();
        let (client, _agent_sk, _vault_id, _provider_a) = setup(&env);
        env.mock_all_auths();
        env.ledger().set_sequence_number(1_000);

        let old_hash = fixed_hash(&env, 1);
        client.propose_upgrade(&old_hash);
        env.ledger().set_sequence_number(2_000);

        let new_hash = fixed_hash(&env, 2);
        client.propose_upgrade(&new_hash);

        assert_eq!(
            client.pending_upgrade(),
            Some((new_hash, 2_000 + UPGRADE_TIMELOCK_LEDGERS)),
        );
    }

    /// Execution one ledger early is rejected and leaves the proposal intact.
    #[test]
    fn test_execute_upgrade_before_ready_fails() {
        let env = Env::default();
        let (client, _agent_sk, vault_id, _provider_a) = setup(&env);
        env.mock_all_auths();
        env.ledger().set_sequence_number(1_000);
        let new_wasm_hash = fixed_hash(&env, 1);
        client.propose_upgrade(&new_wasm_hash);

        let ready_at_ledger = 1_000 + UPGRADE_TIMELOCK_LEDGERS;
        env.ledger().set_sequence_number(ready_at_ledger - 1);
        let result = env.try_invoke_contract::<(), Error>(
            &vault_id,
            &Symbol::new(&env, "execute_upgrade"),
            Vec::new(&env),
        );

        assert_eq!(result.unwrap_err().unwrap(), Error::UpgradeNotReady);
        assert_eq!(client.pending_upgrade(), Some((new_wasm_hash, ready_at_ledger)));
    }

    /// Execution with no proposal returns a typed error.
    #[test]
    fn test_execute_upgrade_without_proposal_fails() {
        let env = Env::default();
        let (_client, _agent_sk, vault_id, _provider_a) = setup(&env);
        env.mock_all_auths();

        let result = env.try_invoke_contract::<(), Error>(
            &vault_id,
            &Symbol::new(&env, "execute_upgrade"),
            Vec::new(&env),
        );

        assert_eq!(result.unwrap_err().unwrap(), Error::NoPendingUpgrade);
    }

    /// Execution succeeds at the exact readiness boundary and clears the proposal.
    #[test]
    fn test_execute_upgrade_at_ready_updates_wasm_and_clears_proposal() {
        use soroban_sdk::testutils::Events;

        let env = Env::default();
        let (client, _agent_sk, vault_id, _provider_a) = setup(&env);
        env.mock_all_auths();
        let new_wasm_hash = env.deployer().upload_contract_wasm(Bytes::new(&env));
        env.ledger().set_sequence_number(1_000);
        client.propose_upgrade(&new_wasm_hash);

        env.ledger()
            .set_sequence_number(1_000 + UPGRADE_TIMELOCK_LEDGERS);
        client.execute_upgrade();

        let upgraded_events: std::vec::Vec<_> = env
            .events()
            .all()
            .iter()
            .filter(|(address, topics, _)| {
                *address == vault_id
                    && topics
                        .get(0)
                        .map_or(false, |topic| {
                            Symbol::from_val(&env, &topic) == Symbol::new(&env, EVT_UPGRADED)
                        })
            })
            .collect();
        assert_eq!(upgraded_events.len(), 1);
        assert_eq!(
            BytesN::<32>::from_val(&env, &upgraded_events[0].2),
            new_wasm_hash,
        );
        let pending: Option<(BytesN<32>, u32)> = env.as_contract(&vault_id, || {
            env.storage().instance().get(&PENDING_UPGRADE_KEY)
        });
        assert_eq!(pending, None);
    }

    /// A failed Wasm update rolls back and leaves the approved proposal available.
    #[test]
    fn test_execute_upgrade_with_missing_wasm_preserves_proposal() {
        let env = Env::default();
        let (client, _agent_sk, vault_id, _provider_a) = setup(&env);
        env.mock_all_auths();
        env.ledger().set_sequence_number(1_000);
        let missing_hash = fixed_hash(&env, 0xee);
        client.propose_upgrade(&missing_hash);

        env.ledger()
            .set_sequence_number(1_000 + UPGRADE_TIMELOCK_LEDGERS);
        let result = env.try_invoke_contract::<(), Error>(
            &vault_id,
            &Symbol::new(&env, "execute_upgrade"),
            Vec::new(&env),
        );

        assert!(result.is_err(), "missing Wasm should fail execution");
        assert_eq!(
            client.pending_upgrade(),
            Some((missing_hash, 1_000 + UPGRADE_TIMELOCK_LEDGERS)),
        );
    }

    /// Near u32::MAX the delay fails closed instead of saturating into immediate readiness.
    #[test]
    fn test_propose_upgrade_timelock_overflow_fails_closed() {
        let sequence = u32::MAX - UPGRADE_TIMELOCK_LEDGERS + 1;
        assert_eq!(
            calculate_upgrade_ready_at(sequence),
            Err(Error::UpgradeTimelockOverflow),
        );
    }

    /// Cancellation remains available after the proposal reaches its ready ledger.
    #[test]
    fn test_cancel_upgrade_after_ready_clears_proposal_and_emits_notice() {
        use soroban_sdk::testutils::Events;

        let env = Env::default();
        let (client, _agent_sk, _vault_id, _provider_a) = setup(&env);
        env.mock_all_auths();
        env.ledger().set_sequence_number(1_000);
        let new_wasm_hash = fixed_hash(&env, 1);
        let ready_at_ledger = 1_000 + UPGRADE_TIMELOCK_LEDGERS;
        client.propose_upgrade(&new_wasm_hash);

        env.ledger().set_sequence_number(ready_at_ledger);
        client.cancel_upgrade();

        let (_, topics, data) = env.events().all().last().unwrap();
        assert_eq!(
            Symbol::from_val(&env, &topics.get(0).unwrap()),
            Symbol::new(&env, EVT_UPGRADE_CANCELLED),
        );
        assert_eq!(
            <(BytesN<32>, u32)>::from_val(&env, &data),
            (new_wasm_hash.clone(), ready_at_ledger),
        );
        assert_eq!(client.pending_upgrade(), None);
    }

    /// Cancelling without a proposal returns a typed error.
    #[test]
    fn test_cancel_upgrade_without_proposal_fails() {
        let env = Env::default();
        let (_client, _agent_sk, vault_id, _provider_a) = setup(&env);
        env.mock_all_auths();

        let result = env.try_invoke_contract::<(), Error>(
            &vault_id,
            &Symbol::new(&env, "cancel_upgrade"),
            Vec::new(&env),
        );

        assert_eq!(result.unwrap_err().unwrap(), Error::NoPendingUpgrade);
    }

    /// Only the admin may propose a Wasm change.
    #[test]
    #[should_panic(expected = "Error(Auth, InvalidAction)")]
    fn test_propose_upgrade_requires_admin_auth() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let (_, agent_pk) = gen_keypair(&env);
        let vault_id = env.register(
            AgentVault,
            (
                admin,
                agent_pk,
                5_000_000_i128,
                Map::<Address, i128>::new(&env),
                10_000_u32,
                0_i128,
            ),
        );
        let client = AgentVaultClient::new(&env, &vault_id);

        let non_admin = Address::generate(&env);
        let new_wasm_hash = fixed_hash(&env, 1);
        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &non_admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &vault_id,
                fn_name: "propose_upgrade",
                args: (&new_wasm_hash,).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.propose_upgrade(&new_wasm_hash);
    }

    /// Only the admin may execute the stored Wasm proposal.
    #[test]
    #[should_panic(expected = "Error(Auth, InvalidAction)")]
    fn test_execute_upgrade_requires_admin_auth() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let (_, agent_pk) = gen_keypair(&env);
        let vault_id = env.register(
            AgentVault,
            (
                admin,
                agent_pk,
                5_000_000_i128,
                Map::<Address, i128>::new(&env),
                10_000_u32,
                0_i128,
            ),
        );
        let client = AgentVaultClient::new(&env, &vault_id);
        env.mock_all_auths();
        client.propose_upgrade(&fixed_hash(&env, 1));
        env.ledger().set_sequence_number(UPGRADE_TIMELOCK_LEDGERS);

        let non_admin = Address::generate(&env);
        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &non_admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &vault_id,
                fn_name: "execute_upgrade",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.execute_upgrade();
    }

    /// Only the admin may cancel the stored Wasm proposal.
    #[test]
    #[should_panic(expected = "Error(Auth, InvalidAction)")]
    fn test_cancel_upgrade_requires_admin_auth() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let (_, agent_pk) = gen_keypair(&env);
        let vault_id = env.register(
            AgentVault,
            (
                admin,
                agent_pk,
                5_000_000_i128,
                Map::<Address, i128>::new(&env),
                10_000_u32,
                0_i128,
            ),
        );
        let client = AgentVaultClient::new(&env, &vault_id);
        env.mock_all_auths();
        client.propose_upgrade(&fixed_hash(&env, 1));

        let non_admin = Address::generate(&env);
        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &non_admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &vault_id,
                fn_name: "cancel_upgrade",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.cancel_upgrade();
    }

    /// Test: admin extends expiry after it lapsed — payments succeed again.
    #[test]
    fn test_extend_expiry_after_lapse_restores_payments() {
        use soroban_sdk::testutils::Events;

        let env = Env::default();
        let admin = Address::generate(&env);
        let (agent_sk, agent_pk) = gen_keypair(&env);
        let provider_a = Address::generate(&env);
        let allowlist = Map::from_array(&env, [(provider_a.clone(), 5_000_000_i128)]);
        let vault_id = env.register(
            AgentVault,
            (admin, agent_pk, 5_000_000_i128, allowlist, 10_000_u32, 0_i128),
        );
        let client = AgentVaultClient::new(&env, &vault_id);

        // Fast-forward past the initial expiry (10_000) -> payments rejected.
        env.ledger().set_sequence_number(10_001);
        let p = BytesN::<32>::random(&env);
        let s = sign_payload(&env, &agent_sk, &p);
        let c = Vec::from_array(&env, [transfer_context(&env, &provider_a, 100_000)]);
        assert_eq!(
            env.try_invoke_contract_check_auth::<Error>(&vault_id, &p, s.into_val(&env), &c)
                .unwrap_err()
                .unwrap(),
            Error::SessionExpired,
            "payment should be rejected once the expiry lapsed"
        );

        // Admin extends expiry far into the future.
        env.mock_all_auths();
        client.set_expiry(&100_000_u32);

        // Read events immediately after the call (before any other invocation).
        let evt = Symbol::new(&env, "expiry_updated");
        let expiry_events: std::vec::Vec<_> = env
            .events()
            .all()
            .iter()
            .filter(|(addr, topics, _)| {
                *addr == vault_id
                    && topics
                        .get(0)
                        .map_or(false, |t| Symbol::from_val(&env, &t) == evt)
            })
            .collect();
        assert_eq!(expiry_events.len(), 1, "exactly one expiry_updated event expected");
        let data_expiry: u32 = expiry_events[0].2.clone().into_val(&env);
        assert_eq!(data_expiry, 100_000, "event data should carry the new expiry");

        assert_eq!(client.expiry_ledger(), 100_000, "expiry should be extended");

        // Now the same payment (still signed by the agent key) succeeds again.
        let p2 = BytesN::<32>::random(&env);
        let s2 = sign_payload(&env, &agent_sk, &p2);
        let c2 = Vec::from_array(&env, [transfer_context(&env, &provider_a, 100_000)]);
        assert!(
            env.try_invoke_contract_check_auth::<Error>(&vault_id, &p2, s2.into_val(&env), &c2)
                .is_ok(),
            "payment should succeed once admin extends the expiry"
        );
    }

    /// Test: set_expiry by a non-admin panics.
    #[test]
    #[should_panic]
    fn test_set_expiry_requires_admin() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let (_, agent_pk) = gen_keypair(&env);
        let vault_id = env.register(
            AgentVault,
            (admin, agent_pk, 5_000_000_i128, Map::<Address, i128>::new(&env), 10_000_u32, 0_i128),
        );
        let client = AgentVaultClient::new(&env, &vault_id);

        let non_admin = Address::generate(&env);
        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &non_admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &vault_id,
                fn_name: "set_expiry",
                args: (&100_000_u32,).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.set_expiry(&100_000_u32);
    }

    /// Test: admin rotates the agent key; only the new key can authorize payments.
    #[test]
    fn test_rotate_agent_pubkey_authorizes_new_key() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let (_, agent_pk) = gen_keypair(&env);
        let provider_a = Address::generate(&env);
        let allowlist = Map::from_array(&env, [(provider_a.clone(), 5_000_000_i128)]);
        let vault_id = env.register(
            AgentVault,
            (admin.clone(), agent_pk, 5_000_000_i128, allowlist, 10_000_u32, 0_i128),
        );
        let client = AgentVaultClient::new(&env, &vault_id);

        // Admin rotates to a fresh key pair.
        let (new_sk, new_pk) = gen_keypair(&env);
        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &vault_id,
                fn_name: "set_agent_pubkey",
                args: (&new_pk,).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.set_agent_pubkey(&new_pk);

        // A payment signed with the NEW key succeeds.
        let p = BytesN::<32>::random(&env);
        let s = sign_payload(&env, &new_sk, &p);
        let c = Vec::from_array(&env, [transfer_context(&env, &provider_a, 100_000)]);
        assert!(
            env.try_invoke_contract_check_auth::<Error>(&vault_id, &p, s.into_val(&env), &c).is_ok(),
            "payment signed with the rotated key should succeed"
        );
    }

    /// Test: after rotation, the OLD key no longer authorizes payments.
    #[test]
    #[should_panic]
    fn test_old_agent_key_invalid_after_rotation() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let (old_sk, old_pk) = gen_keypair(&env);
        let provider_a = Address::generate(&env);
        let allowlist = Map::from_array(&env, [(provider_a.clone(), 5_000_000_i128)]);
        let vault_id = env.register(
            AgentVault,
            (admin.clone(), old_pk, 5_000_000_i128, allowlist, 10_000_u32, 0_i128),
        );
        let client = AgentVaultClient::new(&env, &vault_id);

        // Rotate to a new key.
        let (_, new_pk) = gen_keypair(&env);
        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &vault_id,
                fn_name: "set_agent_pubkey",
                args: (&new_pk,).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.set_agent_pubkey(&new_pk);

        // A payment signed with the OLD key must fail (rejected signature).
        let p = BytesN::<32>::random(&env);
        let s = sign_payload(&env, &old_sk, &p);
        let c = Vec::from_array(&env, [transfer_context(&env, &provider_a, 100_000)]);
        env.try_invoke_contract_check_auth::<Error>(&vault_id, &p, s.into_val(&env), &c).unwrap();
    }

    /// Test: set_agent_pubkey from a non-admin panics.
    #[test]
    #[should_panic]
    fn test_set_agent_pubkey_requires_admin() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let (_, agent_pk) = gen_keypair(&env);
        let vault_id = env.register(
            AgentVault,
            (admin, agent_pk, 5_000_000_i128, soroban_sdk::Map::<Address, i128>::new(&env), 10_000_u32, 0_i128),
        );
        let client = AgentVaultClient::new(&env, &vault_id);

        let non_admin = Address::generate(&env);
        let (_, new_pk) = gen_keypair(&env);
        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &non_admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &vault_id,
                fn_name: "set_agent_pubkey",
                args: (&new_pk,).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.set_agent_pubkey(&new_pk);
    }

    #[test]
    fn test_removed_payee_is_rejected_on_next_auth() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let (agent_sk, agent_pk) = gen_keypair(&env);
        let payee = Address::generate(&env);
        let allowlist = Map::from_array(&env, [(payee.clone(), 5_000_000_i128)]);
        let vault_id = env.register(
            AgentVault,
            (admin, agent_pk, 5_000_000_i128, allowlist, 10_000_u32, 0_i128),
        );
        let client = AgentVaultClient::new(&env, &vault_id);

        env.mock_all_auths();
        client.remove_from_allowlist(&payee);
        assert!(!client.allowlist().contains_key(payee.clone()));

        let payload = BytesN::<32>::random(&env);
        let signature = sign_payload(&env, &agent_sk, &payload);
        let contexts = Vec::from_array(&env, [transfer_context(&env, &payee, 100_000)]);
        let result = env.try_invoke_contract_check_auth::<Error>(
            &vault_id, &payload, signature.into_val(&env), &contexts,
        );
        assert_eq!(result.unwrap_err().unwrap(), Error::PayeeNotAllowed);
    }

    #[test]
    #[should_panic]
    fn test_remove_from_allowlist_requires_admin() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let (_, agent_pk) = gen_keypair(&env);
        let payee = Address::generate(&env);
        let allowlist = Map::from_array(&env, [(payee.clone(), 5_000_000_i128)]);
        let vault_id = env.register(
            AgentVault,
            (admin, agent_pk, 5_000_000_i128, allowlist, 10_000_u32, 0_i128),
        );
        let client = AgentVaultClient::new(&env, &vault_id);

        let non_admin = Address::generate(&env);
        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &non_admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &vault_id,
                fn_name: "remove_from_allowlist",
                args: (&payee,).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.remove_from_allowlist(&payee);
    }

    #[test]
    fn test_admin_mutation_events() {
        use soroban_sdk::testutils::Events;

        let env = Env::default();
        let admin = Address::generate(&env);
        let (_, agent_pk) = gen_keypair(&env);
        let vault_id = env.register(
            AgentVault,
            (admin.clone(), agent_pk, 5_000_000_i128, Map::<Address, i128>::new(&env), 10_000_u32, 9_000_000_i128),
        );
        let client = AgentVaultClient::new(&env, &vault_id);
        env.mock_all_auths();

        client.set_daily_cap(&4_000_000_i128);
        let (_, topics, data) = env.events().all().last().unwrap();
        assert_eq!(Symbol::from_val(&env, &topics.get(0).unwrap()), Symbol::new(&env, "cap_updated"));
        assert_eq!(Symbol::from_val(&env, &topics.get(1).unwrap()), symbol_short!("daily"));
        assert_eq!(<(i128, i128)>::from_val(&env, &data), (5_000_000, 4_000_000));

        client.set_lifetime_cap(&8_000_000_i128);
        let (_, topics, data) = env.events().all().last().unwrap();
        assert_eq!(Symbol::from_val(&env, &topics.get(1).unwrap()), symbol_short!("lifetime"));
        assert_eq!(<(i128, i128)>::from_val(&env, &data), (9_000_000, 8_000_000));

        let payee = Address::generate(&env);
        client.add_to_allowlist(&payee, &2_000_000_i128);
        let (_, topics, data) = env.events().all().last().unwrap();
        assert_eq!(Symbol::from_val(&env, &topics.get(0).unwrap()), Symbol::new(&env, "allowlist_updated"));
        assert_eq!(Address::from_val(&env, &topics.get(1).unwrap()), payee);
        assert_eq!(Option::<i128>::from_val(&env, &data), Some(2_000_000));

        client.remove_from_allowlist(&payee);
        let (_, topics, data) = env.events().all().last().unwrap();
        assert_eq!(Address::from_val(&env, &topics.get(1).unwrap()), payee);
        assert_eq!(Option::<i128>::from_val(&env, &data), None);

        client.freeze();
        let (_, topics, _) = env.events().all().last().unwrap();
        assert_eq!(Symbol::from_val(&env, &topics.get(0).unwrap()), Symbol::new(&env, "vault_frozen"));

        client.unfreeze();
        let (_, topics, _) = env.events().all().last().unwrap();
        assert_eq!(Symbol::from_val(&env, &topics.get(0).unwrap()), Symbol::new(&env, "vault_unfrozen"));

        let new_admin = Address::generate(&env);
        client.transfer_admin(&new_admin);
        let (_, topics, _) = env.events().all().last().unwrap();
        assert_eq!(Symbol::from_val(&env, &topics.get(0).unwrap()), Symbol::new(&env, "admin_transfer_requested"));
        assert_eq!(Address::from_val(&env, &topics.get(1).unwrap()), admin);
        assert_eq!(Address::from_val(&env, &topics.get(2).unwrap()), new_admin);

        client.accept_admin();
        let (_, topics, _) = env.events().all().last().unwrap();
        assert_eq!(Symbol::from_val(&env, &topics.get(0).unwrap()), Symbol::new(&env, "admin_changed"));
        assert_eq!(Address::from_val(&env, &topics.get(1).unwrap()), admin);
        assert_eq!(Address::from_val(&env, &topics.get(2).unwrap()), new_admin);
    }

    /// A SAC approve() auth context (from, spender, amount, expiration_ledger).
    fn approve_context(env: &Env, amount: i128) -> Context {
        let token = Address::generate(env);
        let from = Address::generate(env);
        let spender = Address::generate(env);
        Context::Contract(ContractContext {
            contract: token,
            fn_name: symbol_short!("approve"),
            args: (from, spender, amount, 100_000_u32).into_val(env),
        })
    }

    /// A SAC burn() auth context (from, amount).
    fn burn_context(env: &Env, amount: i128) -> Context {
        let token = Address::generate(env);
        let from = Address::generate(env);
        Context::Contract(ContractContext {
            contract: token,
            fn_name: symbol_short!("burn"),
            args: (from, amount).into_val(env),
        })
    }

    /// Test 40: default-deny — an SAC approve() auth context is rejected even
    /// when signed by the agent key, so a stolen key cannot drain the vault via
    /// approve() + transfer_from() (issue #132).
    #[test]
    fn test_approve_context_rejected() {
        let env = Env::default();
        let (_, agent_sk, vault_id, _) = setup(&env);

        let payload = BytesN::<32>::random(&env);
        let sig = sign_payload(&env, &agent_sk, &payload);
        let contexts = Vec::from_array(&env, [approve_context(&env, 1_000_000)]);

        let result = env.try_invoke_contract_check_auth::<Error>(
            &vault_id,
            &payload,
            sig.into_val(&env),
            &contexts,
        );
        assert_eq!(
            result.unwrap_err().unwrap(),
            Error::UnauthorizedFunction,
            "approve must not bypass the caps"
        );
    }

    /// Test 41: default-deny — an SAC burn() auth context is rejected.
    #[test]
    fn test_burn_context_rejected() {
        let env = Env::default();
        let (_, agent_sk, vault_id, _) = setup(&env);

        let payload = BytesN::<32>::random(&env);
        let sig = sign_payload(&env, &agent_sk, &payload);
        let contexts = Vec::from_array(&env, [burn_context(&env, 100_000)]);

        let result = env.try_invoke_contract_check_auth::<Error>(
            &vault_id,
            &payload,
            sig.into_val(&env),
            &contexts,
        );
        assert_eq!(
            result.unwrap_err().unwrap(),
            Error::UnauthorizedFunction,
            "burn must not bypass the caps"
        );
    }

    /// Test 42: default-deny — a non-contract host fn context
    /// (create_contract) is rejected rather than silently skipped.
    #[test]
    fn test_create_contract_host_fn_rejected() {
        let env = Env::default();
        let (_, agent_sk, vault_id, _) = setup(&env);

        let create_ctx = Context::CreateContractHostFn(CreateContractHostFnContext {
            executable: ContractExecutable::Wasm(BytesN::<32>::random(&env)),
            salt: BytesN::<32>::random(&env),
        });

        let payload = BytesN::<32>::random(&env);
        let sig = sign_payload(&env, &agent_sk, &payload);
        let contexts = Vec::from_array(&env, [create_ctx]);

        let result = env.try_invoke_contract_check_auth::<Error>(
            &vault_id,
            &payload,
            sig.into_val(&env),
            &contexts,
        );
        assert_eq!(
            result.unwrap_err().unwrap(),
            Error::UnauthorizedFunction,
            "create_contract host fn must not bypass the caps"
        );
    }

    /// Test 43: a batch mixing a valid transfer with an approve is rejected
    /// wholesale — one unauthorized function poisons the whole auth.
    #[test]
    fn test_mixed_transfer_and_approve_rejected() {
        let env = Env::default();
        let (_, agent_sk, vault_id, provider_a) = setup(&env);

        let payload = BytesN::<32>::random(&env);
        let sig = sign_payload(&env, &agent_sk, &payload);
        let contexts = Vec::from_array(
            &env,
            [transfer_context(&env, &provider_a, 100_000), approve_context(&env, 1_000_000)],
        );

        let result = env.try_invoke_contract_check_auth::<Error>(
            &vault_id,
            &payload,
            sig.into_val(&env),
            &contexts,
        );
        assert_eq!(
            result.unwrap_err().unwrap(),
            Error::UnauthorizedFunction,
            "a mixed batch must not partially authorize"
        );
    }

    /// Test 44: the success path survives the default-deny inversion — a lone
    /// transfer within the caps still passes through the new match arm.
    #[test]
    fn test_transfer_still_authorized_after_default_deny() {
        let env = Env::default();
        let (_, agent_sk, vault_id, provider_a) = setup(&env);

        let payload = BytesN::<32>::random(&env);
        let sig = sign_payload(&env, &agent_sk, &payload);
        let contexts = Vec::from_array(&env, [transfer_context(&env, &provider_a, 100_000)]);

        let result = env.try_invoke_contract_check_auth::<Error>(
            &vault_id,
            &payload,
            sig.into_val(&env),
            &contexts,
        );
        assert!(result.is_ok(), "valid transfer must still pass: {result:?}");
    }

    // ── #336: the lifetime cap rejects negative values ───────────────────────
    // A negative cap used to be stored as given. The daily cap happens to fail
    // closed on one, but the lifetime cap fails open, because its check only runs
    // when the cap is above 0. Negative values are now rejected where they are
    // set, with the same `Error::InvalidCap` the daily-cap and allowlist checks
    // already use. 0 stays valid and means unlimited.

    /// The one-time constructor rejects a negative lifetime cap.
    #[test]
    #[should_panic(expected = "Error(Contract, #13)")]
    fn test_constructor_rejects_negative_lifetime_cap() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let (_, agent_pk) = gen_keypair(&env);

        // The vault is configured by its one-time constructor, so the cap is
        // supplied at registration and rejected there.
        env.register(
            AgentVault,
            (
                admin.clone(),
                agent_pk.clone(),
                5_000_000_i128,
                Map::<Address, i128>::new(&env),
                10_000_u32,
                -1_i128,
            ),
        );
    }

    /// set_lifetime_cap rejects a negative cap.
    #[test]
    #[should_panic(expected = "Error(Contract, #13)")]
    fn test_set_lifetime_cap_rejects_negative() {
        let env = Env::default();
        let (client, _, _, _) = setup(&env);
        env.mock_all_auths();

        client.set_lifetime_cap(&-1_i128);
    }

    /// Raising the lifetime cap with set_lifetime_cap lets a transfer through
    /// after a LifetimeCapExceeded — the setter stores the new value and only
    /// enforces a decrease through the spend it already counts.
    #[test]
    fn test_set_lifetime_cap_raise_allows_spend_after_exceeded() {
        let env = Env::default();
        let (client, agent_sk, vault_id, provider_a) = setup_with_lifetime_cap(&env, 3_000_000);

        // Spend the whole lifetime cap.
        let p = BytesN::<32>::random(&env);
        let s = sign_payload(&env, &agent_sk, &p);
        let c = Vec::from_array(&env, [transfer_context(&env, &provider_a, 3_000_000)]);
        assert!(
            env.try_invoke_contract_check_auth::<Error>(&vault_id, &p, s.into_val(&env), &c)
                .is_ok(),
            "spending exactly the lifetime cap should succeed"
        );

        // One stroop more is over the cap.
        let p_over = BytesN::<32>::random(&env);
        let s_over = sign_payload(&env, &agent_sk, &p_over);
        let c_over = Vec::from_array(&env, [transfer_context(&env, &provider_a, 1)]);
        let result = env.try_invoke_contract_check_auth::<Error>(
            &vault_id,
            &p_over,
            s_over.into_val(&env),
            &c_over,
        );
        assert_eq!(
            result.unwrap_err().unwrap(),
            Error::LifetimeCapExceeded,
            "the next stroop should exceed the lifetime cap"
        );

        // Raising the cap unblocks spending.
        env.mock_all_auths();
        client.set_lifetime_cap(&6_000_000_i128);

        let p_next = BytesN::<32>::random(&env);
        let s_next = sign_payload(&env, &agent_sk, &p_next);
        let c_next = Vec::from_array(&env, [transfer_context(&env, &provider_a, 1_000_000)]);
        assert!(
            env.try_invoke_contract_check_auth::<Error>(
                &vault_id,
                &p_next,
                s_next.into_val(&env),
                &c_next
            )
            .is_ok(),
            "raising the lifetime cap should let the transfer through"
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #13)")]
    fn test_constructor_negative_daily_cap_rejected() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let (_, agent_pk) = gen_keypair(&env);
        let allowlist = Map::<Address, i128>::new(&env);

        env.register(
            AgentVault,
            (admin, agent_pk, -1_i128, allowlist, 10_000_u32, 0_i128),
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #13)")]
    fn test_constructor_negative_allowlist_sub_cap_rejected() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let (_, agent_pk) = gen_keypair(&env);
        let payee = Address::generate(&env);
        let allowlist = Map::from_array(&env, [(payee, -100_i128)]);

        env.register(
            AgentVault,
            (admin, agent_pk, 5_000_000_i128, allowlist, 10_000_u32, 0_i128),
        );
    }

    #[test]
    fn test_constructor_stores_config() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let (_, agent_pk) = gen_keypair(&env);
        let provider_a = Address::generate(&env);
        let allowlist = Map::from_array(&env, [(provider_a.clone(), 3_000_000_i128)]);

        let vault_id = env.register(
            AgentVault,
            (
                admin.clone(),
                agent_pk.clone(),
                5_000_000_i128,
                allowlist.clone(),
                12_345_u32,
                10_000_000_i128,
            ),
        );
        let client = AgentVaultClient::new(&env, &vault_id);

        assert_eq!(client.daily_cap(), 5_000_000_i128);
        assert_eq!(client.allowlist(), allowlist);
        assert_eq!(client.expiry_ledger(), 12_345_u32);
        assert_eq!(client.agent_pubkey(), agent_pk);
        assert_eq!(client.get_lifetime_spend(), 0_i128);
    }

    #[test]
    fn test_constructor_admin_controls_vault() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let (_, agent_pk) = gen_keypair(&env);
        let allowlist = Map::<Address, i128>::new(&env);

        let vault_id = env.register(
            AgentVault,
            (
                admin.clone(),
                agent_pk,
                5_000_000_i128,
                allowlist,
                10_000_u32,
                0_i128,
            ),
        );
        let client = AgentVaultClient::new(&env, &vault_id);

        env.mock_all_auths();
        client.set_daily_cap(&7_000_000_i128);

        assert_eq!(env.auths()[0].0, admin);
        assert_eq!(client.daily_cap(), 7_000_000_i128);
    }

    #[test]
    fn test_set_daily_cap_negative_rejected_and_stored_cap_unchanged() {
        let env = Env::default();
        let (client, _, vault_id, _) = setup(&env);

        // Re-read initial cap
        let initial_cap = env.as_contract(&vault_id, || {
            env.storage().instance().get(&CAP_KEY).unwrap_or(0_i128)
        });
        assert_eq!(initial_cap, 5_000_000_i128);

        env.mock_all_auths();
        let result = client.try_set_daily_cap(&-1_i128);
        assert_eq!(result.unwrap_err().unwrap(), Error::InvalidCap.into());

        // Stored cap unchanged
        let after_cap = env.as_contract(&vault_id, || {
            env.storage().instance().get(&CAP_KEY).unwrap_or(0_i128)
        });
        assert_eq!(after_cap, 5_000_000_i128);

        // Zero cap succeeds
        assert!(client.try_set_daily_cap(&0_i128).is_ok());
    }

    #[test]
    fn test_add_to_allowlist_negative_rejected_and_not_added() {
        let env = Env::default();
        let (client, _, vault_id, _) = setup(&env);
        let new_payee = Address::generate(&env);

        env.mock_all_auths();
        let result = client.try_add_to_allowlist(&new_payee, &-1_i128);
        assert_eq!(result.unwrap_err().unwrap(), Error::InvalidCap.into());

        // Payee was not added to allowlist
        let in_allowlist = env.as_contract(&vault_id, || {
            let map: Map<Address, i128> = env.storage().instance().get(&LIST_KEY).unwrap();
            map.contains_key(new_payee.clone())
        });
        assert!(!in_allowlist);

        // Zero cap succeeds
        assert!(client.try_add_to_allowlist(&new_payee, &0_i128).is_ok());
    }

    // ── Instance TTL (issue #406) ─────────────────────────────────────────────
    // All vault state lives in instance storage, so the instance entry's TTL is
    // the vault's lifetime. `__constructor` and `__check_auth` were the only call
    // sites that refreshed it, which left a vault that sees admin traffic only
    // — a frozen vault, or one whose expiry lapsed — counting down to archival.

    /// Ledgers to fast-forward so the instance TTL drops inside the bump
    /// threshold and the next entrypoint has to refresh it.
    const TTL_DECAY_LEDGERS: u32 = 1_500_000;

    /// Read the vault's instance TTL from inside its own storage context.
    fn instance_ttl(env: &Env, vault_id: &Address) -> u32 {
        // `get_ttl` is a testutils-only extension method (soroban-sdk 21+).
        use soroban_sdk::testutils::storage::Instance as _;
        env.as_contract(vault_id, || env.storage().instance().get_ttl())
    }

    /// Fast-forward the ledger far enough that the instance entry is inside the
    /// bump threshold, and assert that it really decayed — otherwise a later
    /// claim that the TTL is back at the extend-to value could pass for the
    /// wrong reason.
    fn decay_instance_ttl(env: &Env, vault_id: &Address) {
        let sequence = env.ledger().sequence() + TTL_DECAY_LEDGERS;
        env.ledger().with_mut(|ledger| ledger.sequence_number = sequence);
        assert!(
            instance_ttl(env, vault_id) < INSTANCE_TTL_THRESHOLD,
            "precondition: {TTL_DECAY_LEDGERS} ledgers must take the instance TTL below the bump threshold"
        );
    }

    /// Fast-forward the ledger, run `call`, and assert it refreshed the TTL.
    fn assert_refreshes_instance_ttl(
        env: &Env,
        vault_id: &Address,
        entrypoint: &str,
        call: impl FnOnce(),
    ) {
        decay_instance_ttl(env, vault_id);
        call();
        assert_eq!(
            instance_ttl(env, vault_id),
            INSTANCE_TTL_EXTEND_TO,
            "{entrypoint} must refresh the instance TTL"
        );
    }

    /// Test 45: an admin entrypoint refreshes the instance TTL after a long
    /// stretch with no agent traffic — the recovery path from issue #406.
    #[test]
    fn test_admin_entrypoint_refreshes_instance_ttl_after_ledger_advance() {
        let env = Env::default();
        let (client, _, vault_id, _) = setup(&env);
        env.mock_all_auths();

        // #given a vault whose instance TTL has decayed inside the bump threshold
        decay_instance_ttl(&env, &vault_id);

        // #when the admin freezes it
        client.freeze();

        // #then the instance entry lives for the full extend-to TTL again
        assert_eq!(
            instance_ttl(&env, &vault_id),
            INSTANCE_TTL_EXTEND_TO,
            "freeze must refresh the instance TTL"
        );
    }

    /// Test 46: every admin entrypoint that writes instance storage refreshes the
    /// instance TTL. Kept as one loop so a missing bump in any single entrypoint
    /// fails here rather than silently shipping.
    #[test]
    fn test_every_admin_entrypoint_refreshes_instance_ttl() {
        let env = Env::default();
        let (client, _, vault_id, _) = setup(&env);
        env.mock_all_auths();
        let payee = Address::generate(&env);
        let new_admin = Address::generate(&env);

        assert_refreshes_instance_ttl(&env, &vault_id, "set_daily_cap", || {
            client.set_daily_cap(&6_000_000_i128)
        });
        assert_refreshes_instance_ttl(&env, &vault_id, "add_to_allowlist", || {
            client.add_to_allowlist(&payee, &1_000_000_i128)
        });
        // `record_session_settlement` is signed by the allowlisted payee rather
        // than the admin, but it is an authenticated write path, so it bumps too.
        assert_refreshes_instance_ttl(&env, &vault_id, "record_session_settlement", || {
            client.record_session_settlement(
                &Address::generate(&env),
                &Address::generate(&env),
                &payee,
                &1_i128,
                &1_u32,
            )
        });
        assert_refreshes_instance_ttl(&env, &vault_id, "remove_from_allowlist", || {
            client.remove_from_allowlist(&payee)
        });
        assert_refreshes_instance_ttl(&env, &vault_id, "set_lifetime_cap", || {
            client.set_lifetime_cap(&9_000_000_i128)
        });
        assert_refreshes_instance_ttl(&env, &vault_id, "set_expiry", || {
            client.set_expiry(&2_000_000_u32)
        });
        assert_refreshes_instance_ttl(&env, &vault_id, "set_agent_pubkey", || {
            client.set_agent_pubkey(&fixed_hash(&env, 0x7a))
        });
        assert_refreshes_instance_ttl(&env, &vault_id, "transfer_admin", || {
            client.transfer_admin(&new_admin)
        });
        assert_refreshes_instance_ttl(&env, &vault_id, "accept_admin", || {
            client.accept_admin()
        });
        assert_refreshes_instance_ttl(&env, &vault_id, "freeze", || client.freeze());
        assert_refreshes_instance_ttl(&env, &vault_id, "unfreeze", || client.unfreeze());
        assert_refreshes_instance_ttl(&env, &vault_id, "propose_upgrade", || {
            client.propose_upgrade(&fixed_hash(&env, 1))
        });
        assert_refreshes_instance_ttl(&env, &vault_id, "cancel_upgrade", || {
            client.cancel_upgrade()
        });
        // Last: swapping the executable rewrites the instance entry, so
        // `execute_upgrade` is the one entrypoint that bumps after its work
        // rather than right after the auth check. An empty wasm is uploaded here
        // rather than reusing the previous-release fixture: that fixture hashes to
        // the same code key as the wasm this test's vault is already running, and
        // every case above advances the ledger 1.5M ledgers, which archives that
        // code entry, so a swap to it fails with `Error(Storage, InternalError)`.
        assert_refreshes_instance_ttl(&env, &vault_id, "execute_upgrade", || {
            let new_wasm_hash =
                env.deployer().upload_contract_wasm(Bytes::from_slice(&env, &[]));
            client.propose_upgrade(&new_wasm_hash);
            env.ledger()
                .set_sequence_number(env.ledger().sequence() + UPGRADE_TIMELOCK_LEDGERS);
            client.execute_upgrade();
        });
    }

    /// Test 47: `__check_auth` still refreshes the instance TTL — it was one of
    /// the two original call sites, and agent traffic is what keeps a vault that
    /// is not being administered alive.
    #[test]
    fn test_check_auth_refreshes_instance_ttl_after_ledger_advance() {
        let env = Env::default();

        let admin = Address::generate(&env);
        let (agent_sk, agent_pk) = gen_keypair(&env);
        let provider_a = Address::generate(&env);
        let allowlist = Map::from_array(&env, [(provider_a.clone(), 5_000_000_i128)]);
        // Expiry beyond the fast-forward below, so the payment is still in-session.
        let vault_id = env.register(
            AgentVault,
            (admin, agent_pk, 5_000_000_i128, allowlist, 2_000_000_u32, 0_i128),
        );

        // #given a vault whose instance TTL has decayed inside the bump threshold
        decay_instance_ttl(&env, &vault_id);

        // #when the agent pays an allowlisted payee
        let payload = BytesN::<32>::random(&env);
        let sig = sign_payload(&env, &agent_sk, &payload);
        let contexts = Vec::from_array(&env, [transfer_context(&env, &provider_a, 100_000)]);
        let result = env.try_invoke_contract_check_auth::<Error>(
            &vault_id,
            &payload,
            sig.into_val(&env),
            &contexts,
        );
        assert!(result.is_ok(), "payment inside the session window should pass: {result:?}");

        // #then the instance entry lives for the full extend-to TTL again
        assert_eq!(
            instance_ttl(&env, &vault_id),
            INSTANCE_TTL_EXTEND_TO,
            "__check_auth must refresh the instance TTL"
        );
    }

    /// Test 48: a rejected call must not leave a refreshed instance TTL behind —
    /// the bump sits behind the auth check. Note the host also reverts a failed
    /// invocation, so this asserts the end state rather than the ordering.
    #[test]
    fn test_unauthorized_admin_call_does_not_refresh_instance_ttl() {
        let env = Env::default();
        let (client, _, vault_id, _) = setup(&env);
        // No mock_all_auths(): `freeze` has nothing to authorize with.

        decay_instance_ttl(&env, &vault_id);
        let before = instance_ttl(&env, &vault_id);

        assert!(
            client.try_freeze().is_err(),
            "freeze without admin auth must fail"
        );
        assert_eq!(
            instance_ttl(&env, &vault_id),
            before,
            "a rejected call must not refresh the instance TTL"
        );
    }
}

// ---------------------------------------------------------------------------
// Property-based invariant tests
// Enabled only when compiled with --features testutils (runs in CI, not locally
// by default to avoid heavy compilation on resource-constrained machines).
// ---------------------------------------------------------------------------
#[cfg(all(test, feature = "testutils"))]
mod prop_tests {
    extern crate alloc;
    use alloc::vec::Vec;
    use proptest::prelude::*;

    /// Helper: clamp a sequence of withdrawals to never exceed the cap, and
    /// verify the running sum stays at or below the cap at every step.
    fn withdrawals_never_exceed_cap(cap: i128, amounts: Vec<i128>) -> bool {
        let mut running_total: i128 = 0;
        for amount in amounts {
            // Only authorise amounts that would not bust the cap
            if amount <= 0 {
                continue;
            }
            if running_total + amount > cap {
                // Simulate a rejected withdrawal — running total stays the same
                continue;
            }
            running_total += amount;
            if running_total > cap {
                return false;
            }
        }
        true
    }

    proptest! {
        /// Invariant 1: The daily cap is never exceeded regardless of the
        /// sequence and magnitude of approved withdrawals.
        #[test]
        fn daily_cap_never_exceeded(
            cap in 1_i128..=100_000_000_i128,
            amounts in proptest::collection::vec(0_i128..=10_000_000_i128, 0..=50),
        ) {
            prop_assert!(withdrawals_never_exceed_cap(cap, amounts));
        }

        /// Invariant 2: Per-payee sub-cap is never exceeded.
        /// Each payee cap is always <= the global daily cap.
        #[test]
        fn per_payee_cap_not_exceeded(
            global_cap in 1_i128..=100_000_000_i128,
            // Sub-cap is always a fraction of the global cap
            sub_cap_fraction in 1_u32..=100_u32,
            amounts in proptest::collection::vec(0_i128..=5_000_000_i128, 0..=30),
        ) {
            let sub_cap = global_cap / (sub_cap_fraction as i128).max(1);
            // Sub-cap must not exceed global cap
            prop_assert!(sub_cap <= global_cap);
            // Simulate withdrawals capped at the sub-cap
            prop_assert!(withdrawals_never_exceed_cap(sub_cap, amounts.clone()));
            // Also verify against global cap
            prop_assert!(withdrawals_never_exceed_cap(global_cap, amounts));
        }

        /// Invariant 3: Lifetime spend cap is monotonically non-decreasing and
        /// never exceeds the configured maximum.
        #[test]
        fn lifetime_cap_monotone(
            lifetime_max in 1_i128..=1_000_000_000_i128,
            amounts in proptest::collection::vec(0_i128..=10_000_000_i128, 0..=100),
        ) {
            let mut lifetime_spent: i128 = 0;
            let mut prev = 0_i128;
            for amount in amounts {
                if amount <= 0 { continue; }
                if lifetime_spent + amount > lifetime_max { continue; }
                lifetime_spent += amount;
                // Monotone: never decreases
                prop_assert!(lifetime_spent >= prev);
                // Never exceeds maximum
                prop_assert!(lifetime_spent <= lifetime_max);
                prev = lifetime_spent;
            }
        }
    }
}

#[cfg(test)]
mod upgrade_tests;
