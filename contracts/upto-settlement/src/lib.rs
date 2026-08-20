//! x402UptoStellarSettlement
//!
//! Settlement contract implementing the x402 `upto` scheme on Stellar/Soroban.
//!
//! Soroban has no Permit2-style signature-witness contract: `Address::require_auth()`
//! commits cryptographically to a concrete (contract, function, args) invocation, so a
//! client cannot pre-sign a settlement for an amount that is only known after the
//! resource has been consumed. This contract resolves that with
//! `Address::require_auth_for_args`, which lets the contract check authorization
//! against a *synthetic* args tuple distinct from the actual call arguments: the
//! client signs one authorization committing to
//! `(from, pay_to, facilitator, token, max_amount, request_nonce, deadline, fee_bps)`
//! — deliberately excluding `actual_amount` — so a single signature authorizes any
//! later settlement with `0 <= actual_amount <= max_amount`, at the exact `fee_bps`
//! the client agreed to (the facilitator cannot raise its cut after the fact).
//!
//! Funds move via the SEP-41 allowance pattern (`approve` once, `transfer_from` per
//! settlement) rather than `transfer`, because `transfer` itself re-invokes
//! `require_auth()` on the literal call args (including the amount), which would
//! reintroduce the same "amount not known at signing time" problem one level down.
//! `transfer_from(spender = this contract, from, to, amount)` only requires the
//! *spender's* authorization, and a contract invoking a call with itself as the
//! spender self-authorizes — no additional client signature is needed at settlement
//! time beyond the one witness signed at request time.
//!
//! See `specs/scheme_upto_stellar.md` for the full protocol spec.
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, token,
    vec, Address, Env, IntoVal, Val,
};

/// Hard ceiling on the *effective* facilitator fee, expressed as a
/// percentage of `actual_amount`, independent of any off-chain facilitator
/// configuration and independent of which `fee_mode` computed it. 2000 =
/// 20%. Defense-in-depth: protects integrators even if a client SDK naively
/// signs whatever fee a malicious facilitator quotes in `PaymentRequirements`.
const MAX_FEE_BPS: u32 = 2_000;
const BPS_DENOMINATOR: i128 = 10_000;

/// Selects how `fee_bps`/`fee_fixed` combine into the effective facilitator
/// fee, mirroring `BillingFeeConfig`'s off-chain shape
/// (`packages/facilitator/src/billing.ts`) so the same configurable
/// fixed/percentage/combined business model applies on-chain, not only to
/// the off-chain-billed tiers. `fee_fixed` is denominated in the
/// settlement asset's own atomic units (not USD) specifically so this
/// contract never needs a price oracle to compute it.
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum FeeMode {
    /// `fee = actual_amount * fee_bps / 10_000`. `fee_fixed` is ignored.
    Percentage = 0,
    /// `fee = fee_fixed`, a flat amount in the settlement asset's atomic
    /// units. `fee_bps` is ignored.
    Fixed = 1,
    /// `fee = min(fee_fixed, actual_amount * fee_bps / 10_000)`.
    CombinedMin = 2,
    /// `fee = max(fee_fixed, actual_amount * fee_bps / 10_000)`.
    CombinedMax = 3,
}

/// Approximate ledgers per day at a 5s close time, used for nonce-record TTL bumps.
const DAY_IN_LEDGERS: u32 = 17_280;
const NONCE_TTL_THRESHOLD: u32 = DAY_IN_LEDGERS * 7;
const NONCE_TTL_EXTEND_TO: u32 = DAY_IN_LEDGERS * 30;

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// (from, request_nonce) -> settled flag. Replay protection: each client-signed
    /// witness may be settled at most once, per the x402 `upto` core properties.
    Nonce(Address, u64),
}

/// Emitted on every settlement, including zero-amount ones (which still consume
/// the nonce). `seller_amount + facilitator_fee == actual_amount` always holds.
#[contractevent(topics = ["upto_settle"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UptoSettleEvent {
    #[topic]
    pub from: Address,
    #[topic]
    pub request_nonce: u64,
    pub pay_to: Address,
    pub facilitator: Address,
    pub seller_amount: i128,
    pub facilitator_fee: i128,
}

/// Emitted when a payer cancels a witness before it's settled.
#[contractevent(topics = ["upto_cancel"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UptoCancelEvent {
    #[topic]
    pub from: Address,
    #[topic]
    pub request_nonce: u64,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    DeadlineExpired = 1,
    NonceAlreadyUsed = 2,
    ActualExceedsMax = 3,
    NegativeAmount = 4,
    FeeExceedsCeiling = 5,
    FacilitatorIsPayer = 6,
    FacilitatorIsPayTo = 7,
    InvalidFeeMode = 8,
}

