//! Real Wasm upgrade paths. Run with AGENT_VAULT_WASM and --include-ignored.
extern crate std;

use super::*;
use ed25519_dalek::{Signer as _, SigningKey};
use soroban_sdk::{
    auth::ContractContext,
    testutils::{Address as _, EnvTestConfig, Events, Ledger, MockAuth, MockAuthInvoke},
    FromVal, IntoVal,
};

const PRE_TIMELOCK_WASM: &[u8] = include_bytes!("../testdata/agent_vault_pre_timelock.wasm");

fn current_wasm() -> std::vec::Vec<u8> {
    let path = std::env::var_os("AGENT_VAULT_WASM")
        .expect("set AGENT_VAULT_WASM to the output of bash scripts/build-vault-wasm.sh");
    let wasm = std::fs::read(path).expect("AGENT_VAULT_WASM must name a readable release Wasm");
    assert!(
        wasm.as_slice() != PRE_TIMELOCK_WASM,
        "current Wasm must not be the previous release"
    );
    wasm
}

fn test_env() -> Env {
    let env = Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    // Keep both executables resident across the notice period, as operators do
    // by extending their code TTL on chain.
    env.ledger().set_min_persistent_entry_ttl(200_000);
    env
}

struct Vault {
    id: Address,
    admin: Address,
    pending_admin: Address,
    key: SigningKey,
    payee: Address,
    other_payee: Address,
    allowlist: Map<Address, i128>,
}

fn register(env: &Env, wasm: &[u8]) -> Vault {
    let admin = Address::generate(env);
    let pending_admin = Address::generate(env);
    let key = SigningKey::from_bytes(&[42; 32]);
    let pk = BytesN::from_array(env, &key.verifying_key().to_bytes());
    let payee = Address::generate(env);
    let other_payee = Address::generate(env);
    let allowlist = Map::from_array(
        env,
        [(payee.clone(), 3_000_000), (other_payee.clone(), 5_000_000)],
    );
    let args = (
        admin.clone(),
        pk,
        5_000_000_i128,
        allowlist.clone(),
        100_000_u32,
        8_000_000_i128,
    );
    let id = if wasm == PRE_TIMELOCK_WASM {
        // This release predates the atomic constructor as well as the timelock.
        let id = env.register(wasm, ());
        env.invoke_contract::<()>(&id, &Symbol::new(env, "initialize"), args.into_val(env));
        id
    } else {
        env.register(wasm, args)
    };
    let vault = Vault {
        id,
        admin,
        pending_admin,
        key,
        payee,
        other_payee,
        allowlist,
    };
    mock_admin(
        env,
        &vault,
        "transfer_admin",
        (&vault.pending_admin,).into_val(env),
    );
    AgentVaultClient::new(env, &vault.id).transfer_admin(&vault.pending_admin);
    vault
}

fn mock_admin(env: &Env, vault: &Vault, function: &str, args: Vec<soroban_sdk::Val>) {
    env.mock_auths(&[MockAuth {
        address: &vault.admin,
        invoke: &MockAuthInvoke {
            contract: &vault.id,
            fn_name: function,
            args,
            sub_invokes: &[],
        },
    }]);
}

fn payment(env: &Env, vault: &Vault, payee: &Address, amount: i128) -> Result<(), Error> {
    let payload = BytesN::from_array(env, &[7; 32]);
    let sig = BytesN::from_array(env, &vault.key.sign(&payload.to_array()).to_bytes());
    let contexts = Vec::from_array(
        env,
        [Context::Contract(ContractContext {
            contract: Address::generate(env),
            fn_name: symbol_short!("transfer"),
            args: (vault.id.clone(), payee.clone(), amount).into_val(env),
        })],
    );
    env.try_invoke_contract_check_auth::<Error>(&vault.id, &payload, sig.into_val(env), &contexts)
        .map_err(|err| err.expect("expected a typed policy error"))
}

