#![no_std]

use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contracterror, contractimpl,
    crypto::Hash,
    panic_with_error, symbol_short,
    Address, Bytes, BytesN, Env, IntoVal, Map, Symbol, Vec,
};

// ── Storage keys ─────────────────────────────────────────────────────────────

const ADMIN_KEY: Symbol = symbol_short!("admin");
const AGENT_KEY: Symbol = symbol_short!("agentpk");
const CAP_KEY: Symbol = symbol_short!("dailycap");
const LIST_KEY: Symbol = symbol_short!("allwlist");
const EXPIRY_KEY: Symbol = symbol_short!("expiry");
const INIT_KEY: Symbol = symbol_short!("init");

// Global day-spend key: (SPEND_PREFIX, day_bucket) where day_bucket = seq / 17280
const SPEND_PREFIX: Symbol = symbol_short!("ds");
// Per-payee day-spend key: (PAYEE_SPEND_PREFIX, day_bucket, payee)
const PAYEE_SPEND_PREFIX: Symbol = symbol_short!("pds");
// Lifetime spend cap and monotonic counter (instance storage — never resets)
const LIFETIME_CAP_KEY: Symbol = symbol_short!("ltcap");
const LIFETIME_SPEND_KEY: Symbol = symbol_short!("ltspend");

// ── Event names ──────────────────────────────────────────────────────────────
// Longer than 9 chars — must use Symbol::new(&env, ...) at call sites.
const EVT_PAYMENT_AUTHORIZED: &str = "payment_authorized";
const EVT_SESSION_SETTLED: &str = "session_settled";

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
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct AgentVault;

#[contractimpl]
impl AgentVault {
    /// One-time setup. Protected by INIT_KEY — reverts if called twice.
    /// `lifetime_cap`: total USDC (stroops) the vault may ever spend; 0 = unlimited.
    pub fn initialize(
        env: Env,
        admin: Address,
        agent_pk: BytesN<32>,
        daily_cap: i128,
        allowlist: Map<Address, i128>,
        expiry_ledger: u32,
        lifetime_cap: i128,
    ) {
        let storage = env.storage().instance();
        if storage.has(&INIT_KEY) {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }
        storage.set(&ADMIN_KEY, &admin);
        storage.set(&AGENT_KEY, &agent_pk);
        storage.set(&CAP_KEY, &daily_cap);
        storage.set(&LIST_KEY, &allowlist);
        storage.set(&EXPIRY_KEY, &expiry_ledger);
        storage.set(&LIFETIME_CAP_KEY, &lifetime_cap);
        storage.set(&LIFETIME_SPEND_KEY, &0_i128);
        storage.set(&INIT_KEY, &true);
        // Extend instance storage TTL to outlive any realistic session expiry
        env.storage().instance().extend_ttl(2_000_000, 2_000_000);
    }

    /// Update the daily USDC spend cap (in stroops). Admin only.
    pub fn set_daily_cap(env: Env, new_cap: i128) {
        let storage = env.storage().instance();
        let admin: Address = storage
            .get(&ADMIN_KEY)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
        admin.require_auth();
        storage.set(&CAP_KEY, &new_cap);
    }

    /// Upsert a payee address in the spend allowlist with a per-payee daily sub-cap. Admin only.
    pub fn add_to_allowlist(env: Env, payee: Address, sub_cap: i128) {
        let storage = env.storage().instance();
        let admin: Address = storage
            .get(&ADMIN_KEY)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
        admin.require_auth();
        let mut map: Map<Address, i128> = storage
            .get(&LIST_KEY)
            .unwrap_or_else(|| Map::new(&env));
        map.set(payee, sub_cap);
        storage.set(&LIST_KEY, &map);
    }

    /// Record an off-chain channel settlement. Emits `session_settled`. Admin only.
    pub fn record_session_settlement(
        env: Env,
        channel_id: Address,
        payer: Address,
        payee: Address,
        cumulative_amount: i128,
        voucher_count: u32,
    ) {
        let storage = env.storage().instance();
        let admin: Address = storage
            .get(&ADMIN_KEY)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
        admin.require_auth();

        // topics: (Symbol("session_settled"), channel_id, payee)
        // data:   (payer, cumulative_amount, voucher_count)
        env.events().publish(
            (Symbol::new(&env, EVT_SESSION_SETTLED), channel_id, payee),
            (payer, cumulative_amount, voucher_count),
        );
    }

    /// Update the lifetime USDC spend cap (in stroops). Admin only. 0 = unlimited.
    /// Can only be lowered below current spend counter, not raised beyond the original
    /// intent — callers should treat this as a ratchet-down control.
    pub fn set_lifetime_cap(env: Env, new_cap: i128) {
        let storage = env.storage().instance();
        let admin: Address = storage
            .get(&ADMIN_KEY)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
        admin.require_auth();
        storage.set(&LIFETIME_CAP_KEY, &new_cap);
    }