#[contract]
pub struct UptoSettlement;

#[contractimpl]
impl UptoSettlement {
    /// Settles an x402 `upto` payment.
    ///
    /// `actual_amount` is supplied by the facilitator at settlement time based on
    /// resource consumption and is NOT part of the client's signed witness — only
    /// the `0 <= actual_amount <= max_amount` bound (enforced below) constrains it.
    /// Requires the client to have previously called the token's standard SEP-41
    /// `approve(from, <this contract>, budget, live_until_ledger)` with
    /// `budget >= max_amount`; the facilitator's `/verify` step should check this
    /// allowance before returning `isValid: true` (see `stellar-upto` package).
    ///
    /// Returns `(seller_amount, facilitator_fee)`.
    #[allow(clippy::too_many_arguments)] // mirrors the client's signed witness
    // tuple (from, pay_to, facilitator, token, max_amount, request_nonce,
    // deadline, fee_bps, fee_fixed, fee_mode) plus `env` and `actual_amount` —
    // splitting the signed fields into a struct would need its own
    // `IntoVal`/argument-order guarantee, adding indirection to the exact
    // place a mismatch would be hardest to catch, for no reduction in what
    // the function actually receives.
    pub fn settle(
        env: Env,
        from: Address,
        pay_to: Address,
        facilitator: Address,
        token: Address,
        max_amount: i128,
        actual_amount: i128,
        request_nonce: u64,
        deadline: u64,
        fee_bps: u32,
        fee_fixed: i128,
        fee_mode: u32,
    ) -> (i128, i128) {
        let fee_mode = match fee_mode {
            0 => FeeMode::Percentage,
            1 => FeeMode::Fixed,
            2 => FeeMode::CombinedMin,
            3 => FeeMode::CombinedMax,
            _ => panic_with_error!(&env, Error::InvalidFeeMode),
        };

        // --- Facilitator safety: cannot be the payer or the payee it is supposedly
        // routing funds to; mirrors the equivalent checks in the `exact` scheme. ---
        if facilitator == from {
            panic_with_error!(&env, Error::FacilitatorIsPayer);
        }
        if facilitator == pay_to {
            panic_with_error!(&env, Error::FacilitatorIsPayTo);
        }

        // --- Bounds checks ---
        if env.ledger().timestamp() > deadline {
            panic_with_error!(&env, Error::DeadlineExpired);
        }
        if actual_amount < 0 || max_amount < 0 || fee_fixed < 0 {
            panic_with_error!(&env, Error::NegativeAmount);
        }
        if actual_amount > max_amount {
            panic_with_error!(&env, Error::ActualExceedsMax);
        }

        // --- Effective fee, computed from fee_mode/fee_bps/fee_fixed
        // (mirrors BillingFeeConfig's fixed/percentage/combined shape,
        // packages/facilitator/src/billing.ts), then bounded by MAX_FEE_BPS
        // as a percentage of actual_amount regardless of which mode
        // produced it — this is what keeps the on-chain ceiling meaningful
        // even in Fixed/CombinedMax mode, where an arbitrarily large
        // fee_fixed would otherwise bypass a bps-only check. When
        // actual_amount is 0 the ceiling is 0 too, so a nonzero fixed fee
        // is correctly rejected rather than silently charged against
        // nothing. ---
        let percentage_component = (actual_amount * fee_bps as i128) / BPS_DENOMINATOR;
        let fee = match fee_mode {
            FeeMode::Percentage => percentage_component,
            FeeMode::Fixed => fee_fixed,
            FeeMode::CombinedMin => {
                if fee_fixed < percentage_component { fee_fixed } else { percentage_component }
            }
            FeeMode::CombinedMax => {
                if fee_fixed > percentage_component { fee_fixed } else { percentage_component }
            }
        };
        let fee_ceiling = (actual_amount * MAX_FEE_BPS as i128) / BPS_DENOMINATOR;
        if fee > fee_ceiling {
            panic_with_error!(&env, Error::FeeExceedsCeiling);
        }

        // --- Replay protection (single-use authorization) ---
        let key = DataKey::Nonce(from.clone(), request_nonce);
        if env.storage().persistent().has(&key) {
            panic_with_error!(&env, Error::NonceAlreadyUsed);
        }

        // --- Witness authorization: commits to everything the client agreed to
        // except `actual_amount`, which is bounded (not fixed) by `max_amount`. ---
        let witness_args: soroban_sdk::Vec<Val> = vec![
            &env,
            from.clone().into_val(&env),
            pay_to.clone().into_val(&env),
            facilitator.clone().into_val(&env),
            token.clone().into_val(&env),
            max_amount.into_val(&env),
            request_nonce.into_val(&env),
            deadline.into_val(&env),
            fee_bps.into_val(&env),
            fee_fixed.into_val(&env),
            (fee_mode as u32).into_val(&env),
        ];
        from.require_auth_for_args(witness_args);

        // --- Facilitator authorization: binds *who submits this settlement* to
        // the address the client's witness names as `facilitator`. Without this,
        // the witness is a bearer credential — anyone who has seen it (e.g. the
        // resource server, which receives it before the facilitator does, per
        // the protocol flow) could submit `settle` themselves, either forcing an
        // immediate max-amount charge or griefing the legitimate facilitator by
        // burning the nonce with a zero-amount settlement before real metering
        // happens. The facilitator is expected to be the transaction's source
        // account when it submits settle(), so this is satisfied automatically
        // by its ordinary transaction signature (Soroban's source-account
        // credentials) — no separate signed authorization is required from it.
        facilitator.require_auth();

        // --- Effects before external interactions (checks-effects-interactions) ---
        env.storage().persistent().set(&key, &true);
        env.storage()
            .persistent()
            .extend_ttl(&key, NONCE_TTL_THRESHOLD, NONCE_TTL_EXTEND_TO);

        // --- Zero-settlement short-circuit: unused authorizations cost nothing
        // beyond the nonce write above (no token transfer needed). ---
        if actual_amount == 0 {
            UptoSettleEvent {
                from,
                request_nonce,
                pay_to,
                facilitator,
                seller_amount: 0,
                facilitator_fee: 0,
            }
            .publish(&env);
            return (0, 0);
        }

        // --- Fee split + transfer via allowance. `fee` was already computed
        // and bounded above. Spender = this contract, which self-authorizes
        // `transfer_from` (no external signature required here). ---
        let seller_amount = actual_amount - fee;

        let token_client = token::TokenClient::new(&env, &token);
        let this_contract = env.current_contract_address();

        if seller_amount > 0 {
            token_client.transfer_from(&this_contract, &from, &pay_to, &seller_amount);
        }
        if fee > 0 {
            token_client.transfer_from(&this_contract, &from, &facilitator, &fee);
        }

        UptoSettleEvent {
            from,
            request_nonce,
            pay_to,
            facilitator,
            seller_amount,
            facilitator_fee: fee,
        }
        .publish(&env);

        (seller_amount, fee)
    }