fn assert_state(env: &Env, vault: &Vault, spent: i128, frozen: bool) {
    let client = AgentVaultClient::new(env, &vault.id);
    assert_eq!(client.daily_cap(), 5_000_000);
    assert_eq!(client.allowlist(), vault.allowlist);
    assert_eq!(client.expiry_ledger(), 100_000);
    assert_eq!(
        client.agent_pubkey(),
        BytesN::from_array(env, &vault.key.verifying_key().to_bytes())
    );
    assert_eq!(client.get_lifetime_spend(), spent);
    // These fields have no public getters. All other policy state is checked
    // through the deployed executable's public interface.
    env.as_contract(&vault.id, || {
        let storage = env.storage().instance();
        assert_eq!(
            storage.get::<_, Address>(&ADMIN_KEY),
            Some(vault.admin.clone())
        );
        assert_eq!(
            storage.get::<_, Address>(&PENDING_ADMIN_KEY),
            Some(vault.pending_admin.clone())
        );
        assert_eq!(storage.get::<_, i128>(&LIFETIME_CAP_KEY), Some(8_000_000));
        assert_eq!(storage.get::<_, bool>(&FROZEN_KEY).unwrap_or(false), frozen);
        assert_eq!(storage.get::<_, bool>(&INIT_KEY), Some(true));
    });
}

fn assert_upgraded_event(env: &Env, id: &Address, hash: &BytesN<32>) {
    let events: std::vec::Vec<_> = env
        .events()
        .all()
        .iter()
        .filter(|(address, topics, _)| {
            address == id
                && topics.get(0).is_some_and(|topic| {
                    Symbol::from_val(env, &topic) == Symbol::new(env, EVT_UPGRADED)
                })
        })
        .collect();
    assert_eq!(events.len(), 1, "exactly one upgraded event expected");
    assert_eq!(BytesN::<32>::from_val(env, &events[0].2), *hash);
}

#[test]
#[ignore = "requires fresh Wasm: set AGENT_VAULT_WASM and run with --include-ignored"]
fn test_bootstrap_upgrade_keeps_state_and_enforces_current_policies() {
    let wasm = current_wasm();
    let env = test_env();
    let vault = register(&env, PRE_TIMELOCK_WASM);
    let client = AgentVaultClient::new(&env, &vault.id);
    assert_eq!(payment(&env, &vault, &vault.payee, 1_500_000), Ok(()));
    mock_admin(&env, &vault, "freeze", ().into_val(&env));
    client.freeze();
    assert_state(&env, &vault, 1_500_000, true);

    let hash = env.deployer().upload_contract_wasm(wasm.as_slice());
    mock_admin(&env, &vault, "upgrade", (&hash,).into_val(&env));
    env.invoke_contract::<()>(
        &vault.id,
        &symbol_short!("upgrade"),
        (&hash,).into_val(&env),
    );
    assert_upgraded_event(&env, &vault.id, &hash);
    assert_state(&env, &vault, 1_500_000, true);
    assert_eq!(client.upgrade_timelock_ledgers(), UPGRADE_TIMELOCK_LEDGERS);
    assert_eq!(client.pending_upgrade(), None);
    assert_eq!(
        payment(&env, &vault, &vault.payee, 1),
        Err(Error::ContractFrozen)
    );
    mock_admin(&env, &vault, "unfreeze", ().into_val(&env));
    client.unfreeze();

    // These execute __check_auth in the current Wasm, with real Ed25519 signatures.
    assert_eq!(payment(&env, &vault, &vault.payee, 1_000_000), Ok(()));
    assert_eq!(
        payment(&env, &vault, &vault.payee, 500_001),
        Err(Error::PayeeCapExceeded)
    );
    assert_eq!(
        payment(&env, &vault, &vault.other_payee, 2_500_001),
        Err(Error::DailyCapExceeded)
    );
    assert_eq!(
        payment(&env, &vault, &Address::generate(&env), 1),
        Err(Error::PayeeNotAllowed)
    );
    assert_state(&env, &vault, 2_500_000, false);

    mock_admin(&env, &vault, "propose_upgrade", (&hash,).into_val(&env));
    client.propose_upgrade(&hash);
    let ready = env.ledger().sequence() + UPGRADE_TIMELOCK_LEDGERS;
    env.ledger().set_sequence_number(ready - 1);
    mock_admin(&env, &vault, "execute_upgrade", ().into_val(&env));
    assert_eq!(
        client.try_execute_upgrade(),
        Err(Ok(Error::UpgradeNotReady.into()))
    );
    assert_eq!(client.pending_upgrade(), Some((hash.clone(), ready)));
    env.ledger().set_sequence_number(ready);
    mock_admin(&env, &vault, "execute_upgrade", ().into_val(&env));
    client.execute_upgrade();
    assert_upgraded_event(&env, &vault.id, &hash);
    assert_eq!(client.pending_upgrade(), None);
    assert_state(&env, &vault, 2_500_000, false);

    // Day counters reset; lifetime spend does not. A failed auth must roll back.
    assert_eq!(payment(&env, &vault, &vault.other_payee, 4_000_000), Ok(()));
    env.ledger()
        .set_sequence_number(2 * UPGRADE_TIMELOCK_LEDGERS);
    assert_eq!(
        payment(&env, &vault, &vault.payee, 1_500_001),
        Err(Error::LifetimeCapExceeded)
    );
    assert_state(&env, &vault, 6_500_000, false);
    env.ledger().set_sequence_number(100_001);
    assert_eq!(
        payment(&env, &vault, &vault.payee, 1),
        Err(Error::SessionExpired)
    );
}

