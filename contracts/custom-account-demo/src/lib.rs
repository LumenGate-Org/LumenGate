//! x402CustomAccountDemo — a minimal Ed25519 custom Soroban account.
//!
//! Why this exists: the RFP requires "Support classic keypairs and custom
//! `__check_auth` accounts" as a literal, explicit requirement — not just a
//! nice-to-have. Before this contract, this project's own docs
//! (`docs/architecture.md`, "Composition with Stellar smart account spending
//! policies") only argued composability *by construction*: `require_auth`/
//! `require_auth_for_args` are the same primitive a custom-account contract's
//! `__check_auth` intercepts, so nothing in `exact` or `upto` should care
//! whether the payer is a plain keypair or a smart-account contract. That is
//! a sound argument, but this project's own standing rule throughout is
//! "verify, don't just assert" — so this contract exists to make the payer
//! side of a real settlement an actual `__check_auth` contract address, not
//! a `G...` keypair, and prove the existing facilitator code needs zero
//! changes to accept it.
//!
//! This is deliberately the simplest possible custom account — a single
//! Ed25519 owner key, no spending policy, no multisig, no delegation. The
//! point being proven is narrow and specific: "a contract address can stand
//! in for the payer and the existing `verify`/`settle` path Just Works,"
//! not "here is a production smart-account wallet." A real spending-policy
//! account (the RFP's other explicit mention, "how it composes with Stellar
//! smart account spending policies to keep an agent inside a budget") is a
//! separate, larger piece of work this contract deliberately does not
//! attempt — see docs/architecture.md for where that's scoped.
#![no_std]
use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contracterror, contractimpl, crypto::Hash, symbol_short, Bytes, BytesN, Env,
    Symbol, Vec,
};

const OWNER: Symbol = symbol_short!("OWNER");

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
}

#[contract]
pub struct CustomAccountDemo;

#[contractimpl]
impl CustomAccountDemo {
    /// One-time setup: pins the Ed25519 public key this account authenticates
    /// against. No admin, no rotation — deliberately minimal, since the only
    /// thing this contract needs to prove is that the *shape* of a
    /// `__check_auth` account composes with this project's schemes, not that
    /// this specific account is production-grade key-management.
    pub fn init(env: Env, owner: BytesN<32>) -> Result<(), Error> {
        if env.storage().instance().has(&OWNER) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&OWNER, &owner);
        Ok(())
    }
}

#[contractimpl]
impl CustomAccountInterface for CustomAccountDemo {
    type Signature = BytesN<64>;
    type Error = Error;

    /// Called by the Soroban host, not directly by any caller, whenever a
    /// transaction's authorization tree needs this account's approval —
    /// exactly the same hook point `require_auth()`/`require_auth_for_args()`
    /// trigger for a plain keypair, which is the whole reason `exact` and
    /// `upto` compose with this without modification: neither scheme calls
    /// `require_auth` differently depending on what kind of address `from`
    /// turns out to be.
    fn __check_auth(
        env: Env,
        signature_payload: Hash<32>,
        signature: BytesN<64>,
        _auth_contexts: Vec<Context>,
    ) -> Result<(), Error> {
        let owner: BytesN<32> = env
            .storage()
            .instance()
            .get(&OWNER)
            .ok_or(Error::NotInitialized)?;
        let payload: Bytes = signature_payload.into();
        env.crypto().ed25519_verify(&owner, &payload, &signature);
        Ok(())
    }
}

#[cfg(test)]
mod test;
