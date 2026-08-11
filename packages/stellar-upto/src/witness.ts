import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import type { UptoWitnessCommitment } from "./types.js";

/**
 * The name of the contract function whose invocation the witness authorizes.
 * Must exactly match the Rust `pub fn settle(...)` in `contracts/upto-settlement`:
 * Soroban's `Address::require_auth_for_args` matches against an authorized
 * invocation of (current contract address, *currently executing function name*,
 * args) — since `settle` is the only function that calls
 * `require_auth_for_args`, this is the function name the client signs for.
 */
export const SETTLE_FUNCTION_NAME = "settle";

/**
 * Builds the exact ScVal args tuple that both the client signs (as part of the
 * `settle` invocation simulated via `contract.AssembledTransaction`) and the
 * facilitator independently recomputes to double-check the client-signed entry
 * wasn't tampered with before attaching it to the real settlement invocation.
 *
 * This is the single source of truth for the witness encoding — it MUST equal,
 * in this exact order, the args tuple bound in `from.require_auth_for_args(...)`
 * inside `contracts/upto-settlement/src/lib.rs`:
 *
 *   (from, pay_to, facilitator, token, max_amount, request_nonce, deadline, fee_bps)
 *
 * `actual_amount` is deliberately excluded — see `UptoWitnessCommitment` docs.
 *
 * @param commitment - The witness commitment fields
 * @returns The ScVal args array, in contract-matching order
 */
export function buildWitnessScArgs(commitment: UptoWitnessCommitment): xdr.ScVal[] {
  return [
    nativeToScVal(commitment.from, { type: "address" }),
    nativeToScVal(commitment.payTo, { type: "address" }),
    nativeToScVal(commitment.facilitator, { type: "address" }),
    nativeToScVal(commitment.token, { type: "address" }),
    nativeToScVal(commitment.maxAmount, { type: "i128" }),
    nativeToScVal(commitment.requestNonce, { type: "u64" }),
    nativeToScVal(commitment.deadline, { type: "u64" }),
    nativeToScVal(commitment.feeBps, { type: "u32" }),
  ];
}

/**
 * Builds the full 9-argument ScVal list for a real `settle(...)` invocation
 * (client simulation at request time using `actualAmount = maxAmount` as the
 * worst-case placeholder, or the facilitator's real settlement call using the
 * metered `actualAmount`).
 *
 * @param commitment - The witness commitment fields
 * @param actualAmount - The amount to settle for (≤ `commitment.maxAmount`)
 * @returns The ScVal args array for the `settle` contract call
 */
export function buildSettleScArgs(
  commitment: UptoWitnessCommitment,
  actualAmount: bigint,
): xdr.ScVal[] {
  const [from, payTo, facilitator, token, maxAmount, requestNonce, deadline, feeBps] =
    buildWitnessScArgs(commitment);
  return [
    from,
    payTo,
    facilitator,
    token,
    maxAmount,
    nativeToScVal(actualAmount, { type: "i128" }),
    requestNonce,
    deadline,
    feeBps,
  ];
}