#[test]
#[ignore = "requires fresh Wasm: set AGENT_VAULT_WASM and run with --include-ignored"]
fn test_bootstrap_upgrade_requires_the_preserved_admin() {
    let wasm = current_wasm();
    let env = test_env();
    let vault = register(&env, PRE_TIMELOCK_WASM);
    let hash = env.deployer().upload_contract_wasm(wasm.as_slice());
    let outsider = Address::generate(&env);
    env.mock_auths(&[MockAuth {
        address: &outsider,
        invoke: &MockAuthInvoke {
            contract: &vault.id,
            fn_name: "upgrade",
            args: (&hash,).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    let result = env.try_invoke_contract::<(), soroban_sdk::Error>(
        &vault.id,
        &symbol_short!("upgrade"),
        (&hash,).into_val(&env),
    );
    assert_eq!(
        result,
        Err(Ok(soroban_sdk::Error::from_type_and_code(
            soroban_sdk::xdr::ScErrorType::Context,
            soroban_sdk::xdr::ScErrorCode::InvalidAction
        )))
    );
    assert_state(&env, &vault, 0, false);
    // The SDK surfaces a legacy Wasm auth trap as Context/InvalidAction. Use the
    // same invocation with the real admin as a positive control for the failure.
    mock_admin(&env, &vault, "upgrade", (&hash,).into_val(&env));
    env.invoke_contract::<()>(
        &vault.id,
        &symbol_short!("upgrade"),
        (&hash,).into_val(&env),
    );
    assert_state(&env, &vault, 0, false);
    assert_eq!(
        AgentVaultClient::new(&env, &vault.id).pending_upgrade(),
        None
    );
}

#[test]
#[ignore = "requires fresh Wasm: set AGENT_VAULT_WASM and run with --include-ignored"]
fn test_execute_upgrade_by_admin_swaps_wasm_and_keeps_state() {
    let wasm = current_wasm();
    let env = test_env();
    // Both sides are the current executable; never downgrade to the old fixture.
    let vault = register(&env, wasm.as_slice());
    let client = AgentVaultClient::new(&env, &vault.id);
    assert_eq!(payment(&env, &vault, &vault.payee, 1_500_000), Ok(()));
    let hash = env.deployer().upload_contract_wasm(wasm.as_slice());
    mock_admin(&env, &vault, "propose_upgrade", (&hash,).into_val(&env));
    client.propose_upgrade(&hash);
    let ready = env.ledger().sequence() + client.upgrade_timelock_ledgers();
    assert_eq!(client.pending_upgrade(), Some((hash.clone(), ready)));
    env.ledger().set_sequence_number(ready);
    mock_admin(&env, &vault, "execute_upgrade", ().into_val(&env));
    client.execute_upgrade();
    assert_upgraded_event(&env, &vault.id, &hash);
    assert_eq!(client.pending_upgrade(), None);
    assert_state(&env, &vault, 1_500_000, false);
    assert_eq!(payment(&env, &vault, &vault.other_payee, 1_000_000), Ok(()));
    assert_eq!(
        payment(&env, &vault, &vault.other_payee, 4_000_001),
        Err(Error::DailyCapExceeded)
    );
    assert_state(&env, &vault, 2_500_000, false);
}
