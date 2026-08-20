import {
  Address,
  BASE_FEE,
  Operation,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { Api } from "@stellar/stellar-sdk/rpc";
import {
  getNetworkPassphrase,
  getRpcClient,
  isStellarNetwork,
  STELLAR_WILDCARD_CAIP2,
  type FacilitatorStellarSigner,
  type RpcConfig,
} from "@x402/stellar";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { buildSettleScArgs, buildWitnessScArgs } from "../witness.js";
import { decodeWitnessEntry, getSignatureExpirationLedger } from "./decode.js";
import {
  DEADLINE_CLOCK_SKEW_TOLERANCE_SECONDS,
  MAX_FEE_BPS,
  SIGNATURE_EXPIRATION_LEDGER_TOLERANCE,
  SUPPORTED_X402_VERSION,
} from "../constants.js";
import type { UptoStellarExtra, UptoStellarPayloadV2, UptoWitnessCommitment } from "../types.js";

const DEFAULT_TIMEOUT_SECONDS = 60;
// Higher than `exact`'s 50,000-stroop default: `settle` does up to two token
// transfers plus the witness auth check and a nonce-storage write, so its
// simulation-derived resource fee typically runs ~2-3x a single transfer.
// Measured ~132,411 stroops (~0.0132 XLM) for a two-transfer managed-upto
// settlement against a live testnet SAC in e2e/conformance; 250,000 leaves headroom.
const DEFAULT_MAX_TRANSACTION_FEE_STROOPS = 250_000;
const DEFAULT_POLL_ATTEMPTS = 15;
const DEFAULT_POLL_DELAY_MS = 1000;
const MAX_SETTLEMENT_CACHE_ENTRIES = 10_000;

/**
 * Computes `settle()`'s idempotency cache key: a fingerprint of the *entire*
 * `payload` (including `payload.accepted`, not just the witness) and
 * `requirements`. A cache hit skips `_verifyUnguarded` entirely (see
 * `settle()`) — no decode, no witness cross-checks, no RPC — which used to
 * mean a cache hit was returned for any request sharing just the witness
 * bytes and settle amount, regardless of what else the caller supplied.
 * Since a successful settle also drives `onAfterSettle` hooks (Bazaar
 * cataloging, off-chain billing) using *this specific request's*
 * `paymentPayload`/`requirements` — not whatever was used the first time —
 * a narrower key let a replay carrying the same witness+amount but a
 * mutated `payload.accepted` (different `payTo`/`asset`/`amount`/etc.) ride
 * a prior real settlement's cached success straight past validation and
 * into cataloging fabricated economics. Fingerprinting the whole request
 * closes that: a cache hit now only ever fires for a byte-for-byte
 * equivalent retry, which is the only case idempotency is meant to cover.
 * See `e2e/conformance/CONFORMANCE_REPORT.md`, "idempotency cache bypasses
 * validation," for the full writeup.
 *
 * Still computed from the *undecoded* payload (no decode/RPC needed), so a
 * cache hit is just as cheap as before — only the fingerprint got wider, not
 * the work needed to compute it.
 *
 * @param payload - The full payment payload (witness, JSON-carried nonce/deadline, and `accepted`)
 * @param requirements - The full payment requirements for this call
 * @returns The cache key, or `undefined` if the payload doesn't carry a witness at all
 */
export function computeSettlementCacheKey(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): string | undefined {
  const stellarPayload = payload.payload as unknown as Partial<UptoStellarPayloadV2> | undefined;
  if (stellarPayload?.authEntry === undefined) return undefined;
  // Plain `JSON.stringify`, not a canonicalized/key-sorted form: differing
  // key order between two calls just means a cache *miss* (falls through to
  // full re-validation) rather than a false hit, which is the safe failure
  // direction — this can only under-cache, never mis-cache.
  return JSON.stringify([payload, requirements]);
}

/**
 * Helper to build a `VerifyResponse` with `isValid: false`.
 *
 * @param reason - The error reason code
 * @param payer - Optional payer address, when known
 * @param message - Optional human-readable detail
 * @returns An invalid `VerifyResponse`
 */
function invalid(reason: string, payer?: string, message?: string): VerifyResponse {
  return { isValid: false, invalidReason: reason, payer, invalidMessage: message };
}

type Phase = "verify" | "settle";

type InternalVerifyResult = {
  response: VerifyResponse;
  commitment?: UptoWitnessCommitment;
  entry?: xdr.SorobanAuthorizationEntry;
  simResponse?: Api.SimulateTransactionSuccessResponse;
  settleAmount?: bigint;
};

export interface UptoStellarFacilitatorOptions {
  rpcConfig?: RpcConfig;
  /** Safety ceiling on the *Stellar network fee* of the settlement transaction
   * itself (stroops) — unrelated to `fee_bps`, which is the contract-level
   * seller/facilitator revenue split. Mirrors the equivalent ceiling in
   * `@x402/stellar`'s `exact` scheme facilitator (whose default is lower, since
   * it does a single transfer). Default: 250,000 stroops. */
  maxTransactionFeeStroops?: number;
  selectSigner?: (addresses: readonly string[]) => string;
  /**
   * Optional pool of dedicated Stellar accounts used only as the settlement
   * transaction's *source account* (sequence number + fee), decoupled from
   * `commitment.facilitator` — the address the contract's
   * `facilitator.require_auth()` actually checks (see `buildSettleOperation`).
   * Without this, every settlement submitted by a given facilitator signer
   * serializes on that one account's sequence number under concurrent load
   * (see "Sequence-number bottlenecks" in `docs/architecture.md`); a channel
   * account pool lets settlements for the *same* `facilitator` address
   * proceed concurrently, since each submission consumes a different
   * channel account's sequence number instead. Channel accounts never need a
   * SEP-41 trustline or any token balance — they only ever pay the Stellar
   * network fee and hold the transaction's sequence number, never move
   * settlement funds themselves. If omitted, falls back to the pre-channel-account
   * behavior: the facilitator signer itself is both the transaction source
   * and the operation source (unchanged, fully backward compatible).
   */
  channelAccounts?: FacilitatorStellarSigner[];
  selectChannelAccount?: (addresses: readonly string[]) => string;
}

/**
 * Stellar facilitator implementation for the `upto` payment scheme, settling
 * against a deployed `x402UptoStellarSettlement` contract instance per
 * network. See `specs/schemes/upto/scheme_upto_stellar.md` for the full protocol spec and
 * `contracts/upto-settlement` for the contract this verifies/settles against.
 */
export class UptoStellarScheme implements SchemeNetworkFacilitator {
  readonly scheme = "upto";
  readonly caipFamily = STELLAR_WILDCARD_CAIP2;

  public readonly signingAddresses: ReadonlySet<string>;
  public readonly rpcConfig?: RpcConfig;
  public readonly maxTransactionFeeStroops: number;
  private readonly signerMap: Map<string, FacilitatorStellarSigner>;
  private readonly selectSigner: (addresses: readonly string[]) => string;
  private readonly settlementContracts: ReadonlyMap<string, string>;
  private readonly settlementCache: Map<string, SettleResponse> = new Map();
  private readonly channelAccountMap: Map<string, FacilitatorStellarSigner>;
  private readonly channelAccountAddresses: string[];
  private readonly selectChannelAccount: (addresses: readonly string[]) => string;

  /**
   * @param signers - One or more Stellar signers managed by the facilitator for settlement
   * @param settlementContracts - Deployed `x402UptoStellarSettlement` contract address per network (CAIP-2 -> C-address)
   * @param options - Configuration options
   */
  constructor(
    signers: FacilitatorStellarSigner[],
    settlementContracts: Record<string, string>,
    options: UptoStellarFacilitatorOptions = {},
  ) {
    if (!signers || signers.length === 0) {
      throw new Error("At least one signer is required");
    }
    this.signerMap = new Map(signers.map(s => [s.address, s]));
    this.signingAddresses = new Set(this.signerMap.keys());
    this.settlementContracts = new Map(Object.entries(settlementContracts));
    this.rpcConfig = options.rpcConfig;
    this.maxTransactionFeeStroops =
      options.maxTransactionFeeStroops ?? DEFAULT_MAX_TRANSACTION_FEE_STROOPS;
    this.selectSigner =
      options.selectSigner ??
      (() => {
        let i = 0;
        return (addrs: readonly string[]) => addrs[i++ % addrs.length];
      })();
    this.channelAccountMap = new Map((options.channelAccounts ?? []).map(s => [s.address, s]));
    this.channelAccountAddresses = [...this.channelAccountMap.keys()];
    this.selectChannelAccount =
      options.selectChannelAccount ??
      (() => {
        let i = 0;
        return (addrs: readonly string[]) => addrs[i++ % addrs.length];
      })();
  }

  getExtra(network: Network): Record<string, unknown> | undefined {
    const settlementContract = this.settlementContracts.get(network);
    if (!settlementContract) return undefined;
    return {
      settlementContract,
      // Rotates across configured signers (via `selectSigner`) for load
      // distribution across *new* quote requests. Once a client signs a
      // witness against a given address, settlement always uses that same
      // address (see `settle()`) — this only balances which address gets
      // advertised to clients who haven't signed anything yet.
      facilitatorAddress: this.selectSigner([...this.signingAddresses]),
      maxFeeBps: MAX_FEE_BPS,
      areFeesSponsored: true,
    };
  }

  getSigners(_network: string): string[] {
    return [...this.signingAddresses];
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    return (await this._verify(payload, requirements, "verify")).response;
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    // Idempotency: a retried /settle call for the exact same witness (network
    // blip, resource-server retry logic) should return the same result the
    // first call already produced, not redo full verification and a wasted
    // RPC simulate before failing with a confusing "already settled" error.
    // Keyed on the raw witness bytes (+ the amount being settled) rather than
    // the decoded commitment, so a cache hit short-circuits *before* any
    // decode or RPC work — the whole point of caching. Only successful
    // outcomes are cached: a failure might be transient (e.g. a dropped RPC
    // call), so retries after a failure should genuinely retry, matching
    // standard payment-API idempotency conventions.
    const cacheKey = computeSettlementCacheKey(payload, requirements);
    if (cacheKey) {
      const cached = this.settlementCache.get(cacheKey);
      if (cached) return cached;
    }

    const result = await this.settleUnguarded(payload, requirements);

    if (cacheKey && result.success) {
      if (this.settlementCache.size >= MAX_SETTLEMENT_CACHE_ENTRIES) {
        // Simple FIFO eviction (Map iteration order is insertion order) —
        // this is a correctness safety net against unbounded memory growth,
        // not a tuned LRU; a prototype-appropriate bound, not a production cache.
        const oldestKey = this.settlementCache.keys().next().value;
        if (oldestKey !== undefined) this.settlementCache.delete(oldestKey);
      }
      this.settlementCache.set(cacheKey, result);
    }

    return result;
  }

  private async settleUnguarded(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const server = getRpcClient(requirements.network, this.rpcConfig);
    const networkPassphrase = getNetworkPassphrase(requirements.network);
    let payer: string | undefined;
    let txHash: string | undefined;

    try {
      const verifyResult = await this._verify(payload, requirements, "settle");
      if (!verifyResult.response.isValid) {
        return {
          success: false,
          network: payload.accepted.network,
          transaction: "",
          errorReason: verifyResult.response.invalidReason ?? "verification_failed",
          payer: verifyResult.response.payer,
        };
      }
      const { commitment, entry, simResponse, settleAmount } = verifyResult;
      if (!commitment || !entry || !simResponse || settleAmount === undefined) {
        return {
          success: false,
          network: payload.accepted.network,
          transaction: "",
          errorReason: "unexpected_settle_error",
          payer: verifyResult.response.payer,
        };
      }
      payer = commitment.from;

      // No off-chain short-circuit for `settleAmount === 0n`: the contract's
      // own zero-settlement path (contracts/upto-settlement/src/lib.rs) still
      // writes the nonce to storage before checking `actual_amount == 0`, so
      // on-chain a zero settlement is just as final as a nonzero one — it
      // permanently consumes the witness. Skipping the transaction here would
      // leave the nonce unburned, so the same witness would remain settleable
      // for a real, nonzero amount later, silently breaking the "one witness,
      // one settlement" guarantee the contract is designed to provide. Always
      // submit, even for zero, to keep off-chain and on-chain finality in sync.

      // MUST be the specific signer the client's witness names as `facilitator`
      // (not a round-robin pick over all configured signers): the contract now
      // requires `facilitator.require_auth()`, which is satisfied by this
      // transaction's own source-account signature only when the submitting
      // signer's address matches the witness-committed `facilitator` exactly.
      // Round-robin (`selectSigner`) still determines which address `getExtra()`
      // advertises to *new* quote requests; once a client has signed against a
      // given address, settlement must use that same address.
      const signer = this.signerMap.get(commitment.facilitator);
      if (!signer) {
        return {
          success: false,
          network: payload.accepted.network,
          transaction: "",
          errorReason: "settle_upto_stellar_signer_selection_failed",
          payer,
        };
      }

      const settlementContract = this.settlementContracts.get(requirements.network)!;
      const op = buildSettleOperation(settlementContract, commitment, settleAmount, entry);
      const sorobanData = simResponse.transactionData.build();

      // Channel account: pays the transaction's fee and consumes its
      // sequence number, decoupled from `signer` (the facilitator address
      // the contract's `facilitator.require_auth()` actually checks —
      // `buildSettleOperation` sets the *operation's* own source to
      // `commitment.facilitator` regardless of who the *transaction's*
      // source is). Without one configured, falls back to the
      // pre-channel-account behavior: `signer` is both. See
      // "Sequence-number bottlenecks" in docs/architecture.md.
      const channelAccountAddress =
        this.channelAccountAddresses.length > 0
          ? this.selectChannelAccount(this.channelAccountAddresses)
          : undefined;
      const channelSigner = channelAccountAddress
        ? this.channelAccountMap.get(channelAccountAddress)
        : undefined;
      const txSourceSigner = channelSigner ?? signer;

      const txSourceAccount = await server.getAccount(txSourceSigner.address);
      const rebuiltTx = new TransactionBuilder(txSourceAccount, {
        fee: BASE_FEE,
        networkPassphrase,
        sorobanData,
      })
        .setTimeout(requirements.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS)
        .addOperation(op)
        .build();

      // Sign with the transaction-source account first (channel account, if
      // configured; otherwise `signer` itself, unchanged from before). When a
      // channel account is in use, a *second* signature from `signer` is
      // required too: the operation's own source is `commitment.facilitator`
      // (set in `buildSettleOperation`), distinct from the transaction's
      // source, so the classic operation-source authorization and the
      // `facilitator.require_auth()` Soroban auth entry both need
      // `signer`'s signature on the envelope — `signTransaction` (via
      // `@stellar/stellar-sdk`'s `Transaction.sign`) appends a signature to
      // the existing signature list rather than replacing it, so signing
      // twice with two different keys against the same XDR round-trip is
      // safe and additive.
      const txSourceSigned = await txSourceSigner.signTransaction(rebuiltTx.toXDR(), {
        networkPassphrase,
      });
      if (txSourceSigned.error) {
        return {
          success: false,
          network: payload.accepted.network,
          transaction: "",
          errorReason: "settle_upto_stellar_transaction_signing_failed",
          payer,
        };
      }

      let signedTxXdr = txSourceSigned.signedTxXdr;
      if (channelSigner) {
        const facilitatorSigned = await signer.signTransaction(signedTxXdr, { networkPassphrase });
        if (facilitatorSigned.error) {
          return {
            success: false,
            network: payload.accepted.network,
            transaction: "",
            errorReason: "settle_upto_stellar_transaction_signing_failed",
            payer,
          };
        }
        signedTxXdr = facilitatorSigned.signedTxXdr;
      }

      const txToSubmit = TransactionBuilder.fromXDR(signedTxXdr, networkPassphrase);
      const sendResult = await server.sendTransaction(txToSubmit);
      if (sendResult.status !== "PENDING") {
        return {
          success: false,
          network: payload.accepted.network,
          transaction: "",
          errorReason: "settle_upto_stellar_transaction_submission_failed",
          payer,
        };
      }

      txHash = sendResult.hash;
      const confirmed = await pollForTransaction(
        server,
        txHash,
        requirements.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
      );
      if (!confirmed) {
        return {
          success: false,
          network: payload.accepted.network,
          transaction: txHash,
          errorReason: "settle_upto_stellar_transaction_failed",
          payer,
        };
      }

      return {
        success: true,
        transaction: txHash,
        network: payload.accepted.network,
        payer,
        amount: settleAmount.toString(),
      };
    } catch (error) {
      console.error("Unexpected upto settlement error:", error);
      return {
        success: false,
        network: payload.accepted.network,
        transaction: txHash || "",
        errorReason: "unexpected_settle_error",
        payer,
      };
    }
  }

  /**
   * Shared verify/settle validation. `phase` controls how `requirements.amount`
   * is interpreted, per the `upto` scheme's phase-dependent semantics: the
   * *ceiling* always comes from the signed witness commitment (never from
   * `requirements` or `payload.accepted`, which are not cryptographically
   * bound), while `requirements.amount` supplies the maximum to authorize
   * against (verify) or the actual amount to settle, bounded by that ceiling
   * (settle).
   *
   * @param payload - The payment payload to verify
   * @param requirements - The payment requirements (phase-dependent `amount`)
   * @param phase - Whether this call is for `/verify` or `/settle`
   * @returns Internal result carrying the response plus decoded state for `settle()` to reuse
   */
  private async _verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    phase: Phase,
  ): Promise<InternalVerifyResult> {
    try {
      return await this._verifyUnguarded(payload, requirements, phase);
    } catch (error) {
      // `verify()` (unlike `settle()`) has no other exception handler, and
      // every field this method touches (`requirements.amount` via `BigInt`,
      // decoded witness args, etc.) is attacker-influenced input reachable
      // with no funds and no valid signature — an uncaught exception here
      // would be a free, unauthenticated way to fault the endpoint.
      console.error("Unexpected upto verification error:", error);
      return { response: invalid("unexpected_verify_error") };
    }
  }

  private async _verifyUnguarded(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    phase: Phase,
  ): Promise<InternalVerifyResult> {
    if (payload.x402Version !== SUPPORTED_X402_VERSION) {
      return { response: invalid("invalid_x402_version") };
    }
    if (payload.accepted.scheme !== "upto" || requirements.scheme !== "upto") {
      return { response: invalid("unsupported_scheme") };
    }
    if (requirements.network !== payload.accepted.network) {
      return { response: invalid("network_mismatch") };
    }
    if (!isStellarNetwork(requirements.network)) {
      return { response: invalid("invalid_network") };
    }

    const settlementContract = this.settlementContracts.get(requirements.network);
    if (!settlementContract) {
      return { response: invalid("upto_stellar_network_not_configured") };
    }

    const stellarPayload = payload.payload as unknown as UptoStellarPayloadV2;
    if (
      !stellarPayload ||
      typeof stellarPayload.authEntry !== "string" ||
      typeof stellarPayload.requestNonce !== "string" ||
      typeof stellarPayload.deadline !== "string"
    ) {
      return { response: invalid("invalid_upto_stellar_payload_malformed") };
    }

    const decoded = decodeWitnessEntry(stellarPayload.authEntry, settlementContract);
    if (!decoded.ok) {
      return { response: invalid(decoded.error) };
    }
    const { entry, commitment } = decoded.value;

    // Cross-check the JSON-carried nonce/deadline against what's actually
    // signed — they must agree; the signed values are authoritative either way.
    if (
      commitment.requestNonce.toString() !== stellarPayload.requestNonce ||
      commitment.deadline.toString() !== stellarPayload.deadline
    ) {
      return { response: invalid("invalid_upto_stellar_payload_witness_mismatch", commitment.from) };
    }

    const extra = requirements.extra as unknown as Partial<UptoStellarExtra>;
    if (commitment.payTo !== requirements.payTo) {
      return {
        response: invalid("invalid_upto_stellar_payload_wrong_recipient", commitment.from),
      };
    }
    if (commitment.token !== requirements.asset) {
      return { response: invalid("invalid_upto_stellar_payload_wrong_asset", commitment.from) };
    }
    // Defaults a missing `extra.feeBps`/`feeFixed`/`feeMode` to the
    // Percentage-mode zero-fee shape rather than skipping the check —
    // otherwise a resource server (or client) that simply omits a field
    // would let the witness-signed value (entirely client-chosen, up to
    // `MAX_FEE_BPS`) through unchecked, silently reducing the seller's cut.
    if (
      commitment.feeBps !== (extra?.feeBps ?? 0) ||
      commitment.feeFixed !== BigInt(extra?.feeFixed ?? "0") ||
      commitment.feeMode !== (extra?.feeMode ?? 0)
    ) {
      return { response: invalid("invalid_upto_stellar_payload_wrong_fee_bps", commitment.from) };
    }
    if (commitment.feeBps > MAX_FEE_BPS) {
      return { response: invalid("invalid_upto_stellar_fee_exceeds_maximum", commitment.from) };
    }
    if (commitment.feeFixed < 0n) {
      return { response: invalid("invalid_upto_stellar_fee_exceeds_maximum", commitment.from) };
    }
    // `settlementContract` is never taken from `extra` for the facilitator's
    // own settlement logic (it always uses its own resolved config, above),
    // so a mismatch here can't misdirect funds — but both fields are
    // operationally required, not merely advisory: a client cannot even
    // construct a witness without them (`UptoStellarScheme` (client)
    // requires `settlementContract` and `facilitatorAddress` to build the
    // payload at all — `packages/stellar-upto/src/client/scheme.ts`), and
    // `getExtra()` (this facilitator's own quote) always includes both. So
    // a `requirements`/`accepted` that omits either is never something an
    // honest, complete integration could produce — required unconditionally
    // (not just "if present"), otherwise a settlement could go through with
    // one or both silently missing, cataloging incomplete upto terms a
    // future buyer can't actually construct a payment from.
    if (extra?.settlementContract !== settlementContract) {
      return {
        response: invalid("invalid_upto_stellar_payload_wrong_settlement_contract", commitment.from),
      };
    }
    if (extra?.facilitatorAddress !== commitment.facilitator) {
      return {
        response: invalid("invalid_upto_stellar_payload_extra_facilitator_mismatch", commitment.from),
      };
    }

    // --- Facilitator safety: mirrors `exact`'s checks and the contract's own. ---
    if (!this.signingAddresses.has(commitment.facilitator)) {
      return {
        response: invalid("invalid_upto_stellar_payload_wrong_facilitator", commitment.from),
      };
    }
    if (this.signingAddresses.has(commitment.from)) {
      return {
        response: invalid("invalid_upto_stellar_payload_facilitator_is_payer", commitment.from),
      };
    }
    if (this.signingAddresses.has(commitment.payTo)) {
      return {
        response: invalid("invalid_upto_stellar_payload_facilitator_is_payee", commitment.from),
      };
    }

    // --- `payload.accepted` consistency: `accepted` is the client-echoed
    // advertised terms, phase-invariant by protocol design (unlike
    // `requirements`, whose `.amount` is deliberately overridden at settle
    // time to the metered actual charge — see the phase-dependent amount
    // check below). For the standard `@x402/express` integration path,
    // `@x402/core` already deep-equality-checks `accepted` against the
    // resource server's own declared price before `verify()` is even
    // called. This facilitator's own `/verify`/`/settle` HTTP routes are
    // necessarily public, though (see "public /settle" in
    // docs/architecture.md), so nothing stops a *direct* caller from
    // supplying a real, validly-signed witness alongside an `accepted`
    // object with different payTo/asset/feeBps/amount/settlementContract/
    // facilitatorAddress. That mismatch wouldn't move funds incorrectly
    // (settlement itself is driven by `requirements` and the witness,
    // checked above and below), but `accepted` also flows unchanged into
    // Bazaar cataloging on a successful settlement
    // (`packages/facilitator/src/discovery-hooks.ts`) — so left unchecked, a
    // direct caller could publish fabricated payTo/asset/price/contract
    // economics for a real, settled resource. Anchoring every field of
    // `accepted` to the same witness commitment `requirements` was already
    // checked against closes that.
    const accepted = payload.accepted;
    if (accepted.payTo !== commitment.payTo || accepted.asset !== commitment.token) {
      return {
        response: invalid("invalid_upto_stellar_payload_accepted_inconsistent", commitment.from),
      };
    }
    const acceptedExtra = accepted.extra as unknown as Partial<UptoStellarExtra>;
    if (
      commitment.feeBps !== (acceptedExtra?.feeBps ?? 0) ||
      commitment.feeFixed !== BigInt(acceptedExtra?.feeFixed ?? "0") ||
      commitment.feeMode !== (acceptedExtra?.feeMode ?? 0)
    ) {
      return {
        response: invalid("invalid_upto_stellar_payload_accepted_inconsistent", commitment.from),
      };
    }
    // Required unconditionally, same reasoning as the `requirements` check
    // above: an honest client cannot construct a witness without both
    // fields, so a missing one is never legitimate.
    if (
      acceptedExtra?.settlementContract !== settlementContract ||
      acceptedExtra?.facilitatorAddress !== commitment.facilitator
    ) {
      return {
        response: invalid("invalid_upto_stellar_payload_accepted_inconsistent", commitment.from),
      };
    }
    if (!/^\d+$/.test(accepted.amount) || BigInt(accepted.amount) !== commitment.maxAmount) {
      return {
        response: invalid("invalid_upto_stellar_payload_accepted_inconsistent", commitment.from),
      };
    }

    // --- Amount semantics: phase-dependent per the `upto` scheme spec. ---
    if (!/^\d+$/.test(requirements.amount)) {
      return {
        response: invalid("invalid_upto_stellar_payload_malformed_amount", commitment.from),
      };
    }
    const requirementsAmount = BigInt(requirements.amount);
    let settleAmount: bigint;
    if (phase === "verify") {
      if (requirementsAmount !== commitment.maxAmount) {
        return {
          response: invalid("invalid_upto_stellar_payload_wrong_max_amount", commitment.from),
        };
      }
      settleAmount = commitment.maxAmount;
    } else {
      if (requirementsAmount < 0n || requirementsAmount > commitment.maxAmount) {
        return {
          response: invalid(
            "invalid_upto_stellar_settlement_exceeds_amount",
            commitment.from,
            `settlement amount ${requirementsAmount} exceeds authorized maximum ${commitment.maxAmount}`,
          ),
        };
      }
      settleAmount = requirementsAmount;
    }

    // --- Time bounds ---
    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
    if (commitment.deadline < nowSeconds - BigInt(DEADLINE_CLOCK_SKEW_TOLERANCE_SECONDS)) {
      return { response: invalid("invalid_upto_stellar_deadline_expired", commitment.from) };
    }

    const server = getRpcClient(requirements.network, this.rpcConfig);
    const networkPassphrase = getNetworkPassphrase(requirements.network);

    const latestLedger = await server.getLatestLedger();
    const expirationLedger = getSignatureExpirationLedger(entry);
    if (expirationLedger <= latestLedger.sequence - SIGNATURE_EXPIRATION_LEDGER_TOLERANCE) {
      return { response: invalid("invalid_upto_stellar_signature_expired", commitment.from) };
    }

    // --- Allowance headroom check: cheap pre-flight before spending a
    // simulate call. The contract's own `transfer_from` is the authoritative
    // enforcement; this just avoids wasting an RPC round-trip on a doomed call. ---
    const allowance = await getAllowance(
      server,
      commitment.token,
      commitment.from,
      settlementContract,
      networkPassphrase,
      commitment.facilitator,
    );
    if (allowance === null) {
      return { response: invalid("invalid_upto_stellar_allowance_check_failed", commitment.from) };
    }
    if (allowance < settleAmount) {
      return {
        response: invalid(
          "invalid_upto_stellar_insufficient_allowance",
          commitment.from,
          `allowance ${allowance} < required ${settleAmount}; client must approve the settlement contract first`,
        ),
      };
    }

    // --- Simulate the real settle invocation with the signed witness attached. ---
    const op = buildSettleOperation(settlementContract, commitment, settleAmount, entry);
    const facilitatorAccount = await server.getAccount(commitment.facilitator);
    const simTx = new TransactionBuilder(facilitatorAccount, { fee: BASE_FEE, networkPassphrase })
      .setTimeout(requirements.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS)
      .addOperation(op)
      .build();

    const simResponse = await server.simulateTransaction(simTx);
    if (!Api.isSimulationSuccess(simResponse)) {
      const errorMsg = "error" in simResponse && simResponse.error ? `: ${simResponse.error}` : "";
      console.error("upto simulation error:", errorMsg);
      return {
        response: invalid("invalid_upto_stellar_simulation_failed", commitment.from, errorMsg),
      };
    }

    const minResourceFee = parseInt(simResponse.minResourceFee, 10);
    const settlementFeeStroops = minResourceFee + parseInt(BASE_FEE, 10);
    if (settlementFeeStroops > this.maxTransactionFeeStroops) {
      return {
        response: invalid(
          "invalid_upto_stellar_fee_exceeds_maximum",
          commitment.from,
          `simulation-derived fee ${settlementFeeStroops} stroops exceeds ceiling ${this.maxTransactionFeeStroops} stroops`,
        ),
      };
    }

    return {
      response: { isValid: true, payer: commitment.from },
      commitment,
      entry,
      simResponse,
      settleAmount,
    };
  }
}

