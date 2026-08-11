import { contract, nativeToScVal, scValToNative } from "@stellar/stellar-sdk";
import {
  getNetworkPassphrase,
  getRpcClient,
  getRpcUrl,
  STELLAR_TESTNET_CAIP2,
  type FacilitatorStellarSigner,
  type RpcConfig,
} from "@x402/stellar";
import type { Network } from "@x402/core/types";

const DAY_IN_LEDGERS = 17_280;
const DEFAULT_APPROVAL_LIFETIME_LEDGERS = DAY_IN_LEDGERS * 30;

export interface EnsureUptoAllowanceParams {
  /** The token owner. Must be able to sign a full transaction, not just auth entries. */
  signer: FacilitatorStellarSigner;
  /** SEP-41 token contract address. */
  token: string;
  /** The `x402UptoStellarSettlement` contract address (the approve `spender`). */
  spender: string;
  /** The allowance must be at least this much for the caller's next `upto` request(s). */
  minAllowance: bigint;
  /**
   * How much to approve if a top-up is needed. Defaults to `10 * minAllowance`
   * so a single approval amortizes across several future requests, rather
   * than requiring a fresh on-chain approval before every payment (the whole
   * point of treating this as a session-level prerequisite — see
   * `specs/schemes/upto/scheme_upto_stellar.md`, "One-Time Allowance").
   */
  approveAmount?: bigint;
  network?: Network;
  rpcConfig?: RpcConfig;
  /** How many ledgers the new approval should remain valid for. */
  liveForLedgers?: number;
}

export interface EnsureUptoAllowanceResult {
  /** Whether a new `approve` transaction was submitted. */
  approved: boolean;
  /** The resulting allowance (existing, if no top-up was needed). */
  allowance: bigint;
  /** The approval transaction hash, if one was submitted. */
  transaction?: string;
}

/**
 * Ensures `spender` (the settlement contract) holds a sufficient SEP-41
 * allowance from `signer` to cover an upcoming `upto` request, topping it up
 * with a real on-chain `approve` transaction if it's currently insufficient.
 *
 * This is the one-time/session-amortized prerequisite the `upto` scheme on
 * Stellar requires (see `specs/schemes/upto/scheme_upto_stellar.md`) —
 * callers should invoke this occasionally (e.g. once per session, or when a
 * `verify` call fails with `invalid_upto_stellar_insufficient_allowance`),
 * not before every single payment.
 *
 * @param params - See `EnsureUptoAllowanceParams`
 * @returns Whether a top-up happened and the resulting allowance
 */
export async function ensureUptoAllowance(
  params: EnsureUptoAllowanceParams,
): Promise<EnsureUptoAllowanceResult> {
  const network = params.network ?? STELLAR_TESTNET_CAIP2;
  const networkPassphrase = getNetworkPassphrase(network);
  const rpcUrl = getRpcUrl(network, params.rpcConfig);
  const server = getRpcClient(network, params.rpcConfig);
  const from = params.signer.address;

  const current = await readAllowance(rpcUrl, networkPassphrase, from, params.token, params.spender);
  if (current >= params.minAllowance) {
    return { approved: false, allowance: current };
  }

  const approveAmount = params.approveAmount ?? params.minAllowance * 10n;
  const latestLedger = await server.getLatestLedger();
  const liveUntilLedger =
    latestLedger.sequence + (params.liveForLedgers ?? DEFAULT_APPROVAL_LIFETIME_LEDGERS);

  const tx = await contract.AssembledTransaction.build({
    contractId: params.token,
    method: "approve",
    args: [
      nativeToScVal(from, { type: "address" }),
      nativeToScVal(params.spender, { type: "address" }),
      nativeToScVal(approveAmount, { type: "i128" }),
      nativeToScVal(liveUntilLedger, { type: "u32" }),
    ],
    networkPassphrase,
    rpcUrl,
    publicKey: from,
    parseResultXdr: () => undefined,
  });

  const sent = await tx.signAndSend({ signTransaction: params.signer.signTransaction });

  return {
    approved: true,
    allowance: approveAmount,
    transaction: sent.sendTransactionResponse?.hash,
  };
}

async function readAllowance(
  rpcUrl: string,
  networkPassphrase: string,
  from: string,
  token: string,
  spender: string,
): Promise<bigint> {
  const tx = await contract.AssembledTransaction.build({
    contractId: token,
    method: "allowance",
    args: [nativeToScVal(from, { type: "address" }), nativeToScVal(spender, { type: "address" })],
    networkPassphrase,
    rpcUrl,
    publicKey: from,
    parseResultXdr: scValToNative,
  });
  if (!tx.simulation || !("result" in tx.simulation) || !tx.simulation.result) {
    throw new Error(`upto: allowance read failed for ${from} -> ${spender}`);
  }
  return scValToNative(tx.simulation.result.retval) as bigint;
}
