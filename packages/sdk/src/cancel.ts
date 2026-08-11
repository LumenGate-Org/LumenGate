import { contract, nativeToScVal } from "@stellar/stellar-sdk";
import {
  getNetworkPassphrase,
  getRpcUrl,
  STELLAR_TESTNET_CAIP2,
  type FacilitatorStellarSigner,
  type RpcConfig,
} from "@x402/stellar";
import type { Network } from "@x402/core/types";

export interface CancelUptoPaymentParams {
  /** The payer who signed the witness being cancelled. Must be able to sign a full transaction. */
  signer: FacilitatorStellarSigner;
  /** The `x402UptoStellarSettlement` contract address the witness targeted. */
  settlementContract: string;
  /** The `requestNonce` of the specific witness to invalidate. */
  requestNonce: bigint;
  network?: Network;
  rpcConfig?: RpcConfig;
}

export interface CancelUptoPaymentResult {
  transaction: string;
}

/**
 * Invalidates one specific, not-yet-settled `upto` witness on-chain, without
 * affecting the payer's SEP-41 allowance or any other outstanding witness
 * signed against it. Requires only the payer's own signature — the
 * facilitator is not involved (see `cancel` in
 * `contracts/upto-settlement/src/lib.rs` for the full rationale).
 *
 * Revoking the entire allowance (a plain SEP-41 `approve(spender, 0, ...)`)
 * is a coarser but always-available alternative that blocks every future
 * settlement under it, not just one; use this instead when only a single
 * request needs to be killed.
 *
 * @param params - See `CancelUptoPaymentParams`
 * @returns The cancellation transaction hash
 */
export async function cancelUptoPayment(
  params: CancelUptoPaymentParams,
): Promise<CancelUptoPaymentResult> {
  const network = params.network ?? STELLAR_TESTNET_CAIP2;
  const networkPassphrase = getNetworkPassphrase(network);
  const rpcUrl = getRpcUrl(network, params.rpcConfig);
  const from = params.signer.address;

  const tx = await contract.AssembledTransaction.build({
    contractId: params.settlementContract,
    method: "cancel",
    args: [nativeToScVal(from, { type: "address" }), nativeToScVal(params.requestNonce, { type: "u64" })],
    networkPassphrase,
    rpcUrl,
    publicKey: from,
    parseResultXdr: () => undefined,
  });

  const sent = await tx.signAndSend({ signTransaction: params.signer.signTransaction });
  const transaction = sent.sendTransactionResponse?.hash;
  if (!transaction) {
    throw new Error("upto: cancel transaction did not return a hash");
  }
  return { transaction };
}
