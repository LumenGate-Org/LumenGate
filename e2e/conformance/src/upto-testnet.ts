/**
 * Live testnet conformance check for the `upto` scheme on Stellar.
 *
 * This is the authoritative validation of the design's core hypothesis (see
 * `contracts/upto-settlement/src/lib.rs` module docs and
 * `packages/stellar-upto/src/witness.ts`): that a client-signed witness
 * authorization — built by simulating `settle(..., actualAmount = maxAmount)`
 * — remains valid when the facilitator later submits a REAL on-chain
 * `settle(..., actualAmount = <metered amount>)` call with a different
 * `actualAmount`, against the deployed contract (not a mock).
 *
 * Prerequisites (see README in this directory): a deployed
 * `x402UptoStellarSettlement` contract, a SEP-41 test token, a buyer with a
 * sufficient allowance to the settlement contract, and funded testnet
 * accounts for buyer/facilitator/seller.
 */
import {
  createEd25519Signer,
  STELLAR_TESTNET_CAIP2,
  type ClientStellarSigner,
  type FacilitatorStellarSigner,
} from "@x402/stellar";
import { UptoStellarScheme as UptoStellarClient } from "@x402-stellar/upto/client";
import { UptoStellarScheme as UptoStellarFacilitator } from "@x402-stellar/upto/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { contract, nativeToScVal, scValToNative } from "@stellar/stellar-sdk";

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
};

const SETTLEMENT_CONTRACT = env("SETTLEMENT_CONTRACT");
const ASSET_TOKEN = env("ASSET_TOKEN");
const BUYER_SECRET = env("BUYER_SECRET");
const FACILITATOR_SECRET = env("FACILITATOR_SECRET");
const SELLER_ADDRESS = env("SELLER_ADDRESS");
const RPC_URL = process.env.RPC_URL ?? "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

async function balanceOf(address: string): Promise<bigint> {
  const tx = await contract.AssembledTransaction.build({
    contractId: ASSET_TOKEN,
    method: "balance",
    args: [nativeToScVal(address, { type: "address" })],
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: RPC_URL,
    publicKey: address,
    parseResultXdr: scValToNative,
  });
  if (!tx.simulation || !("result" in tx.simulation) || !tx.simulation.result) {
    throw new Error(`balance simulation failed for ${address}`);
  }
  return scValToNative(tx.simulation.result.retval) as bigint;
}

async function main(): Promise<void> {
  const buyerSigner: ClientStellarSigner = createEd25519Signer(BUYER_SECRET, STELLAR_TESTNET_CAIP2);
  const facilitatorSigner: FacilitatorStellarSigner = createEd25519Signer(
    FACILITATOR_SECRET,
    STELLAR_TESTNET_CAIP2,
  );

  const feeBps = 500; // 5% — exercises the "managed upto" atomic on-chain fee split
  const maxAmount = "10000000"; // 1.0 TUSD (7 decimals)
  const actualAmount = "4000000"; // 0.4 TUSD metered usage

  const requirements: PaymentRequirements = {
    scheme: "upto",
    network: STELLAR_TESTNET_CAIP2,
    asset: ASSET_TOKEN,
    amount: maxAmount,
    payTo: SELLER_ADDRESS,
    maxTimeoutSeconds: 120,
    extra: {
      settlementContract: SETTLEMENT_CONTRACT,
      facilitatorAddress: facilitatorSigner.address,
      feeBps,
      areFeesSponsored: true,
    },
  };

  console.log("1. Client signs the witness authorization (maxAmount = 1.0 TUSD)...");
  const client = new UptoStellarClient(buyerSigner, { rpcConfig: { url: RPC_URL } });
  const paymentResult = await client.createPaymentPayload(2, requirements);
  console.log(`   signed authEntry (${(paymentResult.payload as { authEntry: string }).authEntry.length} bytes b64)`);

  const paymentPayload: PaymentPayload = {
    x402Version: 2,
    resource: { url: "https://example.com/upto-conformance-check" },
    accepted: requirements,
    payload: paymentResult.payload,
  };

  const facilitator = new UptoStellarFacilitator([facilitatorSigner], {
    [STELLAR_TESTNET_CAIP2]: SETTLEMENT_CONTRACT,
  }, { rpcConfig: { url: RPC_URL } });

  console.log("2. Facilitator /verify (requirements.amount = max, as at request time)...");
  const verifyResult = await facilitator.verify(paymentPayload, requirements);
  console.log("   verify result:", verifyResult);
  if (!verifyResult.isValid) {
    throw new Error(`verify failed: ${verifyResult.invalidReason} ${verifyResult.invalidMessage ?? ""}`);
  }

  const sellerBalanceBefore = await balanceOf(SELLER_ADDRESS);
  const facilitatorBalanceBefore = await balanceOf(facilitatorSigner.address);

  console.log("3. Facilitator /settle (requirements.amount = 0.4 TUSD, metered actual)...");
  const settleRequirements: PaymentRequirements = { ...requirements, amount: actualAmount };
  const settleResult = await facilitator.settle(paymentPayload, settleRequirements);
  console.log("   settle result:", settleResult);
  if (!settleResult.success) {
    throw new Error(`settle failed: ${settleResult.errorReason}`);
  }

  const sellerBalanceAfter = await balanceOf(SELLER_ADDRESS);
  const facilitatorBalanceAfter = await balanceOf(facilitatorSigner.address);

  const sellerDelta = sellerBalanceAfter - sellerBalanceBefore;
  const facilitatorDelta = facilitatorBalanceAfter - facilitatorBalanceBefore;
  const expectedFee = (BigInt(actualAmount) * BigInt(feeBps)) / 10_000n;
  const expectedSeller = BigInt(actualAmount) - expectedFee;

  console.log(`4. On-chain balance deltas: seller +${sellerDelta}, facilitator +${facilitatorDelta}`);
  console.log(`   expected:                seller +${expectedSeller}, facilitator +${expectedFee}`);

  if (sellerDelta !== expectedSeller || facilitatorDelta !== expectedFee) {
    throw new Error("Balance deltas did not match the expected atomic fee split");
  }

  console.log("\n✅ CONFORMANCE PASS: witness signed for maxAmount settled at a different actualAmount,");
  console.log("   with the managed-upto fee split executed atomically on-chain, in a single transaction.");
  console.log(`   Settlement tx: https://stellar.expert/explorer/testnet/tx/${settleResult.transaction}`);
}

main().catch(err => {
  console.error("\n❌ CONFORMANCE FAIL:", err);
  process.exit(1);
});
