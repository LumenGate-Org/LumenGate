use crate::{Error, SpendingPolicyAccount, SpendingPolicyAccountClient};
use ed25519_dalek::{Signer, SigningKey};
use soroban_sdk::{
    auth::{Context, ContractContext, CustomAccountInterface},
    bytes,
    crypto::Hash,
    testutils::{Address as _, BytesN as _, Ledger},
    vec, Address, BytesN, Env, IntoVal, Symbol,
};

const DAY: u64 = 86_400;
// Any fixed 32 bytes work as an Ed25519 seed; deterministic on purpose so
// tests don't need an RNG dependency.
const OWNER_SEED: [u8; 32] = [7u8; 32];

fn owner_keypair(env: &Env) -> (SigningKey, BytesN<32>) {
    let sk = SigningKey::from_bytes(&OWNER_SEED);
    let pubkey = BytesN::<32>::from_array(env, &sk.verifying_key().to_bytes());
    (sk, pubkey)
}

fn sign(env: &Env, sk: &SigningKey, hash: &Hash<32>) -> BytesN<64> {
    let sig = sk.sign(&hash.to_array());
    BytesN::<64>::from_array(env, &sig.to_bytes())
}

fn setup(
    ceiling: i128,
    period_seconds: u64,
) -> (Env, SpendingPolicyAccountClient<'static>, Address, SigningKey) {
    let env = Env::default();
    let contract_id = env.register(SpendingPolicyAccount, ());
    let client = SpendingPolicyAccountClient::new(&env, &contract_id);
    let token = Address::generate(&env);
    let (sk, pubkey) = owner_keypair(&env);
    client.init(&pubkey, &token, &ceiling, &period_seconds);
    (env, client, token, sk)
}

/// Builds the `auth_contexts` a real settlement authorizing a single
/// `token.transfer(from, to, amount)` sub-invocation would carry — the
/// shape every settlement path this project ships actually produces (a
/// direct transfer for `exact`, the escrow pull for `upto`).
fn transfer_context(
    env: &Env,
    token: &Address,
    from: &Address,
    to: &Address,
    amount: i128,
) -> Context {
    Context::Contract(ContractContext {
        contract: token.clone(),
        fn_name: Symbol::new(env, "transfer"),
        args: (from.clone(), to.clone(), amount).into_val(env),
    })
}

fn check_auth_valid_sig(
    env: &Env,
    contract_id: &Address,
    sk: &SigningKey,
    contexts: soroban_sdk::Vec<Context>,
) -> Result<(), Error> {
    let hash: Hash<32> = env.crypto().sha256(&bytes!(env, 0xdeadbeef));
    let signature = sign(env, sk, &hash);
    env.as_contract(contract_id, || {
        SpendingPolicyAccount::__check_auth(env.clone(), hash.clone(), signature.clone(), contexts)
    })
}

#[test]
fn within_budget_transfer_succeeds() {
    let (env, client, token, sk) = setup(1_000, DAY);
    let from = Address::generate(&env);
    let to = Address::generate(&env);
    let ctx = transfer_context(&env, &token, &from, &to, 400);

    let result = check_auth_valid_sig(&env, &client.address, &sk, vec![&env, ctx]);
    assert_eq!(result, Ok(()));
    assert_eq!(client.remaining_budget(), 600);
}

#[test]
fn over_budget_transfer_is_rejected() {
    let (env, client, token, sk) = setup(1_000, DAY);
    let from = Address::generate(&env);
    let to = Address::generate(&env);
    let ctx = transfer_context(&env, &token, &from, &to, 1_001);

    let result = check_auth_valid_sig(&env, &client.address, &sk, vec![&env, ctx]);
    assert_eq!(result, Err(Error::BudgetExceeded));
    // A rejected authorization must not consume any of the budget.
    assert_eq!(client.remaining_budget(), 1_000);
}

