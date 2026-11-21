//! Storage-layout, migration, TTL and payment-resource regressions for #733.
extern crate std;

use super::*;
use ed25519_dalek::{Signer as _, SigningKey};
use soroban_sdk::{
    auth::ContractContext,
    testutils::{
        storage::{Instance as _, Persistent as _},
        Address as _, EnvTestConfig, Ledger, MockAuth, MockAuthInvoke,
    },
    IntoVal,
};

struct Vault {
    id: Address,
    admin: Address,
    key: SigningKey,
    payees: Vec<Address>,
}

fn test_env() -> Env {
    let env = Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.budget().reset_unlimited();
    env
}

fn register(env: &Env, count: u32) -> Vault {
    let admin = Address::generate(env);
    let key = SigningKey::from_bytes(&[42; 32]);
    let pk = BytesN::from_array(env, &key.verifying_key().to_bytes());
    let mut payees = Vec::new(env);
    for _ in 0..count {
        payees.push_back(Address::generate(env));
    }
    let id = env.register(
        AgentVault,
        (admin.clone(), pk, 10_000_000_i128, Map::<Address, i128>::new(env), u32::MAX, 10_000_000_i128),
    );
    let vault = Vault { id, admin, key, payees };
    let client = AgentVaultClient::new(env, &vault.id);
    // Build large fixtures with individually bounded admin calls, just as an
    // operator grows an allowlist without an oversized constructor transaction.
    for payee in vault.payees.iter() {
        mock_admin(env, &vault, "add_to_allowlist", (&payee, 5_000_000_i128).into_val(env));
        client.add_to_allowlist(&payee, &5_000_000);
    }
    vault
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

// Native migration tests install the actual old key layout. Real executable
// replacement is covered separately in upgrade_tests.rs.
fn legacy_layout(env: &Env, vault: &Vault) {
    env.as_contract(&vault.id, || {
        let mut allowlist = Map::new(env);
        let persistent = env.storage().persistent();
        let spent: i128 = persistent.get(&LIFETIME_SPEND_KEY).unwrap();
        for payee in vault.payees.iter() {
            allowlist.set(payee.clone(), 5_000_000_i128);
            persistent.remove(&(PAYEE_PREFIX, payee));
        }
        persistent.remove(&LIFETIME_SPEND_KEY);
        let instance = env.storage().instance();
        instance.remove(&STORAGE_VERSION_KEY);
        instance.set(&LIST_KEY, &allowlist);
        instance.set(&LIFETIME_SPEND_KEY, &spent);
    });
}

fn persistent_ttls(env: &Env, vault: &Vault, payee: &Address) -> (u32, u32) {
    env.as_contract(&vault.id, || {
        let persistent = env.storage().persistent();
        (
            persistent.get_ttl(&(PAYEE_PREFIX, payee.clone())),
            persistent.get_ttl(&LIFETIME_SPEND_KEY),
        )
    })
}

#[test]
fn admin_write_bytes_do_not_grow_with_allowlist() {
    fn write_bytes(count: u32) -> u32 {
        let env = test_env();
        let vault = register(&env, count);
        mock_admin(&env, &vault, "set_daily_cap", (9_000_000_i128,).into_val(&env));
        AgentVaultClient::new(&env, &vault.id).set_daily_cap(&9_000_000);
        env.cost_estimate().resources().write_bytes
    }

    // #given the same admin write to the old shared instance entry with one and 500 payees
    let one = write_bytes(1);
    let five_hundred = write_bytes(500);
    // #then metering sees real writes, with only a small constant tolerance
    assert!(one > 0, "the resource oracle must observe admin writes");
    assert!(
        five_hundred <= one + 128,
        "instance writes grew with allowlist: one={one}, 500={five_hundred}"
    );
}

#[test]
fn constructor_keeps_allowlist_and_lifetime_spend_out_of_instance() {
    let env = test_env();
    let vault = register(&env, 2);
    let client = AgentVaultClient::new(&env, &vault.id);
    for payee in vault.payees.iter() {
        assert_eq!(client.allowlist_sub_cap(&payee), Some(5_000_000));
    }
    env.as_contract(&vault.id, || {
        assert!(!env.storage().instance().has(&LIST_KEY));
        assert!(!env.storage().instance().has(&LIFETIME_SPEND_KEY));
        assert_eq!(
            env.storage().persistent().get::<_, i128>(&LIFETIME_SPEND_KEY),
            Some(0)
        );
    });
}

#[test]
fn payment_extends_only_the_touched_payee_and_lifetime_entries() {
    let env = test_env();
    let vault = register(&env, 2);
    let first = vault.payees.get(0).unwrap();
    let second = vault.payees.get(1).unwrap();
    assert_eq!(persistent_ttls(&env, &vault, &first), (INSTANCE_TTL_EXTEND_TO, INSTANCE_TTL_EXTEND_TO));
    env.ledger().set_sequence_number(env.ledger().sequence() + 600_000);
    let before = persistent_ttls(&env, &vault, &second).0;
    assert!(before < INSTANCE_TTL_THRESHOLD);
    assert_eq!(payment(&env, &vault, &first, 1), Ok(()));
    assert_eq!(persistent_ttls(&env, &vault, &first), (INSTANCE_TTL_EXTEND_TO, INSTANCE_TTL_EXTEND_TO));
    assert_eq!(persistent_ttls(&env, &vault, &second).0, before);
}

#[test]
fn admin_allowlist_upsert_extends_its_persistent_entry() {
    let env = test_env();
    let vault = register(&env, 1);
    let payee = vault.payees.get(0).unwrap();
    let client = AgentVaultClient::new(&env, &vault.id);
    env.ledger().set_sequence_number(env.ledger().sequence() + 600_000);
    assert!(persistent_ttls(&env, &vault, &payee).0 < INSTANCE_TTL_THRESHOLD);
    mock_admin(&env, &vault, "add_to_allowlist", (&payee, 7_000_000_i128).into_val(&env));
    client.add_to_allowlist(&payee, &7_000_000);
    assert_eq!(client.allowlist_sub_cap(&payee), Some(7_000_000));
    assert_eq!(persistent_ttls(&env, &vault, &payee).0, INSTANCE_TTL_EXTEND_TO);
}

#[test]
fn ttl_hysteresis_leaves_recent_instance_and_payee_ttls_alone() {
    let env = test_env();
    let vault = register(&env, 1);
    let payee = vault.payees.get(0).unwrap();
    env.ledger().set_sequence_number(env.ledger().sequence() + 10);
    let before = persistent_ttls(&env, &vault, &payee);
    let instance_before = env.as_contract(&vault.id, || env.storage().instance().get_ttl());
    assert!(before.0 > INSTANCE_TTL_THRESHOLD);
    assert_eq!(payment(&env, &vault, &payee, 1), Ok(()));
    assert_eq!(persistent_ttls(&env, &vault, &payee), before);
    assert_eq!(
        env.as_contract(&vault.id, || env.storage().instance().get_ttl()),
        instance_before
    );
}

#[test]
fn migration_preserves_payees_nonzero_spend_and_daily_counters_once() {
    let env = test_env();
    let vault = register(&env, 2);
    let payee = vault.payees.get(0).unwrap();
    let client = AgentVaultClient::new(&env, &vault.id);
    assert_eq!(payment(&env, &vault, &payee, 43), Ok(()));
    legacy_layout(&env, &vault);
    assert_eq!(client.get_lifetime_spend(), 43);
    assert_eq!(payment(&env, &vault, &payee, 1), Err(Error::StorageMigrationRequired));
    mock_admin(&env, &vault, "migrate_storage", ().into_val(&env));
    client.migrate_storage();
    assert_eq!(client.get_lifetime_spend(), 43);
    for address in vault.payees.iter() {
        assert_eq!(client.allowlist_sub_cap(&address), Some(5_000_000));
        assert_eq!(persistent_ttls(&env, &vault, &address).0, INSTANCE_TTL_EXTEND_TO);
    }
    env.as_contract(&vault.id, || {
        assert!(!env.storage().instance().has(&LIST_KEY));
        assert!(!env.storage().instance().has(&LIFETIME_SPEND_KEY));
        assert_eq!(env.storage().temporary().get::<_, i128>(&(SPEND_PREFIX, 0_u32)), Some(43));
    });
    assert_eq!(payment(&env, &vault, &payee, 57), Ok(()));
    mock_admin(&env, &vault, "migrate_storage", ().into_val(&env));
    assert_eq!(client.try_migrate_storage(), Err(Ok(Error::StorageAlreadyMigrated.into())));
    assert_eq!(client.get_lifetime_spend(), 100);
}

#[test]
fn migration_requires_admin_and_rejects_legacy_mutations_until_migrated() {
    let env = test_env();
    let vault = register(&env, 1);
    legacy_layout(&env, &vault);
    let payee = vault.payees.get(0).unwrap();
    let client = AgentVaultClient::new(&env, &vault.id);
    let outsider = Address::generate(&env);
    env.mock_auths(&[MockAuth {
        address: &outsider,
        invoke: &MockAuthInvoke {
            contract: &vault.id,
            fn_name: "migrate_storage",
            args: ().into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(client.try_migrate_storage().is_err());
    mock_admin(&env, &vault, "remove_from_allowlist", (&payee,).into_val(&env));
    assert_eq!(
        client.try_remove_from_allowlist(&payee),
        Err(Ok(Error::StorageMigrationRequired.into()))
    );
    mock_admin(&env, &vault, "add_to_allowlist", (&payee, 1_i128).into_val(&env));
    assert_eq!(
        client.try_add_to_allowlist(&payee, &1),
        Err(Ok(Error::StorageMigrationRequired.into()))
    );
    // Positive control: the same migration with the preserved admin succeeds.
    mock_admin(&env, &vault, "migrate_storage", ().into_val(&env));
    client.migrate_storage();
    assert_eq!(client.allowlist_sub_cap(&payee), Some(5_000_000));
}

#[test]
fn missing_persistent_lifetime_spend_fails_closed() {
    let env = test_env();
    let vault = register(&env, 1);
    let payee = vault.payees.get(0).unwrap();
    assert_eq!(payment(&env, &vault, &payee, 43), Ok(()));
    env.as_contract(&vault.id, || env.storage().persistent().remove(&LIFETIME_SPEND_KEY));
    assert_eq!(payment(&env, &vault, &payee, 1), Err(Error::StorageUnavailable));
    assert_eq!(
        AgentVaultClient::new(&env, &vault.id).try_get_lifetime_spend(),
        Err(Ok(Error::StorageUnavailable.into()))
    );
}

#[test]
fn migration_refuses_a_missing_legacy_lifetime_counter() {
    let env = test_env();
    let vault = register(&env, 1);
    legacy_layout(&env, &vault);
    env.as_contract(&vault.id, || env.storage().instance().remove(&LIFETIME_SPEND_KEY));
    mock_admin(&env, &vault, "migrate_storage", ().into_val(&env));
    let client = AgentVaultClient::new(&env, &vault.id);
    assert_eq!(client.try_migrate_storage(), Err(Ok(Error::StorageUnavailable.into())));
    assert_eq!(client.allowlist_sub_cap(&vault.payees.get(0).unwrap()), Some(5_000_000));
    env.as_contract(&vault.id, || assert!(!env.storage().instance().has(&STORAGE_VERSION_KEY)));
}

#[test]
fn frozen_admin_traffic_keeps_the_lifetime_counter_alive() {
    let env = test_env();
    let vault = register(&env, 1);
    let payee = vault.payees.get(0).unwrap();
    env.ledger().set_sequence_number(env.ledger().sequence() + 600_000);
    let before = persistent_ttls(&env, &vault, &payee).0;
    assert!(before < INSTANCE_TTL_THRESHOLD);
    mock_admin(&env, &vault, "freeze", ().into_val(&env));
    AgentVaultClient::new(&env, &vault.id).freeze();
    assert_eq!(persistent_ttls(&env, &vault, &payee), (before, INSTANCE_TTL_EXTEND_TO));
}

#[test]
fn five_hundred_payees_migrate_in_bounded_batches_with_spend_preserved() {
    let env = test_env();
    let vault = register(&env, 500);
    let payee = vault.payees.get(0).unwrap();
    let client = AgentVaultClient::new(&env, &vault.id);
    assert_eq!(payment(&env, &vault, &payee, 43), Ok(()));
    legacy_layout(&env, &vault);
    let first_copied: Address = env.as_contract(&vault.id, || {
        let map: Map<Address, i128> = env.storage().instance().get(&LIST_KEY).unwrap();
        map.keys().get(0).unwrap()
    });
    let mut remaining = 500;
    let mut calls = 0;
    while remaining > 0 {
        mock_admin(&env, &vault, "migrate_storage", ().into_val(&env));
        let next = client.migrate_storage();
        let resources = env.cost_estimate().resources();
        assert!(resources.write_entries > 0, "the resource oracle must observe migration writes");
        assert!(resources.write_entries <= 200, "migration exceeds the network write-entry limit");
        assert!(resources.read_entries + resources.write_entries <= 400);
        assert!(resources.contract_events_size_bytes + 8 <= 16_384);
        assert!(next < remaining && remaining - next <= 64);
        remaining = next;
        calls += 1;
        assert_eq!(client.get_lifetime_spend(), 43);
        assert_eq!(client.allowlist_sub_cap(&first_copied), Some(5_000_000));
        if remaining > 0 {
            assert_eq!(payment(&env, &vault, &payee, 1), Err(Error::StorageMigrationRequired));
        }
    }
    assert_eq!(calls, 8, "500 entries need eight bounded migration calls");
    for address in vault.payees.iter() {
        assert_eq!(client.allowlist_sub_cap(&address), Some(5_000_000));
    }
    assert_eq!(payment(&env, &vault, &payee, 57), Ok(()));
    assert_eq!(client.get_lifetime_spend(), 100);
    mock_admin(&env, &vault, "migrate_storage", ().into_val(&env));
    assert_eq!(client.try_migrate_storage(), Err(Ok(Error::StorageAlreadyMigrated.into())));
}
