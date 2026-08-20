//! x402UptoStellarEscrowSettlement (Design B)
//!
//! Alternative `upto` settlement design for Stellar/Soroban, inspired by
//! Stellar's official Atomic Swap example contract and proposed via
//! external validation as a comparison against `x402-upto-settlement`
//! (Design A)'s SEP-41 allowance + `transfer_from` approach.
//!
//! Where Design A never moves funds into escrow (funds move directly
//! buyer -> seller/facilitator at settlement time, against a pre-approved
//! allowance), Design B briefly escrows the buyer's full `max_amount`
//! inside this contract for the duration of one atomic `settle()` call,
//! then splits `actual_amount` between `pay_to`/`facilitator` and refunds
//! the remainder to the buyer — all within the same transaction, no
//! `approve` prerequisite.
//!
//! ## Why this differs from the naive escrow-refund sketch
//!
//! A naive version of this design has the buyer sign a plain
//! `require_auth()` for `token.transfer(buyer, this_contract, max_amount)`
//! — a fully concrete call. That signed authorization is a bearer
//! credential with independent utility: anyone holding it (the resource
//! server, by protocol design, receives it before the facilitator ever
//! does) could invoke `token.transfer` directly, as a standalone top-level
//! call rather than nested under `settle()`, landing `max_amount` inside
//! this contract with none of the refund/split logic below ever running.
//! See "Design alternative considered" in `docs/architecture.md` for the
//! full analysis — external validation proposed the naive version; this crate
//! is the corrected one.
//!
//! This contract closes that gap by having the buyer authorize
//! `require_auth_for_args` against `settle`'s own synthetic args (mirroring
//! Design A's witness, `actual_amount` excluded), and structuring the
//! escrow-pulling token transfer as a genuine Soroban *sub-invocation*,
//! reachable only from within this contract's own `settle` execution.
//! Soroban's authorization tree matching (CAP-0046-11) means the signed
//! entry only authorizes `token.transfer(buyer, this_contract, max_amount)`
//! when that call actually occurs nested under this specific `settle`
//! invocation — not as a standalone call. Verified live, including a
//! deliberate attempt to invoke the transfer standalone: see "Design B live
//! proof" in `e2e/conformance/CONFORMANCE_REPORT.md`.
//!
//! ## What this achieves vs. Design A, and what it costs
//!
//! No SEP-41 allowance, no `approve` prerequisite, no allowance-exhaustion
//! failure mode across concurrent in-flight requests. Genuinely less
//! persistent state: this contract owns **zero** contract-level storage —
//! replay protection relies entirely on the Soroban host's own
//! per-authorization-entry nonce (CAP-0046-11), not a contract-owned
//! `DataKey` the way Design A's `Nonce(from, request_nonce)` is.
//!
//! The cost of that: no `cancel` entry point. Design A's `cancel` writes to
//! the same nonce storage `settle` does, letting a buyer invalidate one
//! specific not-yet-settled witness on demand. Since this contract keeps no
//! storage at all, there is nothing for a `cancel` call to write to or
//! check against — a buyer's only escape hatch for an authorization they no
//! longer want honored is letting `deadline`/`signatureExpirationLedger`
//! expire naturally. That is the same limitation the EVM `upto` spec
//! already documents ("authorization simply expires, no channel to
//! close") — not a new gap introduced here, but a real, honest tradeoff
//! against Design A's `cancel`, not something to gloss over. `request_nonce`
//! is still part of the signed args, for interface parity with Design A and
//! for off-chain correlation/idempotency by the facilitator — but unlike
//! Design A, it does no enforcement work on-chain here; the host's own
//! authorization-entry nonce is what actually prevents replay. Consequently
//! this contract also cannot answer "has this witness already been
//! settled?" as an on-chain view call the way Design A's `is_settled` can
//! — that information isn't in this contract's state at all.
//!
//! See `specs/schemes/upto/scheme_upto_stellar.md` and
//! `docs/architecture.md` ("Design alternative considered") for the full
//! writeup, and `contracts/upto-settlement-escrow/README.md` for build,
//! test, and live-proof details.
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, panic_with_error, token, vec, Address,
    Env, IntoVal, Val,
};

/// Hard ceiling on the *effective* facilitator fee, expressed as a
/// percentage of `actual_amount`, independent of any off-chain facilitator
/// configuration and independent of which `fee_mode` computed it. 2000 =
/// 20%. Mirrors Design A's `MAX_FEE_BPS` exactly, for a fair comparison —
/// this isn't a place the two designs should differ.
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