    /// Lets a payer unilaterally invalidate one specific, not-yet-settled
    /// witness, without affecting any other outstanding witness or their
    /// SEP-41 allowance to this contract.
    ///
    /// This scheme doesn't escrow client funds the way e.g. Solana's `upto`
    /// (a payment-channel design) does, so a client already has a coarse
    /// escape hatch available at any time: revoking the SEP-41 allowance
    /// itself (a standard `approve(spender, 0, ...)` call) blocks every
    /// future settlement under it immediately, no grace period needed. What
    /// that can't do is invalidate a *single* stale or disputed request
    /// while leaving a shared allowance's other, still-wanted requests
    /// alone. `cancel` closes that gap: it consumes exactly one
    /// `request_nonce`, the same way a zero-amount settlement would, so any
    /// later `settle` attempt using it fails with `NonceAlreadyUsed`.
    ///
    /// Requires only the payer's own signature — the facilitator is not
    /// involved and cannot prevent or be harmed by a cancellation, since it
    /// was never entitled to funds under an authorization that was never
    /// settled in the first place.
    pub fn cancel(env: Env, from: Address, request_nonce: u64) {
        from.require_auth();

        let key = DataKey::Nonce(from.clone(), request_nonce);
        if env.storage().persistent().has(&key) {
            panic_with_error!(&env, Error::NonceAlreadyUsed);
        }
        env.storage().persistent().set(&key, &true);
        env.storage()
            .persistent()
            .extend_ttl(&key, NONCE_TTL_THRESHOLD, NONCE_TTL_EXTEND_TO);

        UptoCancelEvent { from, request_nonce }.publish(&env);
    }

    /// Returns whether a given (from, request_nonce) authorization has already been
    /// settled. Facilitators should check this before submitting a settlement to
    /// avoid a wasted on-chain rejection.
    pub fn is_settled(env: Env, from: Address, request_nonce: u64) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Nonce(from, request_nonce))
    }

    /// The hard fee ceiling this contract enforces, in basis points.
    pub fn max_fee_bps(_env: Env) -> u32 {
        MAX_FEE_BPS
    }
}

#[cfg(test)]
mod test;