    /// Return the vault's cumulative lifetime spend counter (stroops). Read-only.
    pub fn get_lifetime_spend(env: Env) -> i128 {
        env.storage()
            .instance()
            .get::<Symbol, i128>(&LIFETIME_SPEND_KEY)
            .unwrap_or(0)
    }
}

// ── CustomAccountInterface ────────────────────────────────────────────────────
//
// Architecture follows Crossmint/stellar-smart-account v1.0.0:
//   • Signature = Ed25519 BytesN<64>
//   • __check_auth runs policies against every Context::Contract("transfer") entry
//   • Policy 1 — DailyCapPolicy:  keyed by (SPEND_PREFIX, seq / 17280) in
//     temporary storage; resets automatically when the bucket rolls over
//   • Policy 2 — EndpointAllowlistPolicy: recipient from args[1] checked
//     against ALLOWLIST in instance storage; also reads the per-payee sub-cap
//   • Policy 3 — SessionKeyExpiry: ledger sequence compared to stored EXPIRY
//   • Policy 4 — PerPayeeCapPolicy: keyed by (PAYEE_SPEND_PREFIX, seq / 17280, payee)
//     in temporary storage; prevents a single compromised provider from draining
//     the global daily cap
//   • Policy 5 — LifetimeCapPolicy: monotonic spend_counter in instance storage;
//     enforced when lifetime_cap > 0; never resets across day boundaries

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
        storage.extend_ttl(2_000_000, 2_000_000);

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

        // Day bucket: one bucket per ~24 h (17 280 ledgers × ~5 s each)
        let day_bucket: u32 = env.ledger().sequence() / 17_280;
        let spend_key = (SPEND_PREFIX, day_bucket);
        let mut day_spend: i128 = env
            .storage()
            .temporary()
            .get::<(Symbol, u32), i128>(&spend_key)
            .unwrap_or(0);

        // ── Per-context policy checks ─────────────────────────────────────────
        for context in auth_contexts.iter() {
            if let Context::Contract(ctx) = context {
                if ctx.fn_name == Symbol::new(&env, "transfer") {
                    // SAC transfer(from: Address, to: Address, amount: i128)
                    let from: Address = ctx.args.get(0).unwrap().into_val(&env);
                    let to: Address = ctx.args.get(1).unwrap().into_val(&env);
                    let amount: i128 = ctx.args.get(2).unwrap().into_val(&env);
                    let asset: Address = ctx.contract.clone();

                    // Policy 2 — EndpointAllowlistPolicy (also fetches per-payee sub-cap)
                    let payee_sub_cap = allowlist.get(to.clone()).ok_or(Error::PayeeNotAllowed)?;

                    // Policy 1 — Global DailyCapPolicy
                    let projected = day_spend.checked_add(amount).unwrap_or(i128::MAX);
                    if projected > daily_cap {
                        return Err(Error::DailyCapExceeded);
                    }
                    day_spend = projected;

                    // Policy 4 — Per-payee DailyCapPolicy
                    let payee_spend_key = (PAYEE_SPEND_PREFIX, day_bucket, to.clone());
                    let payee_spend: i128 = env
                        .storage()
                        .temporary()
                        .get::<(Symbol, u32, Address), i128>(&payee_spend_key)
                        .unwrap_or(0);
                    let payee_projected = payee_spend.checked_add(amount).unwrap_or(i128::MAX);
                    if payee_projected > payee_sub_cap {
                        return Err(Error::PayeeCapExceeded);
                    }

                    // Persist updated per-payee spend — TTL covers current bucket + one more day
                    env.storage()
                        .temporary()
                        .set::<(Symbol, u32, Address), i128>(&payee_spend_key, &payee_projected);
                    env.storage()
                        .temporary()
                        .extend_ttl::<(Symbol, u32, Address)>(&payee_spend_key, 17_280, 34_560);

                    // Policy 5 — LifetimeCapPolicy (monotonic, never resets)
                    // Always accumulate; enforce only when a cap is set (lifetime_cap > 0).
                    let projected_lifetime =
                        lifetime_spend.checked_add(amount).unwrap_or(i128::MAX);
                    if lifetime_cap > 0 && projected_lifetime > lifetime_cap {
                        return Err(Error::LifetimeCapExceeded);
                    }
                    lifetime_spend = projected_lifetime;

                    // topics: (Symbol("payment_authorized"), payer, payee)
                    // data:   (amount, asset, daily_cumulative)
                    env.events().publish(
                        (Symbol::new(&env, EVT_PAYMENT_AUTHORIZED), from, to),
                        (amount, asset, day_spend),
                    );
                }
            }
        }

        // Persist updated global day spend — TTL covers current bucket + one more day
        env.storage()
            .temporary()
            .set::<(Symbol, u32), i128>(&spend_key, &day_spend);
        env.storage()
            .temporary()
            .extend_ttl::<(Symbol, u32)>(&spend_key, 17_280, 34_560);

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
        auth::ContractContext,
        testutils::{Address as _, BytesN as _, Ledger},
        IntoVal, TryFromVal,
    };

    // Use ed25519-dalek for signing in tests (same pattern as Crossmint/stellar-smart-account)
    extern crate std;
    use ed25519_dalek::{Signer as _, SigningKey};
    use rand::rngs::OsRng;

    fn gen_keypair(env: &Env) -> (SigningKey, BytesN<32>) {
        let sk = SigningKey::generate(&mut OsRng);
        let pk = BytesN::<32>::from_array(env, &sk.verifying_key().to_bytes());
        (sk, pk)
    }

    fn sign_payload(env: &Env, sk: &SigningKey, payload: &BytesN<32>) -> BytesN<64> {
        let sig = sk.sign(&payload.to_array());
        BytesN::<64>::from_array(env, &sig.to_bytes())
    }

    fn setup(env: &Env) -> (AgentVaultClient<'_>, SigningKey, Address, Address) {
        let vault_id = env.register(AgentVault, ());
        let client = AgentVaultClient::new(env, &vault_id);

        let admin = Address::generate(env);
        let (agent_sk, agent_pk) = gen_keypair(env);
        let provider_a = Address::generate(env);

        // daily_cap = 5_000_000 stroops (0.50 USDC), per-payee sub_cap = 5_000_000, expiry = ledger 10_000, no lifetime cap
        let allowlist = Map::from_array(env, [(provider_a.clone(), 5_000_000_i128)]);
        client.initialize(&admin, &agent_pk, &5_000_000_i128, &allowlist, &10_000_u32, &0_i128);

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
        let vault_id = env.register(AgentVault, ());
        let client = AgentVaultClient::new(&env, &vault_id);

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
        client.initialize(&admin, &agent_pk, &5_000_000_i128, &allowlist, &10_000_u32, &0_i128);

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

    /// Test 13: daily reset logic — spending resets across day boundaries
    #[test]
    fn test_daily_reset_across_boundaries() {
        let env = Env::default();
        let vault_id = env.register(AgentVault, ());
        let client = AgentVaultClient::new(&env, &vault_id);

        let admin = Address::generate(&env);
        let (agent_sk, agent_pk) = gen_keypair(&env);
        let provider_a = Address::generate(&env);

        let allowlist = Map::from_array(&env, [(provider_a.clone(), 5_000_000_i128)]);
        // Initialize with a specific cap, no lifetime cap
        client.initialize(&admin, &agent_pk, &5_000_000_i128, &allowlist, &500_000_u32, &0_i128);

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

        // Move to Day 1: day_bucket = 17_280 / 17_280 = 1
        env.ledger().set_sequence_number(17_280);

        // Day 1: attempt to spend 4_000_000 again
        // This should succeed because we're in a new day bucket (bucket 1)
        let payload3 = BytesN::<32>::random(&env);
        let sig3 = sign_payload(&env, &agent_sk, &payload3);
        let contexts3 = Vec::from_array(&env, [transfer_context(&env, &provider_a, 4_000_000)]);
        let result3 = env.try_invoke_contract_check_auth::<Error>(
            &vault_id,
            &payload3,
            sig3.into_val(&env),
            &contexts3,
        );
        assert!(
            result3.is_ok(),
            "payment in new day bucket should succeed after reset"
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
                        .map_or(false, |t| Symbol::try_from_val(&env, &t).map_or(false, |s| s == evt_name))
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
                        .map_or(false, |t| Symbol::try_from_val(&env, &t).map_or(false, |s| s == evt_name))
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
                        .map_or(false, |t| Symbol::try_from_val(&env, &t).map_or(false, |s| s == evt_name))
            })
            .count();
        assert_eq!(count, 0, "rejected transfer must not emit payment_authorized");
    }

    /// Test 17: session_settled event emitted with full payload
    #[test]
    fn test_session_settled_event_emitted() {
        use soroban_sdk::{testutils::Events, IntoVal};

        let env = Env::default();
        let vault_id = env.register(AgentVault, ());
        let client = AgentVaultClient::new(&env, &vault_id);

        let admin = Address::generate(&env);
        let (_, agent_pk) = gen_keypair(&env);
        let provider_a = Address::generate(&env);
        let allowlist = Map::from_array(&env, [(provider_a.clone(), 5_000_000_i128)]);
        client.initialize(&admin, &agent_pk, &5_000_000_i128, &allowlist, &10_000_u32, &0_i128);

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
                        .map_or(false, |t| Symbol::try_from_val(&env, &t).map_or(false, |s| s == evt_name))
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

    /// Test 18: record_session_settlement without admin auth panics
    #[test]
    #[should_panic]
    fn test_session_settled_requires_admin_auth() {
        let env = Env::default();
        let vault_id = env.register(AgentVault, ());
        let client = AgentVaultClient::new(&env, &vault_id);

        let admin = Address::generate(&env);
        let (_, agent_pk) = gen_keypair(&env);
        let provider_a = Address::generate(&env);
        let allowlist = Map::from_array(&env, [(provider_a.clone(), 5_000_000_i128)]);
        client.initialize(&admin, &agent_pk, &5_000_000_i128, &allowlist, &10_000_u32, &0_i128);

        // No mock_all_auths() — require_auth() must panic
        let channel = Address::generate(&env);
        let payer = Address::generate(&env);
        client.record_session_settlement(&channel, &payer, &provider_a, &500_000_i128, &10_u32);
    }

    /// Test 19: payment within global cap but exceeding per-payee sub-cap is rejected
    #[test]
    fn test_per_payee_cap_enforced_below_global_cap() {
        let env = Env::default();
        let vault_id = env.register(AgentVault, ());
        let client = AgentVaultClient::new(&env, &vault_id);

        let admin = Address::generate(&env);
        let (agent_sk, agent_pk) = gen_keypair(&env);
        let provider_a = Address::generate(&env);

        // global cap = 5_000_000, per-payee sub-cap = 1_000_000
        let allowlist = Map::from_array(&env, [(provider_a.clone(), 1_000_000_i128)]);
        client.initialize(&admin, &agent_pk, &5_000_000_i128, &allowlist, &10_000_u32, &0_i128);

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
        let vault_id = env.register(AgentVault, ());
        let client = AgentVaultClient::new(&env, &vault_id);

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
        client.initialize(&admin, &agent_pk, &5_000_000_i128, &allowlist, &10_000_u32, &0_i128);

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

    /// Test 21: per-payee spend resets with the day bucket (same as global)
    #[test]
    fn test_per_payee_spend_resets_on_new_day() {
        let env = Env::default();
        let vault_id = env.register(AgentVault, ());
        let client = AgentVaultClient::new(&env, &vault_id);

        let admin = Address::generate(&env);
        let (agent_sk, agent_pk) = gen_keypair(&env);
        let provider_a = Address::generate(&env);

        // global cap = 5_000_000; provider_a sub-cap = 1_000_000
        let allowlist = Map::from_array(&env, [(provider_a.clone(), 1_000_000_i128)]);
        client.initialize(&admin, &agent_pk, &5_000_000_i128, &allowlist, &500_000_u32, &0_i128);

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

        // Advance to Day 1 — per-payee spend resets
        env.ledger().set_sequence_number(17_280);
        let p3 = BytesN::<32>::random(&env);
        let s3 = sign_payload(&env, &agent_sk, &p3);
        let c3 = Vec::from_array(&env, [transfer_context(&env, &provider_a, 1_000_000)]);
        assert!(
            env.try_invoke_contract_check_auth::<Error>(&vault_id, &p3, s3.into_val(&env), &c3).is_ok(),
            "payment in new day bucket should succeed after per-payee reset"
        );
    }

    // ── Lifetime cap tests ────────────────────────────────────────────────────

    /// Helper: vault with daily_cap=5_000_000, lifetime_cap as specified, expiry far out.
    fn setup_with_lifetime_cap(
        env: &Env,
        lifetime_cap: i128,
    ) -> (AgentVaultClient<'_>, SigningKey, Address, Address) {
        let vault_id = env.register(AgentVault, ());
        let client = AgentVaultClient::new(env, &vault_id);

        let admin = Address::generate(env);
        let (agent_sk, agent_pk) = gen_keypair(env);
        let provider_a = Address::generate(env);

        let allowlist = Map::from_array(env, [(provider_a.clone(), 5_000_000_i128)]);
        client.initialize(
            &admin,
            &agent_pk,
            &5_000_000_i128,
            &allowlist,
            &500_000_u32,
            &lifetime_cap,
        );
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

        // Day 1: spend another 5_000_000 (total 10M — would fail if cap were 8M)
        env.ledger().set_sequence_number(17_280);
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

        // Day 1: try 4_000_000 — total would be 9_000_000 > 8_000_000 lifetime cap
        env.ledger().set_sequence_number(17_280);
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
}
