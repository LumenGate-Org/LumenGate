#![cfg(test)]

use super::{UptoSettlement, UptoSettlementClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke},
    token, Address, Env, IntoVal,
};

struct TestSetup {
    env: Env,
    contract: UptoSettlementClient<'static>,
    contract_id: Address,
    token: Address,
    from: Address,
    pay_to: Address,
    facilitator: Address,
}

/// Registers the settlement contract, a mock SEP-41 asset, and mints `budget`
/// units to `from`, who then approves the settlement contract to spend up to
/// `budget`. Mirrors the real one-time-approval prerequisite documented in
/// `specs/scheme_upto_stellar.md`.
fn setup(budget: i128) -> TestSetup {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let contract_id = env.register(UptoSettlement, ());
    let contract = UptoSettlementClient::new(&env, &contract_id);

    let issuer = Address::generate(&env);
    let asset_contract = env.register_stellar_asset_contract_v2(issuer);
    let token = asset_contract.address();
    let token_client = token::TokenClient::new(&env, &token);

    let from = Address::generate(&env);
    let pay_to = Address::generate(&env);
    let facilitator = Address::generate(&env);

    token::StellarAssetClient::new(&env, &token).mint(&from, &budget);
    token_client.approve(&from, &contract_id, &budget, &(env.ledger().sequence() + 1_000));

    TestSetup {
        env,
        contract,
        contract_id,
        token,
        from,
        pay_to,
        facilitator,
    }
}

#[test]
fn standard_upto_pays_full_actual_amount_to_seller() {
    let s = setup(1_000);
    let token_client = token::TokenClient::new(&s.env, &s.token);

    let (seller_amount, fee) = s.contract.settle(
        &s.from,
        &s.pay_to,
        &s.facilitator,
        &s.token,
        &1_000,
        &750,
        &1,
        &(s.env.ledger().timestamp() + 60),
        &0, // fee_bps = 0 -> standard upto, no on-chain fee split
    );

    assert_eq!(seller_amount, 750);
    assert_eq!(fee, 0);
    assert_eq!(token_client.balance(&s.pay_to), 750);
    assert_eq!(token_client.balance(&s.facilitator), 0);
    assert_eq!(token_client.balance(&s.from), 250);
    assert!(s.contract.is_settled(&s.from, &1));
}

#[test]
fn managed_upto_splits_fee_atomically_on_chain() {
    let s = setup(1_000);
    let token_client = token::TokenClient::new(&s.env, &s.token);

    // 10% fee (1000 bps), well under the 2000 bps ceiling.
    let (seller_amount, fee) = s.contract.settle(
        &s.from,
        &s.pay_to,
        &s.facilitator,
        &s.token,
        &1_000,
        &1_000,
        &1,
        &(s.env.ledger().timestamp() + 60),
        &1_000,
    );

    assert_eq!(fee, 100);
    assert_eq!(seller_amount, 900);
    assert_eq!(token_client.balance(&s.pay_to), 900);
    assert_eq!(token_client.balance(&s.facilitator), 100);
}

#[test]
fn zero_settlement_moves_no_funds_but_consumes_nonce() {
    let s = setup(1_000);
    let token_client = token::TokenClient::new(&s.env, &s.token);

    let (seller_amount, fee) = s.contract.settle(
        &s.from,
        &s.pay_to,
        &s.facilitator,
        &s.token,
        &1_000,
        &0,
        &1,
        &(s.env.ledger().timestamp() + 60),
        &500,
    );

    assert_eq!((seller_amount, fee), (0, 0));
    assert_eq!(token_client.balance(&s.pay_to), 0);
    assert_eq!(token_client.balance(&s.from), 1_000);
    assert!(s.contract.is_settled(&s.from, &1));
}

#[test]
fn nonce_cannot_be_settled_twice() {
    let s = setup(1_000);

    s.contract.settle(
        &s.from, &s.pay_to, &s.facilitator, &s.token, &1_000, &400, &7,
        &(s.env.ledger().timestamp() + 60), &0,
    );

    let result = s.contract.try_settle(
        &s.from, &s.pay_to, &s.facilitator, &s.token, &1_000, &200, &7,
        &(s.env.ledger().timestamp() + 60), &0,
    );
    assert!(result.is_err(), "replaying a settled nonce must fail");
}

