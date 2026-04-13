#![no_std]

use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contracterror, contractimpl,
    crypto::Hash,
    panic_with_error, symbol_short,
    Address, Bytes, BytesN, Env, IntoVal, Symbol, Vec,
};

// ── Storage keys ─────────────────────────────────────────────────────────────

const ADMIN_KEY: Symbol = symbol_short!("admin");
const AGENT_KEY: Symbol = symbol_short!("agentpk");
const CAP_KEY: Symbol = symbol_short!("dailycap");
const LIST_KEY: Symbol = symbol_short!("allwlist");
const EXPIRY_KEY: Symbol = symbol_short!("expiry");
const INIT_KEY: Symbol = symbol_short!("init");

// Day-spend key prefix: (SPEND_PREFIX, day_bucket) where day_bucket = seq / 17280
const SPEND_PREFIX: Symbol = symbol_short!("ds");

// ── Error codes ───────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    SessionExpired = 3,
    DailyCapExceeded = 4,
    PayeeNotAllowed = 5,
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct AgentVault;

#[contractimpl]
impl AgentVault {
    /// One-time setup. Protected by INIT_KEY — reverts if called twice.
    pub fn initialize(
        env: Env,
        admin: Address,
        agent_pk: BytesN<32>,
        daily_cap: i128,
        allowlist: Vec<Address>,
        expiry_ledger: u32,
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

    /// Append a payee address to the spend allowlist. Admin only.
    pub fn add_to_allowlist(env: Env, payee: Address) {
        let storage = env.storage().instance();
        let admin: Address = storage
            .get(&ADMIN_KEY)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
        admin.require_auth();
        let mut list: Vec<Address> = storage
            .get(&LIST_KEY)
            .unwrap_or_else(|| Vec::new(&env));
        if !list.contains(&payee) {
            list.push_back(payee);
        }
        storage.set(&LIST_KEY, &list);
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
//     against ALLOWLIST in instance storage
//   • Policy 3 — SessionKeyExpiry: ledger sequence compared to stored EXPIRY

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
        let allowlist: Vec<Address> = storage
            .get(&LIST_KEY)
            .unwrap_or_else(|| Vec::new(&env));

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
                    let to: Address = ctx.args.get(1).unwrap().into_val(&env);
                    let amount: i128 = ctx.args.get(2).unwrap().into_val(&env);

                    // Policy 2 — EndpointAllowlistPolicy
                    if !allowlist.contains(&to) {
                        return Err(Error::PayeeNotAllowed);
                    }

                    // Policy 1 — DailyCapPolicy
                    let projected = day_spend.checked_add(amount).unwrap_or(i128::MAX);
                    if projected > daily_cap {
                        return Err(Error::DailyCapExceeded);
                    }
                    day_spend = projected;
                }
            }
        }

        // Persist updated day spend — TTL covers current bucket + one more day
        env.storage()
            .temporary()
            .set::<(Symbol, u32), i128>(&spend_key, &day_spend);
        env.storage()
            .temporary()
            .extend_ttl::<(Symbol, u32)>(&spend_key, 17_280, 34_560);

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
        IntoVal,
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

    fn setup(env: &Env) -> (AgentVaultClient, SigningKey, Address, Address) {
        let vault_id = env.register(AgentVault, ());
        let client = AgentVaultClient::new(env, &vault_id);

        let admin = Address::generate(env);
        let (agent_sk, agent_pk) = gen_keypair(env);
        let provider_a = Address::generate(env);

        let allowlist = Vec::from_array(env, [provider_a.clone()]);
        // daily_cap = 5_000_000 stroops (0.50 USDC), expiry = ledger 10_000
        client.initialize(&admin, &agent_pk, &5_000_000_i128, &allowlist, &10_000_u32);

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
}