/// Emitted on every non-zero-`max_amount` settlement. Unlike Design A's
/// event, there is no `DataKey` this maps to — this event, plus the
/// transaction itself, is the only durable record of the settlement this
/// contract produces.
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
    pub refund: i128,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    DeadlineExpired = 1,
    ActualExceedsMax = 3,
    NegativeAmount = 4,
    FeeExceedsCeiling = 5,
    FacilitatorIsPayer = 6,
    FacilitatorIsPayTo = 7,
    InvalidFeeMode = 8,
}

#[contract]
pub struct UptoEscrowSettlement;

#[contractimpl]
impl UptoEscrowSettlement {
    /// Settles an x402 `upto` payment via escrow-and-refund.
    ///
    /// `actual_amount` is supplied by the facilitator at settlement time
    /// based on resource consumption and is NOT part of the client's signed
    /// witness — only the `0 <= actual_amount <= max_amount` bound
    /// (enforced below) constrains it, exactly as in Design A. Unlike
    /// Design A, the buyer does **not** need to have called `approve`
    /// beforehand — this function itself pulls `max_amount` from the buyer
    /// via a plain `transfer`, authorized as a sub-invocation of the same
    /// signed entry that authorizes this call (see module docs for why
    /// that's safe against the naive design's bearer-credential gap).
    ///
    /// Returns `(seller_amount, facilitator_fee, refund)`.
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
    ) -> (i128, i128, i128) {
        let fee_mode = match fee_mode {
            0 => FeeMode::Percentage,
            1 => FeeMode::Fixed,
            2 => FeeMode::CombinedMin,
            3 => FeeMode::CombinedMax,
            _ => panic_with_error!(&env, Error::InvalidFeeMode),
        };
        // --- Facilitator safety: cannot be the payer or the payee it is
        // supposedly routing funds to; mirrors Design A's equivalent checks. ---
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
        // fee_fixed would otherwise bypass a bps-only check. ---
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

        // --- Witness authorization: commits to everything the client agreed
        // to except `actual_amount`. This call establishes the authorized
        // context that the escrow transfer below is nested under — the
        // reason the escrow pull is safe as a sub-invocation rather than a
        // standalone bearer-credential call. Replay protection is entirely
        // the Soroban host's own per-entry nonce (CAP-0046-11): this
        // contract has no storage of its own to check or write. ---
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

        // --- Facilitator authorization: binds *who submits this
        // settlement* to the address the client's witness names as
        // `facilitator` — identical rationale and mechanism to Design A's
        // equivalent check (satisfied automatically by the facilitator's
        // own transaction/operation source-account signature; see
        // docs/architecture.md, "Sequence-number bottlenecks" for how this
        // composes with channel accounts). ---
        facilitator.require_auth();

        let token_client = token::TokenClient::new(&env, &token);
        let this_contract = env.current_contract_address();

        // --- Escrow: pull max_amount from the buyer into this contract.
        // Invoked here, nested under the `from.require_auth_for_args`
        // authorization just established above, this call is authorized as
        // a SUB-INVOCATION of that signed entry — not usable as a
        // standalone call outside this exact settle() execution. See
        // module docs and "Design B live proof" in
        // e2e/conformance/CONFORMANCE_REPORT.md. ---
        if max_amount > 0 {
            token_client.transfer(&from, &this_contract, &max_amount);
        }

        // --- Fee split + refund, all still within this same atomic call.
        // `fee` was already computed and bounded above. Paying out of
        // `this_contract` self-authorizes (a contract's own `require_auth()`
        // succeeds automatically when it is the currently executing
        // contract) — no additional signature needed, identical to how
        // Design A's `transfer_from(spender = this_contract, ...)`
        // self-authorizes. ---
        let seller_amount = actual_amount - fee;
        let refund = max_amount - actual_amount;

        if seller_amount > 0 {
            token_client.transfer(&this_contract, &pay_to, &seller_amount);
        }
        if fee > 0 {
            token_client.transfer(&this_contract, &facilitator, &fee);
        }
        if refund > 0 {
            token_client.transfer(&this_contract, &from, &refund);
        }

        UptoSettleEvent {
            from,
            request_nonce,
            pay_to,
            facilitator,
            seller_amount,
            facilitator_fee: fee,
            refund,
        }
        .publish(&env);

        (seller_amount, fee, refund)
    }

    /// The hard fee ceiling this contract enforces, in basis points.
    /// Identical to Design A's, for a fair comparison.
    pub fn max_fee_bps(_env: Env) -> u32 {
        MAX_FEE_BPS
    }
}

#[cfg(test)]
mod test;
