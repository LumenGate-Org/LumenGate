#![cfg(test)]

use super::{UptoEscrowSettlement, UptoEscrowSettlementClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke},
    token, Address, Env, IntoVal, Val,
};

struct TestSetup {
    env: Env,
    contract: UptoEscrowSettlementClient<'static>,
    contract_id: Address,
    token: Address,
    from: Address,
    pay_to: Address,
    facilitator: Address,
}

/// Registers the escrow settlement contract and a mock SEP-41 asset, and
/// mints `budget` units to `from`. Unlike Design A's `setup`, there is no
/// `approve` step — this design needs no SEP-41 allowance at all.
fn setup(budget: i128) -> TestSetup {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let contract_id = env.register(UptoEscrowSettlement, ());
    let contract = UptoEscrowSettlementClient::new(&env, &contract_id);

    let issuer = Address::generate(&env);
    let asset_contract = env.register_stellar_asset_contract_v2(issuer);
    let token = asset_contract.address();

    let from = Address::generate(&env);
    let pay_to = Address::generate(&env);
    let facilitator = Address::generate(&env);

    token::StellarAssetClient::new(&env, &token).mint(&from, &budget);

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

fn witness_args(s: &TestSetup, max_amount: i128, request_nonce: u64, deadline: u64, fee_bps: u32) -> soroban_sdk::Vec<Val> {
    (
        s.from.clone(),
        s.pay_to.clone(),
        s.facilitator.clone(),
        s.token.clone(),
        max_amount,
        request_nonce,
        deadline,
        fee_bps,
    )
        .into_val(&s.env)
}

#[test]
fn standard_upto_pays_full_actual_amount_to_seller_and_refunds_the_rest() {
    let s = setup(1_000);
    let token_client = token::TokenClient::new(&s.env, &s.token);

    let (seller_amount, fee, refund) = s.contract.settle(
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

    assert_eq!((seller_amount, fee, refund), (750, 0, 250));
    assert_eq!(token_client.balance(&s.pay_to), 750);
    assert_eq!(token_client.balance(&s.facilitator), 0);
    assert_eq!(token_client.balance(&s.from), 250);
    assert_eq!(token_client.balance(&s.contract_id), 0); // nothing left in escrow
}

#[test]
fn managed_upto_splits_fee_atomically_on_chain() {
    let s = setup(1_000);
    let token_client = token::TokenClient::new(&s.env, &s.token);

    // 10% fee (1000 bps), well under the 2000 bps ceiling.
    let (seller_amount, fee, refund) = s.contract.settle(
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

    assert_eq!((seller_amount, fee, refund), (900, 100, 0));
    assert_eq!(token_client.balance(&s.pay_to), 900);
    assert_eq!(token_client.balance(&s.facilitator), 100);
    assert_eq!(token_client.balance(&s.from), 0);
}

#[test]
fn zero_max_amount_moves_no_funds() {
    let s = setup(1_000);
    let token_client = token::TokenClient::new(&s.env, &s.token);

    let (seller_amount, fee, refund) = s.contract.settle(
        &s.from,
        &s.pay_to,
        &s.facilitator,
        &s.token,
        &0,
        &0,
        &1,
        &(s.env.ledger().timestamp() + 60),
        &0,
    );

    assert_eq!((seller_amount, fee, refund), (0, 0, 0));
    assert_eq!(token_client.balance(&s.from), 1_000); // untouched
    assert_eq!(token_client.balance(&s.contract_id), 0);
}

#[test]
fn zero_actual_amount_refunds_the_full_max_amount() {
    let s = setup(1_000);
    let token_client = token::TokenClient::new(&s.env, &s.token);

    let (seller_amount, fee, refund) = s.contract.settle(
        &s.from,
        &s.pay_to,
        &s.facilitator,
        &s.token,
        &500,
        &0,
        &1,
        &(s.env.ledger().timestamp() + 60),
        &500,
    );

    assert_eq!((seller_amount, fee, refund), (0, 0, 500));
    assert_eq!(token_client.balance(&s.from), 1_000); // fully refunded
    assert_eq!(token_client.balance(&s.pay_to), 0);
    assert_eq!(token_client.balance(&s.contract_id), 0);
}

#[test]
fn rejects_expired_deadline() {
    let s = setup(1_000);
    let result = s.contract.try_settle(
        &s.from, &s.pay_to, &s.facilitator, &s.token,
        &1_000, &500, &1, &(s.env.ledger().timestamp() - 1), &0,
    );
    assert!(result.is_err());
}

#[test]
fn rejects_actual_amount_exceeding_max() {
    let s = setup(1_000);
    let result = s.contract.try_settle(
        &s.from, &s.pay_to, &s.facilitator, &s.token,
        &500, &600, &1, &(s.env.ledger().timestamp() + 60), &0,
    );
    assert!(result.is_err());
}

#[test]
fn rejects_fee_bps_above_ceiling() {
    let s = setup(1_000);
    let result = s.contract.try_settle(
        &s.from, &s.pay_to, &s.facilitator, &s.token,
        &1_000, &500, &1, &(s.env.ledger().timestamp() + 60), &2_001,
    );
    assert!(result.is_err());
}

#[test]
fn rejects_facilitator_as_payer() {
    let s = setup(1_000);
    let result = s.contract.try_settle(
        &s.from, &s.pay_to, &s.from, &s.token, // facilitator == from
        &1_000, &500, &1, &(s.env.ledger().timestamp() + 60), &0,
    );
    assert!(result.is_err());
}

#[test]
fn rejects_facilitator_as_pay_to() {
    let s = setup(1_000);
    let result = s.contract.try_settle(
        &s.from, &s.pay_to, &s.pay_to, &s.token, // facilitator == pay_to
        &1_000, &500, &1, &(s.env.ledger().timestamp() + 60), &0,
    );
    assert!(result.is_err());
}

#[test]
fn max_fee_bps_reports_the_hard_ceiling() {
    let s = setup(1_000);
    assert_eq!(s.contract.max_fee_bps(), 2_000);
}

/// Proves `facilitator.require_auth()` actually enforces something: with
/// `from`'s witness authorized but no matching authorization for
/// `facilitator`, settlement must fail. Deliberately uses selective
/// `mock_auths` (not the blanket `env.mock_all_auths()` every other test
/// uses) — see the equivalent test in `contracts/upto-settlement` for why
/// blanket mocking can't prove a missing check.
#[test]
#[should_panic]
fn settling_without_the_facilitators_authorization_fails() {
    let s = setup(1_000);
    let deadline = s.env.ledger().timestamp() + 60;
    let args = witness_args(&s, 1_000, 1, deadline, 0);
    let transfer_args: soroban_sdk::Vec<Val> =
        (s.from.clone(), s.contract_id.clone(), 1_000i128).into_val(&s.env);

    s.contract
        .mock_auths(&[MockAuth {
            address: &s.from,
            invoke: &MockAuthInvoke {
                contract: &s.contract_id,
                fn_name: "settle",
                args,
                sub_invokes: &[MockAuthInvoke {
                    contract: &s.token,
                    fn_name: "transfer",
                    args: transfer_args,
                    sub_invokes: &[],
                }],
            },
        }])
        .settle(
            &s.from, &s.pay_to, &s.facilitator, &s.token,
            &1_000, &500, &1, &deadline, &0,
        );
}

/// Positive counterpart: with both `from`'s witness (correctly nesting the
/// escrow transfer as a sub-invocation) and `facilitator`'s authorization
/// present, settlement succeeds — proving the required tree shape is
/// achievable by a well-behaved client, not just theoretically checked.
#[test]
fn settling_with_correct_nested_authorization_succeeds() {
    let s = setup(1_000);
    let token_client = token::TokenClient::new(&s.env, &s.token);
    let deadline = s.env.ledger().timestamp() + 60;
    let args = witness_args(&s, 1_000, 1, deadline, 0);
    let transfer_args: soroban_sdk::Vec<Val> =
        (s.from.clone(), s.contract_id.clone(), 1_000i128).into_val(&s.env);
    let full_call_args: soroban_sdk::Vec<Val> = (
        s.from.clone(), s.pay_to.clone(), s.facilitator.clone(), s.token.clone(),
        1_000i128, 500i128, 1u64, deadline, 0u32,
    )
        .into_val(&s.env);

    s.contract
        .mock_auths(&[
            MockAuth {
                address: &s.from,
                invoke: &MockAuthInvoke {
                    contract: &s.contract_id,
                    fn_name: "settle",
                    args,
                    sub_invokes: &[MockAuthInvoke {
                        contract: &s.token,
                        fn_name: "transfer",
                        args: transfer_args,
                        sub_invokes: &[],
                    }],
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
            &s.from, &s.pay_to, &s.facilitator, &s.token,
            &1_000, &500, &1, &deadline, &0,
        );

    assert_eq!(token_client.balance(&s.pay_to), 500);
    assert_eq!(token_client.balance(&s.from), 500);
}

/// THE key security property this design depends on. A naive escrow-refund
/// design has the buyer sign a plain `require_auth()` for
/// `token.transfer(buyer, contract, max_amount)` — a standalone bearer
/// credential, usable by anyone holding it, independent of `settle()`'s
/// refund/split logic ever running (see module docs). This test proves
/// this contract does NOT have that gap: the buyer's mocked authorization
/// is structurally scoped to `token.transfer` occurring *nested under*
/// `settle`, exactly as a real client's signed entry would be. Attempting
/// to invoke the SAME transfer call directly — as a standalone, top-level
/// call, bypassing `settle` entirely — must fail, because the actual
/// invocation tree (a bare top-level `transfer`) does not match the
/// authorized tree (`transfer` nested under `settle`). If this test did
/// NOT panic, that would mean the escrow pull is exploitable exactly like
/// the naive design's — this test is the difference between an asserted
/// fix and a proven one.
#[test]
#[should_panic]
fn escrow_pull_cannot_be_invoked_directly_outside_settle() {
    let s = setup(1_000);
    let deadline = s.env.ledger().timestamp() + 60;
    let settle_args = witness_args(&s, 1_000, 1, deadline, 0);
    let transfer_args: soroban_sdk::Vec<Val> =
        (s.from.clone(), s.contract_id.clone(), 1_000i128).into_val(&s.env);

    let token_client = token::TokenClient::new(&s.env, &s.token);

    // The mocked authorization's STRUCTURE says: `from`'s transfer(from,
    // contract_id, max_amount) is only authorized as a sub-invocation of
    // settle(settle_args) — matching exactly what a real signed entry from
    // a legitimate, well-behaved client would look like. It is NOT an
    // authorization for a standalone top-level transfer call.
    token_client
        .mock_auths(&[MockAuth {
            address: &s.from,
            invoke: &MockAuthInvoke {
                contract: &s.contract_id, // root is the SETTLEMENT contract, not the token
                fn_name: "settle",
                args: settle_args,
                sub_invokes: &[MockAuthInvoke {
                    contract: &s.token,
                    fn_name: "transfer",
                    args: transfer_args,
                    sub_invokes: &[],
                }],
            },
        }])
        // Direct call to `transfer`, bypassing `settle()` entirely — exactly
        // what a party holding an extracted/leaked signed entry would try.
        .transfer(&s.from, &s.contract_id, &1_000);
}
