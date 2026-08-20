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
 * How `feeBps`/`feeFixed` combine into the effective on-chain facilitator
 * fee, mirroring `BillingFeeConfig`'s off-chain shape
 * (`packages/facilitator/src/billing.ts`) so the same configurable
 * fixed/percentage/combined business model applies to managed `upto`, not
 * only to the off-chain-billed tiers. Numeric values MUST match
 * `FeeMode` in `contracts/upto-settlement/src/lib.rs` (and the escrow
 * design's mirror) exactly — this is part of the signed witness.
 */
export const UptoFeeMode = {
  /** `fee = actualAmount * feeBps / 10_000`. `feeFixed` is ignored. */
  Percentage: 0,
  /** `fee = feeFixed`, a flat amount in the settlement asset's own atomic
   * units (not USD — the contract has no price oracle). `feeBps` is
   * ignored. */
  Fixed: 1,
  /** `fee = min(feeFixed, actualAmount * feeBps / 10_000)`. */
  CombinedMin: 2,
  /** `fee = max(feeFixed, actualAmount * feeBps / 10_000)`. */
  CombinedMax: 3,
} as const;
export type UptoFeeMode = (typeof UptoFeeMode)[keyof typeof UptoFeeMode];

/**
 * `PaymentRequirements.extra` for the `upto` scheme on Stellar.
 */
export type UptoStellarExtra = {
  /** Deployed `x402UptoStellarSettlement` contract address for this network. */
  settlementContract: string;
  /** The facilitator address that will call `settle` and receive the fee (if any). */
  facilitatorAddress: string;
  /**
   * Percentage-component fee, in basis points, the facilitator will take
   * on-chain at settlement time. `0` = standard `upto` (100% to `payTo`,
   * facilitator bills off-chain, mirrors the `exact` scheme's billing
   * model). `> 0` (with `feeMode` including a percentage component) =
   * "managed upto": the client's signature commits to this exact value, so
   * the facilitator cannot raise its cut after the fact. The *effective*
   * fee is always bounded by `maxFeeBps` reported by the contract,
   * regardless of `feeMode`.
   */
  feeBps: number;
  /**
   * Fixed-component fee, in the settlement asset's own atomic units (not
   * USD), as a decimal string — `extra` crosses the wire as JSON, which
   * can't represent a `bigint` directly, the same reason `amount` is a
   * decimal string rather than a number. `"0"` when `feeMode` is
   * `Percentage`. Same signed-commitment and on-chain-ceiling guarantees as
   * `feeBps` apply.
   */
  feeFixed: string;
  /** How `feeBps`/`feeFixed` combine into the effective fee — see `UptoFeeMode`. */
  feeMode: UptoFeeMode;
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
  feeFixed: bigint;
  feeMode: UptoFeeMode;
};
