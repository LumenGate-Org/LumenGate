import { scValToNative, xdr } from "@stellar/stellar-sdk";
import { SETTLE_FUNCTION_NAME } from "../witness.js";
import type { UptoWitnessCommitment } from "../types.js";

export type DecodedWitnessError =
  | "invalid_upto_stellar_payload_malformed"
  | "invalid_upto_stellar_witness_wrong_contract"
  | "invalid_upto_stellar_witness_wrong_function"
  | "invalid_upto_stellar_witness_wrong_arity"
  | "invalid_upto_stellar_witness_wrong_arg_type"
  | "invalid_upto_stellar_witness_from_signer_mismatch"
  | "invalid_upto_stellar_witness_has_subinvocations"
  | "invalid_upto_stellar_witness_missing_escrow_subinvocation"
  | "invalid_upto_stellar_witness_wrong_escrow_subinvocation"
  | "invalid_upto_stellar_unsupported_credential_type"
  | "invalid_upto_stellar_missing_payer_signature";

/**
 * Expected ScVal type (by `switch().name`) for each of the 8 witness args, in
 * order — see `buildWitnessScArgs` in `../witness.ts` for the encoding this
 * mirrors. Validated explicitly before `scValToNative` rather than trusting a
 * TypeScript cast: a malicious client controls the raw XDR and could encode
 * any of these positions as an unexpected ScVal variant, silently producing a
 * wrong-typed JS value (e.g. a non-address `from`) that downstream checks
 * were never designed to handle.
 */
const WITNESS_ARG_TYPES = [
  "scvAddress", // from
  "scvAddress", // payTo
  "scvAddress", // facilitator
  "scvAddress", // token
  "scvI128", // maxAmount
  "scvU64", // requestNonce
  "scvU64", // deadline
  "scvU32", // feeBps
] as const;

export type DecodedWitness = {
  entry: xdr.SorobanAuthorizationEntry;
  commitment: UptoWitnessCommitment;
};

type DecodedCore = {
  entry: xdr.SorobanAuthorizationEntry;
  rootInvocation: xdr.SorobanAuthorizedInvocation;
  commitment: UptoWitnessCommitment;
};

/**
 * Shared decode/validate logic for both designs: parses the XDR, checks the
 * credential type and signature presence, validates the root invocation
 * targets `settle` on `expectedSettlementContract` with the correct 8-arg
 * witness shape, and cross-checks the signing address against `from`.
 * Deliberately does NOT inspect sub-invocations — that policy differs by
 * design (see `decodeWitnessEntry` vs `decodeEscrowWitnessEntry` below) and
 * is applied by each caller after this returns.
 */