/**
 * Builds the `invokeHostFunction` operation for a `settle` call, with the
 * client's pre-signed witness entry attached directly (not re-derived from
 * simulation) — the facilitator supplies `actualAmount`, which the witness
 * deliberately does not constrain beyond the `<= maxAmount` bound the contract
 * enforces on-chain.
 *
 * @param settlementContract - The deployed settlement contract address
 * @param commitment - The decoded witness commitment
 * @param actualAmount - The amount to settle for (verify: maxAmount; settle: metered amount)
 * @param signedEntry - The client's pre-signed witness authorization entry
 * @returns The `invokeHostFunction` operation, ready to attach to a transaction
 */
export function buildSettleOperation(
  settlementContract: string,
  commitment: UptoWitnessCommitment,
  actualAmount: bigint,
  signedEntry: xdr.SorobanAuthorizationEntry,
): xdr.Operation {
  const settleArgs = buildSettleScArgs(commitment, actualAmount);
  const invokeContractArgs = new xdr.InvokeContractArgs({
    contractAddress: new Address(settlementContract).toScAddress(),
    functionName: "settle",
    args: settleArgs,
  });
  const hostFunction = xdr.HostFunction.hostFunctionTypeInvokeContract(invokeContractArgs);

  // The contract also calls `facilitator.require_auth()` (see
  // contracts/upto-settlement/src/lib.rs). This entry doesn't carry its own
  // address/signature — `sorobanCredentialsSourceAccount` means "satisfied by
  // whichever account this *operation's* source account is" (CAP-0046-11),
  // which is why `source: commitment.facilitator` below is set explicitly
  // rather than left to default from the transaction's own source account:
  // the two are the same address when no channel account is in use (the
  // pre-channel-account behavior, preserved), but differ when a channel
  // account pays the transaction's fee/sequence while `commitment.facilitator`
  // remains the operation's source and the one whose signature actually
  // satisfies this auth entry (see `settleUnguarded`, "channel account"
  // signing). Building the operation manually (rather than via
  // `contract.AssembledTransaction`, which would auto-populate this) means
  // this entry must be added explicitly.
  const facilitatorAuthEntry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        invokeContractArgs,
      ),
      subInvocations: [],
    }),
  });

  return Operation.invokeHostFunction({
    func: hostFunction,
    auth: [signedEntry, facilitatorAuthEntry],
    source: commitment.facilitator,
  });
}