#[test]
fn expired_deadline_is_rejected() {
    let s = setup(1_000);
    s.env.ledger().set_timestamp(10_000);

    let result = s.contract.try_settle(
        &s.from, &s.pay_to, &s.facilitator, &s.token, &1_000, &100, &1,
        &9_999, // deadline already in the past
        &0,
    );
    assert!(result.is_err());
}

#[test]
fn actual_amount_above_max_is_rejected() {
    let s = setup(1_000);

    let result = s.contract.try_settle(
        &s.from, &s.pay_to, &s.facilitator, &s.token, &500, &600, &1,
        &(s.env.ledger().timestamp() + 60), &0,
    );
    assert!(result.is_err());
}

#[test]
fn fee_above_ceiling_is_rejected() {
    let s = setup(1_000);

    // 2500 bps (25%) exceeds the contract's 2000 bps (20%) hard ceiling.
    let result = s.contract.try_settle(
        &s.from, &s.pay_to, &s.facilitator, &s.token, &1_000, &1_000, &1,
        &(s.env.ledger().timestamp() + 60), &2_500,
    );
    assert!(result.is_err());
}

#[test]
fn facilitator_cannot_be_the_payer() {
    let s = setup(1_000);

    let result = s.contract.try_settle(
        &s.from, &s.pay_to, &s.from, &s.token, &1_000, &100, &1,
        &(s.env.ledger().timestamp() + 60), &500,
    );
    assert!(result.is_err());
}

#[test]
fn facilitator_cannot_be_the_payee() {
    let s = setup(1_000);

    let result = s.contract.try_settle(
        &s.from, &s.pay_to, &s.pay_to, &s.token, &1_000, &100, &1,
        &(s.env.ledger().timestamp() + 60), &500,
    );
    assert!(result.is_err());
}

/// Proves the `facilitator.require_auth()` fix actually closes the bearer-
/// credential gap: with `from`'s witness authorized but *no* matching
/// authorization for `facilitator`, settlement must fail. Deliberately uses
/// selective `mock_auths` (not the blanket `mock_all_auths` every other test
/// uses) so this test exercises real Soroban auth-matching semantics rather
/// than the always-approve mock — `mock_all_auths` alone cannot prove a
/// missing `require_auth` check, since it approves every check indiscriminately.
#[test]
#[should_panic]
fn settling_without_the_facilitators_authorization_fails() {
    let s = setup(1_000);
    let actual_amount = 300i128;
    let deadline = s.env.ledger().timestamp() + 60;
    let witness_args: soroban_sdk::Vec<soroban_sdk::Val> = (
        s.from.clone(),
        s.pay_to.clone(),
        s.facilitator.clone(),
        s.token.clone(),
        1_000i128,
        1u64,
        deadline,
        0u32,
    )
        .into_val(&s.env);

    // Only `from`'s witness is authorized here — `facilitator` is deliberately
    // omitted, simulating a party other than the facilitator (e.g. the
    // resource server, which per the protocol flow receives the witness
    // before the facilitator does) attempting to submit the settlement itself.
    s.contract
        .mock_auths(&[MockAuth {
            address: &s.from,
            invoke: &MockAuthInvoke {
                contract: &s.contract_id,
                fn_name: "settle",
                args: witness_args,
                sub_invokes: &[],
            },
        }])
        .settle(
            &s.from,
            &s.pay_to,
            &s.facilitator,
            &s.token,
            &1_000,
            &actual_amount,
            &1,
            &deadline,
            &0,
        );
}

