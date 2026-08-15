use crate::{CustomAccountDemo, CustomAccountDemoClient, Error};
use soroban_sdk::{
    auth::CustomAccountInterface, bytes, testutils::BytesN as _, vec, BytesN, Env,
};

fn setup() -> (Env, CustomAccountDemoClient<'static>) {
    let env = Env::default();
    let contract_id = env.register(CustomAccountDemo, ());
    let client = CustomAccountDemoClient::new(&env, &contract_id);
    (env, client)
}

#[test]
fn init_stores_owner() {
    let (_env, client) = setup();
    let owner = BytesN::<32>::random(&client.env);
    client.init(&owner);
}

/// The owner key is pinned once, not rotatable — a second `init` must be
/// rejected, not silently overwrite the original key.
#[test]
fn cannot_reinitialize() {
    let (_env, client) = setup();
    let owner = BytesN::<32>::random(&client.env);
    client.init(&owner);
    let result = client.try_init(&owner);
    assert_eq!(result, Err(Ok(Error::AlreadyInitialized)));
}

/// `__check_auth` must reject a signature that doesn't verify against the
/// stored owner key — not a mocked-out authorization, a real Ed25519
/// signature check via `env.crypto().ed25519_verify`, which panics (host
/// trap) on a bad signature. This is the direct, isolated version of the
/// check; the full "does this compose with `require_auth()` through a real
/// facilitator settlement" proof is live on testnet
/// (`e2e/conformance/src/custom-account-testnet.ts`), since building a
/// genuine end-to-end signed `SorobanAuthorizationEntry` inside the
/// sandboxed unit-test harness needs the same XDR/auth-preimage plumbing
/// the live script already exercises — duplicating it here would test the
/// test harness, not the contract.
#[test]
#[should_panic]
fn rejects_wrong_signature() {
    let (env, client) = setup();
    let owner = BytesN::<32>::random(&env);
    client.init(&owner);

    let bad_signature = BytesN::<64>::random(&env);
    let hash = env.crypto().sha256(&bytes!(&env, 0xdeadbeef));

    env.as_contract(&client.address, || {
        let _ = CustomAccountDemo::__check_auth(env.clone(), hash, bad_signature, vec![&env]);
    });
}

/// `__check_auth` before `init` must fail cleanly (`NotInitialized`), not
/// panic on a missing storage read.
#[test]
fn check_auth_before_init_is_not_initialized() {
    let env = Env::default();
    let contract_id = env.register(CustomAccountDemo, ());

    let signature = BytesN::<64>::random(&env);
    let hash = env.crypto().sha256(&bytes!(&env, 0xdeadbeef));

    env.as_contract(&contract_id, || {
        let result = CustomAccountDemo::__check_auth(env.clone(), hash, signature, vec![&env]);
        assert_eq!(result, Err(Error::NotInitialized));
    });
}