/**
 * Reads the SEP-41 `allowance(from, spender)` via a read-only simulation.
 *
 * @param server - Soroban RPC client
 * @param token - Token contract address
 * @param from - The token owner
 * @param spender - The settlement contract address
 * @param networkPassphrase - Network passphrase for the simulated transaction
 * @param sourceAccount - An existing funded account to use as the simulated transaction's source
 * @returns The allowance amount, or `null` if the read failed
 */
async function getAllowance(
  server: ReturnType<typeof getRpcClient>,
  token: string,
  from: string,
  spender: string,
  networkPassphrase: string,
  sourceAccount: string,
): Promise<bigint | null> {
  try {
    const account = await server.getAccount(sourceAccount);
    const invokeContractArgs = new xdr.InvokeContractArgs({
      contractAddress: new Address(token).toScAddress(),
      functionName: "allowance",
      args: [new Address(from).toScVal(), new Address(spender).toScVal()],
    });
    const op = Operation.invokeHostFunction({
      func: xdr.HostFunction.hostFunctionTypeInvokeContract(invokeContractArgs),
      auth: [],
    });
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
      .setTimeout(30)
      .addOperation(op)
      .build();
    const simResponse = await server.simulateTransaction(tx);
    if (!Api.isSimulationSuccess(simResponse) || !simResponse.result) {
      return null;
    }
    return scValToNative(simResponse.result.retval) as bigint;
  } catch (error) {
    console.error("upto allowance check failed:", error);
    return null;
  }
}

async function pollForTransaction(
  server: ReturnType<typeof getRpcClient>,
  txHash: string,
  maxTimeoutSeconds: number,
  delayMs = DEFAULT_POLL_DELAY_MS,
): Promise<boolean> {
  const maxAttempts = Math.max(maxTimeoutSeconds, DEFAULT_POLL_ATTEMPTS);
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const result = await server.getTransaction(txHash);
      if (result.status === "SUCCESS") return true;
      if (result.status === "FAILED") return false;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    } catch (error) {
      if (error instanceof Error && !error.message.includes("NOT_FOUND")) {
        console.warn(`upto poll attempt ${i} failed:`, error);
      }
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return false;
}

// Re-exported for facilitator-side tooling that wants to independently
// recompute the expected witness args (e.g. admin/debug endpoints).
export { buildWitnessScArgs };