function decodeCore(
  authEntryXdr: string,
  expectedSettlementContract: string,
): { ok: true; value: DecodedCore } | { ok: false; error: DecodedWitnessError } {
  let entry: xdr.SorobanAuthorizationEntry;
  try {
    entry = xdr.SorobanAuthorizationEntry.fromXDR(authEntryXdr, "base64");
  } catch {
    return { ok: false, error: "invalid_upto_stellar_payload_malformed" };
  }

  const credentials = entry.credentials();
  if (credentials.switch() !== xdr.SorobanCredentialsType.sorobanCredentialsAddress()) {
    return { ok: false, error: "invalid_upto_stellar_unsupported_credential_type" };
  }
  const addressCredentials = credentials.address();
  const signature = addressCredentials.signature();
  if (signature.switch().name === "scvVoid") {
    return { ok: false, error: "invalid_upto_stellar_missing_payer_signature" };
  }

  const rootInvocation = entry.rootInvocation();

  const fn = rootInvocation.function();
  if (fn.switch().name !== "sorobanAuthorizedFunctionTypeContractFn") {
    return { ok: false, error: "invalid_upto_stellar_witness_wrong_function" };
  }
  const invokeArgs = fn.contractFn();
  const contractAddressStr = scValToNative(
    xdr.ScVal.scvAddress(invokeArgs.contractAddress()),
  ) as string;
  if (contractAddressStr !== expectedSettlementContract) {
    return { ok: false, error: "invalid_upto_stellar_witness_wrong_contract" };
  }
  if (invokeArgs.functionName().toString() !== SETTLE_FUNCTION_NAME) {
    return { ok: false, error: "invalid_upto_stellar_witness_wrong_function" };
  }

  const args = invokeArgs.args();
  if (args.length !== 8) {
    return { ok: false, error: "invalid_upto_stellar_witness_wrong_arity" };
  }
  for (let i = 0; i < WITNESS_ARG_TYPES.length; i++) {
    if (args[i].switch().name !== WITNESS_ARG_TYPES[i]) {
      return { ok: false, error: "invalid_upto_stellar_witness_wrong_arg_type" };
    }
  }

  try {
    const commitment: UptoWitnessCommitment = {
      from: scValToNative(args[0]) as string,
      payTo: scValToNative(args[1]) as string,
      facilitator: scValToNative(args[2]) as string,
      token: scValToNative(args[3]) as string,
      maxAmount: scValToNative(args[4]) as bigint,
      requestNonce: scValToNative(args[5]) as bigint,
      deadline: scValToNative(args[6]) as bigint,
      feeBps: Number(scValToNative(args[7]) as number | bigint),
    };

    // The address whose *signature* is actually being checked must be the
    // same address the witness names as `from` — otherwise `commitment.from`
    // (used throughout as "the payer") and the party who really signed could
    // diverge. Believed unreachable in practice (the Soroban host only
    // accepts an entry as satisfying `from.require_auth_for_args(...)` when
    // the credentials' address equals `from`), but checked explicitly rather
    // than relying on that host-level guarantee: it turns a wasted RPC
    // simulate call and a generic `invalid_upto_stellar_simulation_failed`
    // into an immediate, specific, cheap rejection.
    const signerAddress = scValToNative(
      xdr.ScVal.scvAddress(addressCredentials.address()),
    ) as string;
    if (signerAddress !== commitment.from) {
      return { ok: false, error: "invalid_upto_stellar_witness_from_signer_mismatch" };
    }

    return { ok: true, value: { entry, rootInvocation, commitment } };
  } catch {
    return { ok: false, error: "invalid_upto_stellar_payload_malformed" };
  }
}

/**
 * Decodes a base64-XDR witness authorization entry and extracts the signed
 * commitment fields, verifying it authorizes exactly one `settle` invocation
 * on `expectedSettlementContract` with no sub-invocations.
 *
 * **Design A only** (`contracts/upto-settlement`, allowance +
 * `transfer_from`): that design's witness must never carry sub-invocations —
 * `transfer_from` self-authorizes as the contract's own principal, so nothing
 * legitimately nests under the client's signed entry. See
 * `decodeEscrowWitnessEntry` below for Design B, whose witness legitimately
 * carries exactly one (the escrow-pulling `token.transfer`).
 *
 * The extracted commitment (in particular `maxAmount`) is the *authoritative*
 * ceiling — never trust a separately-carried JSON `amount` field for this,
 * since only what's inside the signed entry is cryptographically bound to the
 * client's signature. Callers MUST cross-check the extracted commitment
 * against `PaymentRequirements`/the JSON payload, not the other way around.
 *
 * @param authEntryXdr - Base64-encoded XDR of the client-signed auth entry
 * @param expectedSettlementContract - The settlement contract address this facilitator expects
 * @returns The decoded entry and commitment, or an error code
 */
export function decodeWitnessEntry(
  authEntryXdr: string,
  expectedSettlementContract: string,
): { ok: true; value: DecodedWitness } | { ok: false; error: DecodedWitnessError } {
  const core = decodeCore(authEntryXdr, expectedSettlementContract);
  if (!core.ok) return core;

  if (core.value.rootInvocation.subInvocations().length > 0) {
    return { ok: false, error: "invalid_upto_stellar_witness_has_subinvocations" };
  }

  return { ok: true, value: { entry: core.value.entry, commitment: core.value.commitment } };
}