#[test]
fn exactly_at_ceiling_is_allowed_one_unit_over_is_not() {
    let (env, client, token, sk) = setup(1_000, DAY);
    let from = Address::generate(&env);
    let to = Address::generate(&env);

    let at_ceiling = transfer_context(&env, &token, &from, &to, 1_000);
    let result = check_auth_valid_sig(&env, &client.address, &sk, vec![&env, at_ceiling]);
    assert_eq!(result, Ok(()));
    assert_eq!(client.remaining_budget(), 0);

    // Same period, one more unit requested — the ceiling is already spent.
    let one_more = transfer_context(&env, &token, &from, &to, 1);
    let result = check_auth_valid_sig(&env, &client.address, &sk, vec![&env, one_more]);
    assert_eq!(result, Err(Error::BudgetExceeded));
}

#[test]
fn multiple_transfers_in_the_same_call_accumulate_toward_the_ceiling() {
    let (env, client, token, sk) = setup(1_000, DAY);
    let from = Address::generate(&env);
    let to = Address::generate(&env);

    // A single authorized invocation carrying two transfer sub-contexts
    // against the governed token — both must count toward the same budget.
    let ctx_a = transfer_context(&env, &token, &from, &to, 600);
    let ctx_b = transfer_context(&env, &token, &from, &to, 500);

    let result = check_auth_valid_sig(&env, &client.address, &sk, vec![&env, ctx_a, ctx_b]);
    assert_eq!(result, Err(Error::BudgetExceeded));
    assert_eq!(client.remaining_budget(), 1_000);
}

#[test]
fn spend_accumulates_across_separate_calls_within_the_same_period() {
    let (env, client, token, sk) = setup(1_000, DAY);
    let from = Address::generate(&env);
    let to = Address::generate(&env);

    let first = transfer_context(&env, &token, &from, &to, 600);
    assert_eq!(
        check_auth_valid_sig(&env, &client.address, &sk, vec![&env, first]),
        Ok(())
    );
    assert_eq!(client.remaining_budget(), 400);

    // A second, separate call in the same period must be checked against
    // what's already been spent, not a fresh ceiling.
    let second = transfer_context(&env, &token, &from, &to, 500);
    assert_eq!(
        check_auth_valid_sig(&env, &client.address, &sk, vec![&env, second]),
        Err(Error::BudgetExceeded)
    );
    assert_eq!(client.remaining_budget(), 400);
}

#[test]
fn budget_resets_when_the_period_rolls_over() {
    let (env, client, token, sk) = setup(1_000, DAY);
    let from = Address::generate(&env);
    let to = Address::generate(&env);

    let first = transfer_context(&env, &token, &from, &to, 900);
    assert_eq!(
        check_auth_valid_sig(&env, &client.address, &sk, vec![&env, first.clone()]),
        Ok(())
    );
    assert_eq!(client.remaining_budget(), 100);

    // Still the same period: a request that would exceed the remaining 100
    // is rejected.
    let still_same_period =
        transfer_context(&env, &token, &from, &to, 200);
    assert_eq!(
        check_auth_valid_sig(&env, &client.address, &sk, vec![&env, still_same_period]),
        Err(Error::BudgetExceeded)
    );

    // Advance the ledger timestamp past the period boundary.
    env.ledger().with_mut(|li| li.timestamp += DAY);
    assert_eq!(client.remaining_budget(), 1_000);

    // The same 900-unit request that succeeded before now succeeds again,
    // in the new period, proving the reset actually happened rather than
    // the old spend silently carrying over.
    let same_amount_new_period = transfer_context(&env, &token, &from, &to, 900);
    assert_eq!(
        check_auth_valid_sig(&env, &client.address, &sk, vec![&env, same_amount_new_period]),
        Ok(())
    );
    assert_eq!(client.remaining_budget(), 100);
}

#[test]
fn an_authorization_with_no_recognized_transfer_is_rejected() {
    let (env, client, token, sk) = setup(1_000, DAY);
    let from = Address::generate(&env);

    // Some other function call against the governed token — not "transfer" —
    // must not be silently allowed just because the signature checks out.
    let ctx = Context::Contract(ContractContext {
        contract: token.clone(),
        fn_name: Symbol::new(&env, "approve"),
        args: (from.clone(), 500i128).into_val(&env),
    });

    let result = check_auth_valid_sig(&env, &client.address, &sk, vec![&env, ctx]);
    assert_eq!(result, Err(Error::NoRecognizedTransfer));
}

