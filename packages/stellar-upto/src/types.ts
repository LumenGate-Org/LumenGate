/**
 * The `payload` field of a `PaymentPayload` for the `upto` scheme on Stellar.
 *
 * The client signs one Soroban authorization entry (the "witness") committing to
 * everything except `actualAmount` — see `contracts/upto-settlement` and
 * `specs/schemes/upto/scheme_upto_stellar.md` for why this shape is necessary on Soroban
 * (there is no Permit2-style signature-witness contract pattern here).
 */
export type UptoStellarPayloadV2 = {
  /** Base64 XDR of the client-signed `xdr.SorobanAuthorizationEntry` (the witness). */
  authEntry: string;
  /**
   * Request-scoped replay-protection nonce, decimal string (u64). Distinct from
   * the Soroban authorization entry's own internal nonce field — this one is the
   * contract-level single-use key the settlement contract checks explicitly, so
   * this scheme's replay safety does not depend on host-level auth-entry nonce
   * semantics.
   */
  requestNonce: string;
  /** Unix timestamp (seconds) after which this authorization is no longer valid. */
  deadline: string;
};

/**
 * `PaymentRequirements.extra` for the `upto` scheme on Stellar.
 */
export type UptoStellarExtra = {
  /** Deployed `x402UptoStellarSettlement` contract address for this network. */
  settlementContract: string;
  /** The facilitator address that will call `settle` and receive `feeBps` (if any). */
  facilitatorAddress: string;
  /**
   * Fee, in basis points, the facilitator will take on-chain at settlement time.
   * `0` = standard `upto` (100% to `payTo`, facilitator bills off-chain, mirrors
   * the `exact` scheme's billing model). `> 0` = "managed upto": the client's
   * signature commits to this exact value, so the facilitator cannot raise its
   * cut after the fact. Must be `<= maxFeeBps` reported by the contract.
   */
  feeBps: number;
  /** Whether the facilitator sponsors the Stellar network fee for settlement. */
  areFeesSponsored: boolean;
};

/**
 * The witness commitment: everything the client's signature binds, deliberately
 * excluding the actual settlement amount (only its ceiling, `maxAmount`, is
 * signed). Shared by both the client (to sign) and the facilitator (to verify
 * and to reconstruct the exact same authorized invocation at settle time) so
 * the two sides can never encode this differently.
 */
export type UptoWitnessCommitment = {
  from: string;
  payTo: string;
  facilitator: string;
  token: string;
  maxAmount: bigint;
  requestNonce: bigint;
  deadline: bigint;
  feeBps: number;
};