/**
 * Design B (`contracts/upto-settlement-escrow`, escrow-and-refund) variant
 * of `decodeWitnessEntry`. Everything is identical except the
 * sub-invocation policy: this design's witness is REQUIRED to carry exactly
 * one sub-invocation — the escrow-pulling `token.transfer(from,
 * expectedSettlementContract, maxAmount)` — and that sub-invocation is
 * validated structurally (contract address, function name, and all three
 * args) rather than merely counted. This is what makes the escrow pull safe
 * as a *sub-invocation* of this specific `settle` call rather than a
 * standalone bearer credential (see `contracts/upto-settlement-escrow/src
 * /lib.rs` module docs and the live proof in
 * `e2e/conformance/CONFORMANCE_REPORT.md`): a witness with zero
 * sub-invocations, or one that doesn't exactly match the expected escrow
 * pull, is rejected rather than silently accepted as if it were Design A's
 * shape.
 *
 * @param authEntryXdr - Base64-encoded XDR of the client-signed auth entry
 * @param expectedSettlementContract - The deployed escrow contract address this facilitator expects
 * @returns The decoded entry and commitment, or an error code
 */
export function decodeEscrowWitnessEntry(
  authEntryXdr: string,
  expectedSettlementContract: string,
): { ok: true; value: DecodedWitness } | { ok: false; error: DecodedWitnessError } {
  const core = decodeCore(authEntryXdr, expectedSettlementContract);
  if (!core.ok) return core;
  const { entry, rootInvocation, commitment } = core.value;

  const subInvocations = rootInvocation.subInvocations();
  if (subInvocations.length !== 1) {
    return { ok: false, error: "invalid_upto_stellar_witness_missing_escrow_subinvocation" };
  }

  const subFn = subInvocations[0].function();
  if (subFn.switch().name !== "sorobanAuthorizedFunctionTypeContractFn") {
    return { ok: false, error: "invalid_upto_stellar_witness_wrong_escrow_subinvocation" };
  }
  const subInvokeArgs = subFn.contractFn();

  const subContractStr = scValToNative(
    xdr.ScVal.scvAddress(subInvokeArgs.contractAddress()),
  ) as string;
  if (subContractStr !== commitment.token) {
    return { ok: false, error: "invalid_upto_stellar_witness_wrong_escrow_subinvocation" };
  }
  if (subInvokeArgs.functionName().toString() !== "transfer") {
    return { ok: false, error: "invalid_upto_stellar_witness_wrong_escrow_subinvocation" };
  }

  const subArgs = subInvokeArgs.args();
  if (subArgs.length !== 3) {
    return { ok: false, error: "invalid_upto_stellar_witness_wrong_escrow_subinvocation" };
  }
  try {
    const subFrom = scValToNative(subArgs[0]) as string;
    const subTo = scValToNative(subArgs[1]) as string;
    const subAmount = scValToNative(subArgs[2]) as bigint;
    if (
      subFrom !== commitment.from ||
      subTo !== expectedSettlementContract ||
      subAmount !== commitment.maxAmount
    ) {
      return { ok: false, error: "invalid_upto_stellar_witness_wrong_escrow_subinvocation" };
    }
  } catch {
    return { ok: false, error: "invalid_upto_stellar_witness_wrong_escrow_subinvocation" };
  }

  return { ok: true, value: { entry, commitment } };
}

/**
 * Extracts the Soroban auth entry's own signature-expiration ledger (distinct
 * from the contract-level `deadline`, which is a Unix timestamp).
 *
 * @param entry - A decoded, address-credentialed authorization entry
 * @returns The ledger sequence after which the Soroban host will reject the signature
 */
export function getSignatureExpirationLedger(entry: xdr.SorobanAuthorizationEntry): number {
  return entry.credentials().address().signatureExpirationLedger();
}