/// A same-named `"transfer"` call against the *correct* token but with the
/// wrong arg shape (only two args instead of SEP-41's three) must be
/// rejected cleanly, not trap the host — covers a misconfigured governed
/// token exposing a non-standard function under a colliding name, without
/// requiring an actual malformed token contract to reproduce.
#[test]
fn a_transfer_shaped_call_with_the_wrong_arity_is_rejected_cleanly() {
    let (env, client, token, sk) = setup(1_000, DAY);
    let from = Address::generate(&env);

    let ctx = Context::Contract(ContractContext {
        contract: token.clone(),
        fn_name: Symbol::new(&env, "transfer"),
        args: (from.clone(), 500i128).into_val(&env), // missing the `to` arg
    });

    let result = check_auth_valid_sig(&env, &client.address, &sk, vec![&env, ctx]);
    assert_eq!(result, Err(Error::NoRecognizedTransfer));
    assert_eq!(client.remaining_budget(), 1_000);
}

#[test]
fn a_transfer_against_a_different_token_is_not_recognized() {
    let (env, client, _token, sk) = setup(1_000, DAY);
    let other_token = Address::generate(&env);
    let from = Address::generate(&env);
    let to = Address::generate(&env);

    let ctx = transfer_context(&env, &other_token, &from, &to, 1);
    let result = check_auth_valid_sig(&env, &client.address, &sk, vec![&env, ctx]);
    assert_eq!(result, Err(Error::NoRecognizedTransfer));
}

/// A real Ed25519 signature check, not a mocked-out authorization — matches
/// `contracts/custom-account-demo`'s `rejects_wrong_signature` precedent.
/// The full "does this compose with `require_auth()` through a real
/// facilitator settlement, with a genuinely signed `SorobanAuthorizationEntry`"
/// proof is live on testnet, since building that inside the sandboxed
/// unit-test harness would test the test harness, not the contract.
#[test]
#[should_panic]
fn rejects_invalid_signature_regardless_of_budget() {
    let (env, client, token, _sk) = setup(1_000, DAY);
    let from = Address::generate(&env);
    let to = Address::generate(&env);
    let ctx = transfer_context(&env, &token, &from, &to, 1);

    let bad_signature = BytesN::<64>::random(&env);
    let hash = env.crypto().sha256(&bytes!(&env, 0xdeadbeef));
    env.as_contract(&client.address, || {
        let _ = SpendingPolicyAccount::__check_auth(
            env.clone(),
            hash,
            bad_signature,
            vec![&env, ctx],
        );
    });
}

#[test]
fn cannot_reinitialize() {
    let (_env, client, token, sk) = setup(1_000, DAY);
    let (_sk2, pubkey) = owner_keypair(&client.env);
    let _ = sk;
    let result = client.try_init(&pubkey, &token, &1_000, &DAY);
    assert_eq!(result, Err(Ok(Error::AlreadyInitialized)));
}

#[test]
fn rejects_zero_or_negative_ceiling() {
    let env = Env::default();
    let contract_id = env.register(SpendingPolicyAccount, ());
    let client = SpendingPolicyAccountClient::new(&env, &contract_id);
    let token = Address::generate(&env);
    let (_sk, pubkey) = owner_keypair(&env);

    let result = client.try_init(&pubkey, &token, &0, &DAY);
    assert_eq!(result, Err(Ok(Error::InvalidCeiling)));
}

#[test]
fn rejects_zero_period_seconds() {
    let env = Env::default();
    let contract_id = env.register(SpendingPolicyAccount, ());
    let client = SpendingPolicyAccountClient::new(&env, &contract_id);
    let token = Address::generate(&env);
    let (_sk, pubkey) = owner_keypair(&env);

    let result = client.try_init(&pubkey, &token, &1_000, &0);
    assert_eq!(result, Err(Ok(Error::InvalidPeriodSeconds)));
}

#[test]
fn check_auth_before_init_is_not_initialized() {
    let env = Env::default();
    let contract_id = env.register(SpendingPolicyAccount, ());
    let (sk, _pubkey) = owner_keypair(&env);
    let token = Address::generate(&env);
    let from = Address::generate(&env);
    let to = Address::generate(&env);
    let ctx = transfer_context(&env, &token, &from, &to, 1);

    let result = check_auth_valid_sig(&env, &contract_id, &sk, vec![&env, ctx]);
    assert_eq!(result, Err(Error::NotInitialized));
}
