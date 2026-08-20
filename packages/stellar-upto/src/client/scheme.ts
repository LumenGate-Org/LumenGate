import { contract, scValToNative, xdr, Operation } from "@stellar/stellar-sdk";
import {
  getEstimatedLedgerCloseTimeSeconds,
  getNetworkPassphrase,
  getRpcClient,
  getRpcUrl,
  handleSimulationResult,
  isStellarNetwork,
  validateStellarAssetAddress,
  validateStellarDestinationAddress,
  type ClientStellarSigner,
  type RpcConfig,
} from "@x402/stellar";
import type {
  PaymentPayloadContext,
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeNetworkClient,
} from "@x402/core/types";
import { buildSettleScArgs } from "../witness.js";
import type { UptoStellarExtra, UptoStellarPayloadV2, UptoWitnessCommitment } from "../types.js";

export interface UptoStellarClientOptions {
  rpcConfig?: RpcConfig;
  /** Override the request-nonce generator. Exposed for deterministic tests. */
  generateRequestNonce?: () => bigint;
}

/**
 * Stellar client implementation for the `upto` payment scheme.
 *
 * Signs one witness authorization (see `../witness.ts` and
 * `specs/schemes/upto/scheme_upto_stellar.md`) via `contract.AssembledTransaction`, the same
 * mechanism `@x402/stellar`'s `ExactStellarScheme` client uses — this way the
 * signed auth entry's contract address, function name, and args come directly
 * from simulating the real contract call rather than being hand-assembled in
 * TypeScript, eliminating an entire class of encoding-mismatch bugs.
 *
 * Requires the caller to have already approved a sufficient SEP-41 allowance to
 * `extra.settlementContract` (see `packages/sdk`'s `ensureUptoAllowance`
 * helper) — this scheme does not manage that one-time/session-amortized step
 * itself, mirroring how EVM's `upto` treats the Permit2 approval as a
 * prerequisite rather than something the scheme signs on every call.
 */
export class UptoStellarScheme implements SchemeNetworkClient {
  readonly scheme = "upto";

  constructor(
    private readonly signer: ClientStellarSigner,
    private readonly options: UptoStellarClientOptions = {},
  ) {}

  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
    _context?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult> {
    this.validateInput(paymentRequirements);

    const { network, payTo, asset, amount, maxTimeoutSeconds } = paymentRequirements;
    const extra = paymentRequirements.extra as unknown as UptoStellarExtra;
    const from = this.signer.address;
    const maxAmount = BigInt(amount);
    const requestNonce = (this.options.generateRequestNonce ?? generateRequestNonce)();
    const networkPassphrase = getNetworkPassphrase(network);
    const rpcUrl = getRpcUrl(network, this.options.rpcConfig);
    const rpcServer = getRpcClient(network, this.options.rpcConfig);

    const latestLedger = await rpcServer.getLatestLedger();
    const currentLedger = latestLedger.sequence;
    const estimatedLedgerSeconds = await getEstimatedLedgerCloseTimeSeconds(network);
    const maxLedger = currentLedger + Math.ceil(maxTimeoutSeconds / estimatedLedgerSeconds);

    // `deadline` is a Unix timestamp checked by the contract against
    // `env.ledger().timestamp()` — distinct from the auth entry's own
    // ledger-indexed `signatureExpirationLedger` (`maxLedger` below), which the
    // Soroban host checks independently when validating the signature itself.
    const deadline = BigInt(Math.floor(Date.now() / 1000) + maxTimeoutSeconds);

    const commitment: UptoWitnessCommitment = {
      from,
      payTo,
      facilitator: extra.facilitatorAddress,
      token: asset,
      maxAmount,
      requestNonce,
      deadline,
      feeBps: extra.feeBps,
      feeFixed: BigInt(extra.feeFixed),
      feeMode: extra.feeMode,
    };

    // Simulated with actualAmount = maxAmount (the worst case) purely to derive
    // a valid witness auth entry. The real actualAmount is decided by the
    // facilitator at settlement time and doesn't affect what's signed here —
    // `buildWitnessScArgs` deliberately excludes actual_amount from the args
    // that `require_auth_for_args` binds to.
    const tx = await contract.AssembledTransaction.build({
      contractId: extra.settlementContract,
      method: "settle",
      args: buildSettleScArgs(commitment, maxAmount),
      networkPassphrase,
      rpcUrl,
      parseResultXdr: (result: xdr.ScVal) => result,
    });
    handleSimulationResult(tx.simulation);

    // The simulated `settle` call also requires `facilitator.require_auth()`
    // (the contract's fix for a bearer-credential gap — see
    // `contracts/upto-settlement/src/lib.rs`), so `facilitator` legitimately
    // appears here too. The client only ever signs for `from`; the
    // facilitator's requirement is satisfied later, when it submits the
    // settlement transaction itself, by that transaction's own source-account
    // signature — not by anything the client provides.
    const missingSigners = tx.needsNonInvokerSigningBy();
    if (!missingSigners.includes(from)) {
      throw new Error(`Expected to sign with [${from}], but got [${missingSigners.join(", ")}]`);
    }

    await tx.signAuthEntries({
      address: from,
      signAuthEntry: this.signer.signAuthEntry,
      expiration: maxLedger,
    });

    const builtTx = tx.built;
    if (!builtTx) {
      throw new Error("upto: transaction assembly did not produce a built transaction");
    }
    const invokeOp = builtTx.operations[0] as Operation.InvokeHostFunction;
    // The auth array may now contain a second, unsigned entry for
    // `facilitator` (see above) — select specifically the entry whose
    // credentialed address is `from`, not just "any address-credentialed
    // entry", so the facilitator's placeholder is never mistaken for the
    // client's signed witness.
    const signedEntry = (invokeOp.auth ?? []).find(entry => {
      const credentials = entry.credentials();
      if (credentials.switch() !== xdr.SorobanCredentialsType.sorobanCredentialsAddress()) {
        return false;
      }
      const entryAddress = scValToNative(
        xdr.ScVal.scvAddress(credentials.address().address()),
      ) as string;
      return entryAddress === from;
    });
    if (!signedEntry) {
      throw new Error("upto: signing did not produce a witness authorization entry");
    }

    const payload: UptoStellarPayloadV2 = {
      authEntry: signedEntry.toXDR("base64"),
      requestNonce: requestNonce.toString(),
      deadline: deadline.toString(),
    };

    return { x402Version, payload };
  }