/// Positive counterpart to the above: with *both* `from`'s witness and
/// `facilitator`'s authorization present (selectively, not blanket-mocked),
/// settlement succeeds — proving the new check doesn't just fail closed, it
/// also permits the legitimate case.
#[test]
fn settling_with_the_facilitators_authorization_succeeds() {
    let s = setup(1_000);
    let token_client = token::TokenClient::new(&s.env, &s.token);
    let actual_amount = 300i128;
    let deadline = s.env.ledger().timestamp() + 60;
    let witness_args: soroban_sdk::Vec<soroban_sdk::Val> = (
        s.from.clone(),
        s.pay_to.clone(),
        s.facilitator.clone(),
        s.token.clone(),
        1_000i128,
        1u64,
        deadline,
        0u32,
    )
        .into_val(&s.env);
    let full_call_args: soroban_sdk::Vec<soroban_sdk::Val> = (
        s.from.clone(),
        s.pay_to.clone(),
        s.facilitator.clone(),
        s.token.clone(),
        1_000i128,
        actual_amount,
        1u64,
        deadline,
        0u32,
    )
        .into_val(&s.env);

    s.contract
        .mock_auths(&[
            MockAuth {
                address: &s.from,
                invoke: &MockAuthInvoke {
                    contract: &s.contract_id,
                    fn_name: "settle",
                    args: witness_args,
                    sub_invokes: &[],
                },
            },
            MockAuth {
                address: &s.facilitator,
                invoke: &MockAuthInvoke {
                    contract: &s.contract_id,
                    fn_name: "settle",
                    args: full_call_args,
                    sub_invokes: &[],
                },
            },
        ])
        .settle(
            &s.from,
            &s.pay_to,
            &s.facilitator,
            &s.token,
            &1_000,
            &actual_amount,
            &1,
            &deadline,
            &0,
        );

    assert_eq!(token_client.balance(&s.pay_to), actual_amount);
}

#[test]
fn max_fee_bps_query_matches_documented_ceiling() {
    let s = setup(1_000);
    assert_eq!(s.contract.max_fee_bps(), 2_000);
}

#[test]
fn distinct_nonces_from_same_payer_both_settle() {
    let s = setup(1_000);
    let token_client = token::TokenClient::new(&s.env, &s.token);

    s.contract.settle(
        &s.from, &s.pay_to, &s.facilitator, &s.token, &1_000, &300, &1,
        &(s.env.ledger().timestamp() + 60), &0,
    );
    s.contract.settle(
        &s.from, &s.pay_to, &s.facilitator, &s.token, &1_000, &300, &2,
        &(s.env.ledger().timestamp() + 60), &0,
    );

    assert_eq!(token_client.balance(&s.pay_to), 600);
    assert!(s.contract.is_settled(&s.from, &1));
    assert!(s.contract.is_settled(&s.from, &2));
}

#[test]
fn cancel_blocks_a_later_settlement_attempt_with_the_same_nonce() {
    let s = setup(1_000);

    s.contract.cancel(&s.from, &1);
    assert!(s.contract.is_settled(&s.from, &1));

    let result = s.contract.try_settle(
        &s.from, &s.pay_to, &s.facilitator, &s.token, &1_000, &300, &1,
        &(s.env.ledger().timestamp() + 60), &0,
    );
    assert!(result.is_err(), "a cancelled nonce must not be settleable");
}

#[test]
fn cancel_does_not_affect_other_nonces_from_the_same_payer() {
    let s = setup(1_000);
    let token_client = token::TokenClient::new(&s.env, &s.token);

    s.contract.cancel(&s.from, &1);

    s.contract.settle(
        &s.from, &s.pay_to, &s.facilitator, &s.token, &1_000, &300, &2,
        &(s.env.ledger().timestamp() + 60), &0,
    );

    assert!(s.contract.is_settled(&s.from, &1));
    assert_eq!(token_client.balance(&s.pay_to), 300);
}

#[test]
fn cancelling_an_already_settled_nonce_fails() {
    let s = setup(1_000);

    s.contract.settle(
        &s.from, &s.pay_to, &s.facilitator, &s.token, &1_000, &300, &1,
        &(s.env.ledger().timestamp() + 60), &0,
    );

    let result = s.contract.try_cancel(&s.from, &1);
    assert!(result.is_err(), "cannot cancel a nonce that's already settled");
}

#[test]
fn cancelling_twice_fails_the_second_time() {
    let s = setup(1_000);

    s.contract.cancel(&s.from, &1);
    let result = s.contract.try_cancel(&s.from, &1);
    assert!(result.is_err());
}

/// Mirrors `settling_without_the_facilitators_authorization_fails`: proves
/// `cancel` genuinely requires the payer's own signature, using selective
/// `mock_auths` rather than the blanket `mock_all_auths` every other test
/// uses (which would approve this even if the `require_auth()` call were
/// accidentally removed).
#[test]
#[should_panic]
fn cancelling_without_the_payers_authorization_fails() {
    let s = setup(1_000);
    // No mock_auths at all for this call — `from` never authorizes anything.
    s.contract.mock_auths(&[]).cancel(&s.from, &1);
}
