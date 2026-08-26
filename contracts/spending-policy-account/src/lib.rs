//! x402SpendingPolicyAccount — a reference Soroban custom `__check_auth`
//! account enforcing a real, on-chain per-period spending ceiling on a
//! single SEP-41 asset.
//!
//! Why this exists: `contracts/custom-account-demo` proved that a custom
//! `__check_auth` account composes with this project's `exact`/`upto`
//! schemes unmodified — but that contract deliberately does nothing beyond
//! an owner-key check; its own module docs say so explicitly, and its
//! `__check_auth` never even reads the `auth_contexts` parameter that would
//! be needed to inspect *what* is being authorized. The RFP asks
//! respondents to "describe how it composes with Stellar smart account
//! spending policies to keep an agent inside a budget" (Section 3.4) — a
//! description requirement, not a mandate for a specific mechanism or a
//! claim of prior testing. This project's own submission went further than
//! the RFP required and stated that a real spending policy had already been
//! tested on testnet; it hadn't. This contract closes that gap for real,
//! rather than walking the submission's claim back.
//!
//! ## Design: fixed-period ceiling, not a literal sliding window
//!
//! The submission described this as a "rolling budget ceiling." A literal
//! sliding window (checking "spend in the trailing N seconds from right
//! now") requires storing a timestamped history of every spend and summing
//! whatever falls inside the window on each check — unbounded storage
//! growth for a contract whose entire job is to be a small, auditable
//! security boundary. That tradeoff isn't worth it for a reference
//! implementation, so this contract instead uses a fixed-period counter:
//! `period_id = timestamp / period_seconds`, reset to zero whenever a call
//! lands in a new period. This is the same bounded, well-understood pattern
//! this project's off-chain `SellerBillingPlan` already uses for its
//! renewable free-settlement quotas (`packages/facilitator/src/billing.ts`)
//! and the one proposed for managed `upto`'s own future on-chain quotas
//! (`docs/architecture.md`, "The three-tier billing model") — one
//! consistent renewable-allowance shape across the project, not a third,
//! different mechanism invented just for this contract. Stated here
//! explicitly rather than silently relabeling a fixed-period reset as
//! "rolling."
//!
//! ## What this account actually governs
//!
//! `__check_auth` inspects `auth_contexts` for `Context::Contract` entries
//! whose `contract` is the configured `token` and whose `fn_name` is
//! `"transfer"` — the SEP-41 function every settlement path this project
//! ships actually invokes against this account (a direct transfer for
//! `exact`, or the escrow pull for `upto`/`managed upto`). It sums the
//! `amount` argument (SEP-41 `transfer(from, to, amount)`, position 2)
//! across every such entry found in the authorized invocation tree, and
//! rejects if that sum, added to what's already been spent this period,
//! would exceed the configured ceiling. An authorization tree that carries
//! *no* recognizable transfer against the configured token is rejected
//! outright, fail-closed — this account exists solely to gate spend on one
//! asset, so an authorization shaped some other way is out of scope by
//! construction, not silently waved through because the signature checked
//! out.
//!
//! **A disclosed, narrower-than-ideal property for `upto`/`managed
//! `upto``:** the escrow-and-refund design's signed witness authorizes a
//! transfer of `max_amount` (the ceiling the buyer agreed to), not the
//! eventual metered `actual_amount` — see
//! `contracts/upto-settlement-escrow`. This account can therefore only
//! bound what a buyer *authorizes* per `upto` request, not what a
//! facilitator eventually *settles* for; the buyer's on-chain budget is
//! consumed against the authorized ceiling at signing time, the same
//! moment the facilitator's own `MAX_FEE_BPS` ceiling and the buyer's own
//! balance are already bounding things independently. This is not a gap
//! introduced by this contract — it's inherent to what a `__check_auth`
//! hook can see (the authorized invocation, not a future settlement
//! amount) — but it's worth stating precisely rather than implying this
//! account bounds actual metered spend for `upto`.
//!
//! **Storage-write safety.** `__check_auth`'s budget-ledger update
//! (`PERIOD_ID`/`SPENT`) is not a separate transaction from the transfer it
//! is gating — it is part of the same authorization check the Soroban host
//! performs while applying the one transaction that also performs the
//! transfer. If that transaction fails for any reason after `__check_auth`
//! succeeds (e.g. insufficient balance on the actual `transfer`), the
//! entire transaction — including this contract's storage writes — rolls
//! back atomically. There is no window where a spend gets recorded without
//! the corresponding transfer actually happening.
#![no_std]
use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contracterror, contractimpl, crypto::Hash, symbol_short, Address, Bytes, BytesN,
    Env, Symbol, TryFromVal, Vec,
};

const OWNER: Symbol = symbol_short!("OWNER");
const TOKEN: Symbol = symbol_short!("TOKEN");
const CEILING: Symbol = symbol_short!("CEILING");
const PERIOD_S: Symbol = symbol_short!("PERIOD_S");
const PERIOD_ID: Symbol = symbol_short!("PERIOD_ID");
const SPENT: Symbol = symbol_short!("SPENT");
const TRANSFER_FN: Symbol = symbol_short!("transfer");

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    InvalidCeiling = 3,
    InvalidPeriodSeconds = 4,
    NoRecognizedTransfer = 5,
    BudgetExceeded = 6,
}