  private validateInput(paymentRequirements: PaymentRequirements): void {
    const { scheme, network, payTo, asset, amount, extra } = paymentRequirements;

    if (scheme !== "upto") {
      throw new Error(`Unsupported scheme: ${scheme}`);
    }
    if (!isStellarNetwork(network)) {
      throw new Error(`Unsupported Stellar network: ${network}`);
    }
    // A plain digit-string check, not `Number(amount)`: `Number` accepts
    // exponential notation ("1e3"), which passes `Number.isInteger` but
    // isn't valid input to the `BigInt(amount)` call below (`BigInt("1e3")`
    // throws `SyntaxError`, turning a validation problem into an uncaught
    // crash). `/^\d+$/` guarantees the string is safe to pass to `BigInt`.
    if (typeof amount !== "string" || !/^\d+$/.test(amount) || BigInt(amount) <= 0n) {
      throw new Error(`Invalid amount: ${amount}. Amount must be a positive integer.`);
    }
    if (!validateStellarDestinationAddress(payTo)) {
      throw new Error(`Invalid Stellar destination address: ${payTo}`);
    }
    if (!validateStellarAssetAddress(asset)) {
      throw new Error(`Invalid Stellar asset address: ${asset}`);
    }
    const uptoExtra = extra as unknown as Partial<UptoStellarExtra>;
    if (!uptoExtra.settlementContract || !validateStellarAssetAddress(uptoExtra.settlementContract)) {
      throw new Error(`Invalid or missing extra.settlementContract: ${uptoExtra.settlementContract}`);
    }
    // Same validator as `payTo` — a facilitator address is an ordinary
    // Stellar account (a signer's `G...` public key), not a contract. A
    // truthy-only check let a malformed remote 402 (e.g. a typo, or a
    // contract address confused for an account) fail later inside Soroban
    // arg construction/simulation instead of here, with a clear message.
    if (!uptoExtra.facilitatorAddress || !validateStellarDestinationAddress(uptoExtra.facilitatorAddress)) {
      throw new Error(`Invalid or missing extra.facilitatorAddress: ${uptoExtra.facilitatorAddress}`);
    }
    if (typeof uptoExtra.feeBps !== "number" || uptoExtra.feeBps < 0) {
      throw new Error(`Invalid extra.feeBps: ${uptoExtra.feeBps}`);
    }
    if (typeof uptoExtra.feeFixed !== "string" || !/^\d+$/.test(uptoExtra.feeFixed)) {
      throw new Error(`Invalid extra.feeFixed: ${uptoExtra.feeFixed}`);
    }
    if (
      typeof uptoExtra.feeMode !== "number" ||
      ![0, 1, 2, 3].includes(uptoExtra.feeMode)
    ) {
      throw new Error(`Invalid extra.feeMode: ${uptoExtra.feeMode}`);
    }
  }
}

/**
 * Generates a request-scoped u64 nonce by combining the current timestamp
 * (high bits) with random bits (low bits), so collisions across concurrent
 * requests from the same payer are practically impossible.
 *
 * @returns A random u64 (as bigint) suitable for `request_nonce`
 */
function generateRequestNonce(): bigint {
  const timeMs = BigInt(Date.now());
  const rand = BigInt(Math.floor(Math.random() * 0x100000000));
  return ((timeMs << 32n) | rand) & 0xffffffffffffffffn;
}
