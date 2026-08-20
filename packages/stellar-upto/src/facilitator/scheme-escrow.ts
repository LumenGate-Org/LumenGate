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
import { buildSettleOperation, computeSettlementCacheKey } from "./scheme.js";
import { decodeEscrowWitnessEntry, getSignatureExpirationLedger } from "./decode.js";
import {
  DEADLINE_CLOCK_SKEW_TOLERANCE_SECONDS,
  MAX_FEE_BPS,
  SIGNATURE_EXPIRATION_LEDGER_TOLERANCE,
  SUPPORTED_X402_VERSION,
} from "../constants.js";
import type { UptoStellarExtra, UptoStellarPayloadV2, UptoWitnessCommitment } from "../types.js";

const DEFAULT_TIMEOUT_SECONDS = 60;
// Escrow settlement does up to three token transfers (pull, seller payout,
// refund) versus Design A's up to two (`transfer_from` seller/facilitator
// payout only) — see the resource-cost benchmark in
// docs/architecture.md ("Design alternative considered"), which measured
// this design's *total* fee as lower despite the extra transfer, since it
// never writes a persistent nonce record. 250,000 stroops leaves the same
// headroom Design A uses; kept as a separate constant so the two schemes'
// ceilings can diverge independently if benchmarks ever call for it.
const DEFAULT_MAX_TRANSACTION_FEE_STROOPS = 250_000;
const DEFAULT_POLL_ATTEMPTS = 15;
const DEFAULT_POLL_DELAY_MS = 1000;
const MAX_SETTLEMENT_CACHE_ENTRIES = 10_000;

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

export interface UptoStellarEscrowFacilitatorOptions {
  rpcConfig?: RpcConfig;
  /** Safety ceiling on the *Stellar network fee* of the settlement transaction
   * itself (stroops) — unrelated to `fee_bps`. Default: 250,000 stroops. */
  maxTransactionFeeStroops?: number;
  selectSigner?: (addresses: readonly string[]) => string;
  /** See `UptoStellarFacilitatorOptions.channelAccounts` (`./scheme.js`) —
   * identical role here: a pool of accounts supplying the settlement
   * transaction's source account/sequence number, decoupled from the
   * signer the contract's `facilitator.require_auth()` actually checks. */
  channelAccounts?: FacilitatorStellarSigner[];
  selectChannelAccount?: (addresses: readonly string[]) => string;
}

/**
 * Stellar facilitator implementation for the `upto` payment scheme, settling
 * against a deployed `x402UptoStellarEscrowSettlement` contract instance
 * (Design B — escrow-and-refund, `contracts/upto-settlement-escrow`) per
 * network.
 *
 * This is the project's primary, default `upto`/`managed upto`
 * implementation as of the escrow-and-refund comparison (see
 * `docs/architecture.md`, "Design alternative considered"): it needs no SEP-41 `approve`
 * prerequisite and the escrow contract owns zero persistent contract-level
 * storage, keeping the default design stateless
 * literally. The allowance-based design (`UptoStellarScheme`, Design A,
 * `contracts/upto-settlement`) remains available and fully tested,
 * selectable via the facilitator's `UPTO_DESIGN=allowance` configuration —
 * see `packages/facilitator/src/server.ts`.
 *
 * Structurally this class mirrors `UptoStellarScheme` (`./scheme.ts`)
 * closely — same idempotency cache, channel-account rotation, polling, and
 * witness/settle-args encoding (both contracts share the identical
 * `settle(from, pay_to, facilitator, token, max_amount, actual_amount,
 * request_nonce, deadline, fee_bps)` signature, so `buildSettleOperation` is
 * reused unmodified). The one real behavioral difference: where Design A's
 * `verify()` checks the buyer's SEP-41 *allowance* against the settlement
 * contract as a cheap pre-flight, this class checks the buyer's token
 * *balance* instead — there is no allowance to check under escrow-and-refund,
 * but a buyer without enough balance to cover `max_amount` would still fail
 * the real escrow pull at settlement time, so a balance pre-flight serves
 * the same "avoid a doomed RPC round-trip" purpose the allowance check does
 * for Design A.
 */