#[contract]
pub struct SpendingPolicyAccount;

#[contractimpl]
impl SpendingPolicyAccount {
    /// One-time setup: pins the owner key, the single SEP-41 asset this
    /// policy governs, the per-period ceiling (atomic units of `token`),
    /// and the fixed period length in seconds. No admin, no rotation of any
    /// of these — a real deployment that wants adjustable parameters is
    /// free to add that; this reference intentionally keeps the governed
    /// parameters immutable after `init` so the policy itself can't be
    /// weakened by anyone who can call this contract, only by redeploying.
    pub fn init(
        env: Env,
        owner: BytesN<32>,
        token: Address,
        ceiling: i128,
        period_seconds: u64,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&OWNER) {
            return Err(Error::AlreadyInitialized);
        }
        if ceiling <= 0 {
            return Err(Error::InvalidCeiling);
        }
        if period_seconds == 0 {
            return Err(Error::InvalidPeriodSeconds);
        }
        env.storage().instance().set(&OWNER, &owner);
        env.storage().instance().set(&TOKEN, &token);
        env.storage().instance().set(&CEILING, &ceiling);
        env.storage().instance().set(&PERIOD_S, &period_seconds);
        env.storage().instance().set(&PERIOD_ID, &0u64);
        env.storage().instance().set(&SPENT, &0i128);
        Ok(())
    }

    /// Read-only helper for callers/UIs that want to show remaining budget
    /// without attempting a transfer — computes the *current* period's
    /// remaining allowance without mutating storage, so calling this never
    /// itself resets or consumes anything.
    pub fn remaining_budget(env: Env) -> Result<i128, Error> {
        let ceiling: i128 = env
            .storage()
            .instance()
            .get(&CEILING)
            .ok_or(Error::NotInitialized)?;
        let period_seconds: u64 = env.storage().instance().get(&PERIOD_S).unwrap();
        let stored_period_id: u64 = env.storage().instance().get(&PERIOD_ID).unwrap();
        let spent: i128 = env.storage().instance().get(&SPENT).unwrap();

        let current_period_id = env.ledger().timestamp() / period_seconds;
        let spent_this_period = if current_period_id == stored_period_id {
            spent
        } else {
            0
        };
        Ok(ceiling - spent_this_period)
    }
}

#[contractimpl]
impl CustomAccountInterface for SpendingPolicyAccount {
    type Signature = BytesN<64>;
    type Error = Error;

    /// Called by the Soroban host whenever this account's authorization is
    /// needed. Two independent things must both hold: the signature must
    /// verify against the owner key, and the requested transfer(s) against
    /// the configured `token`, summed, must fit within what's left of this
    /// period's ceiling.
    fn __check_auth(
        env: Env,
        signature_payload: Hash<32>,
        signature: BytesN<64>,
        auth_contexts: Vec<Context>,
    ) -> Result<(), Error> {
        let owner: BytesN<32> = env
            .storage()
            .instance()
            .get(&OWNER)
            .ok_or(Error::NotInitialized)?;
        let payload: Bytes = signature_payload.into();
        env.crypto().ed25519_verify(&owner, &payload, &signature);

        let token: Address = env.storage().instance().get(&TOKEN).unwrap();
        let ceiling: i128 = env.storage().instance().get(&CEILING).unwrap();
        let period_seconds: u64 = env.storage().instance().get(&PERIOD_S).unwrap();
        let stored_period_id: u64 = env.storage().instance().get(&PERIOD_ID).unwrap();
        let spent: i128 = env.storage().instance().get(&SPENT).unwrap();

        let mut requested: i128 = 0;
        let mut found_transfer = false;
        for context in auth_contexts.iter() {
            if let Context::Contract(ctx) = context {
                if ctx.contract == token && ctx.fn_name == TRANSFER_FN {
                    // SEP-41 transfer(from: Address, to: Address, amount: i128) —
                    // validated defensively, not blindly indexed/cast: a
                    // misconfigured governed token exposing a same-named
                    // function with a different arg shape must be rejected
                    // cleanly, not trap the host mid-authorization.
                    if ctx.args.len() != 3 {
                        return Err(Error::NoRecognizedTransfer);
                    }
                    let amount_val = ctx.args.get_unchecked(2);
                    let amount: i128 = i128::try_from_val(&env, &amount_val)
                        .map_err(|_| Error::NoRecognizedTransfer)?;
                    requested = requested
                        .checked_add(amount)
                        .ok_or(Error::BudgetExceeded)?;
                    found_transfer = true;
                }
            }
        }
        if !found_transfer {
            return Err(Error::NoRecognizedTransfer);
        }

        let current_period_id = env.ledger().timestamp() / period_seconds;
        let spent_this_period = if current_period_id == stored_period_id {
            spent
        } else {
            0
        };

        let new_spent = spent_this_period
            .checked_add(requested)
            .ok_or(Error::BudgetExceeded)?;
        if new_spent > ceiling {
            return Err(Error::BudgetExceeded);
        }

        env.storage().instance().set(&PERIOD_ID, &current_period_id);
        env.storage().instance().set(&SPENT, &new_spent);
        Ok(())
    }
}

#[cfg(test)]
mod test;