export class UptoStellarEscrowScheme implements SchemeNetworkFacilitator {
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
   * @param settlementContracts - Deployed `x402UptoStellarEscrowSettlement` contract address per network (CAIP-2 -> C-address)
   * @param options - Configuration options
   */
  constructor(
    signers: FacilitatorStellarSigner[],
    settlementContracts: Record<string, string>,
    options: UptoStellarEscrowFacilitatorOptions = {},
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
    const cacheKey = computeSettlementCacheKey(payload, requirements);
    if (cacheKey) {
      const cached = this.settlementCache.get(cacheKey);
      if (cached) return cached;
    }

    const result = await this.settleUnguarded(payload, requirements);

    if (cacheKey && result.success) {
      if (this.settlementCache.size >= MAX_SETTLEMENT_CACHE_ENTRIES) {
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

      // No off-chain short-circuit for `settleAmount === 0n`: like Design A,
      // this contract's witness authorization is consumed by the Soroban
      // host's own per-entry nonce the instant `settle` runs, regardless of
      // `actual_amount` — always submit, even for zero, to keep off-chain
      // and on-chain finality in sync.

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
      console.error("Unexpected upto (escrow) settlement error:", error);
      return {
        success: false,
        network: payload.accepted.network,
        transaction: txHash || "",
        errorReason: "unexpected_settle_error",
        payer,
      };
    }
  }

  private async _verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    phase: Phase,
  ): Promise<InternalVerifyResult> {
    try {
      return await this._verifyUnguarded(payload, requirements, phase);
    } catch (error) {
      console.error("Unexpected upto (escrow) verification error:", error);
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

    const decoded = decodeEscrowWitnessEntry(stellarPayload.authEntry, settlementContract);
    if (!decoded.ok) {
      return { response: invalid(decoded.error) };
    }
    const { entry, commitment } = decoded.value;

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

    // --- Balance headroom check: this design's equivalent of Design A's
    // allowance pre-flight. There is no allowance to check — the escrow pull
    // happens unconditionally inside `settle` — but a buyer whose balance is
    // already below `max_amount` will fail that pull deterministically, so
    // checking first avoids wasting an RPC round-trip on a doomed simulate
    // call, same rationale as Design A's check, different resource. Like
    // Design A's, this is advisory only: the contract's own transfer is the
    // authoritative enforcement. ---
    const balance = await getBalance(
      server,
      commitment.token,
      commitment.from,
      networkPassphrase,
      commitment.facilitator,
    );
    if (balance === null) {
      return { response: invalid("invalid_upto_stellar_balance_check_failed", commitment.from) };
    }
    if (balance < settleAmount) {
      return {
        response: invalid(
          "invalid_upto_stellar_insufficient_balance",
          commitment.from,
          `balance ${balance} < required ${settleAmount}`,
        ),
      };
    }

    const op = buildSettleOperation(settlementContract, commitment, settleAmount, entry);
    const facilitatorAccount = await server.getAccount(commitment.facilitator);
    const simTx = new TransactionBuilder(facilitatorAccount, { fee: BASE_FEE, networkPassphrase })
      .setTimeout(requirements.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS)
      .addOperation(op)
      .build();

    const simResponse = await server.simulateTransaction(simTx);
    if (!Api.isSimulationSuccess(simResponse)) {
      const errorMsg = "error" in simResponse && simResponse.error ? `: ${simResponse.error}` : "";
      console.error("upto (escrow) simulation error:", errorMsg);
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
 * Reads the SEP-41 `balance(id)` via a read-only simulation — this design's
 * pre-flight equivalent of `getAllowance` in `./scheme.ts` (Design A).
 *
 * @param server - Soroban RPC client
 * @param token - Token contract address
 * @param from - The token holder (buyer)
 * @param networkPassphrase - Network passphrase for the simulated transaction
 * @param sourceAccount - An existing funded account to use as the simulated transaction's source
 * @returns The balance amount, or `null` if the read failed
 */
async function getBalance(
  server: ReturnType<typeof getRpcClient>,
  token: string,
  from: string,
  networkPassphrase: string,
  sourceAccount: string,
): Promise<bigint | null> {
  try {
    const account = await server.getAccount(sourceAccount);
    const invokeContractArgs = new xdr.InvokeContractArgs({
      contractAddress: new Address(token).toScAddress(),
      functionName: "balance",
      args: [new Address(from).toScVal()],
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
    console.error("upto (escrow) balance check failed:", error);
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
        console.warn(`upto (escrow) poll attempt ${i} failed:`, error);
      }
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return false;
}
