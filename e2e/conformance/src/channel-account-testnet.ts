/**
 * Live testnet conformance check for channel-account settlement submission
 * (see "Sequence-number bottlenecks" in docs/architecture.md).
 *
 * Proves, against the real deployed contract, that a settlement transaction
 * can be submitted with the channel account as the transaction's source
 * account (paying the fee, consuming its own sequence number) while
 * `commitment.facilitator` remains the *operation's* source — the address
 * the contract's `facilitator.require_auth()` actually checks — by
 * asserting, from real Horizon account data before/after:
 *   1. The channel account's sequence number advances by exactly 1.
 *   2. The facilitator signer's sequence number does NOT change at all
 *      (proof it was never the transaction's source account).
 *   3. The settlement still succeeds and moves funds correctly, identical
 *      to a non-channel-account settlement.
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
const CHANNEL_ACCOUNT_SECRET = env("CHANNEL_ACCOUNT_SECRET");
const SELLER_ADDRESS = env("SELLER_ADDRESS");
const RPC_URL = process.env.RPC_URL ?? "https://soroban-testnet.stellar.org";
const HORIZON_URL = "https://horizon-testnet.stellar.org";
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

async function sequenceOf(address: string): Promise<string> {
  const res = await fetch(`${HORIZON_URL}/accounts/${address}`);
  const data = (await res.json()) as { sequence: string };
  return data.sequence;
}

async function main(): Promise<void> {
  const buyerSigner: ClientStellarSigner = createEd25519Signer(BUYER_SECRET, STELLAR_TESTNET_CAIP2);
  const facilitatorSigner: FacilitatorStellarSigner = createEd25519Signer(
    FACILITATOR_SECRET,
    STELLAR_TESTNET_CAIP2,
  );
  const channelSigner: FacilitatorStellarSigner = createEd25519Signer(
    CHANNEL_ACCOUNT_SECRET,
    STELLAR_TESTNET_CAIP2,
  );

  console.log(`Facilitator address: ${facilitatorSigner.address}`);
  console.log(`Channel account address: ${channelSigner.address}`);

  const feeBps = 0; // standard upto — isolates the channel-account mechanism from the fee-split path already proven elsewhere
  const maxAmount = "1000000"; // 0.1 TUSD
  const actualAmount = "300000"; // 0.03 TUSD metered usage

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

  console.log("1. Client signs the witness authorization (maxAmount = 0.1 TUSD)...");
  const client = new UptoStellarClient(buyerSigner, { rpcConfig: { url: RPC_URL } });
  const paymentResult = await client.createPaymentPayload(2, requirements);

  const paymentPayload: PaymentPayload = {
    x402Version: 2,
    resource: { url: "https://example.com/channel-account-conformance-check" },
    accepted: requirements,
    payload: paymentResult.payload,
  };

  const facilitator = new UptoStellarFacilitator(
    [facilitatorSigner],
    { [STELLAR_TESTNET_CAIP2]: SETTLEMENT_CONTRACT },
    { rpcConfig: { url: RPC_URL }, channelAccounts: [channelSigner] },
  );

  console.log("2. Facilitator /verify...");
  const verifyResult = await facilitator.verify(paymentPayload, requirements);
  if (!verifyResult.isValid) {
    throw new Error(`verify failed: ${verifyResult.invalidReason} ${verifyResult.invalidMessage ?? ""}`);
  }
  console.log("   verify OK");

  const sellerBalanceBefore = await balanceOf(SELLER_ADDRESS);
  const channelSeqBefore = await sequenceOf(channelSigner.address);
  const facilitatorSeqBefore = await sequenceOf(facilitatorSigner.address);
  console.log(`   channel account sequence before: ${channelSeqBefore}`);
  console.log(`   facilitator sequence before:     ${facilitatorSeqBefore}`);

  console.log("3. Facilitator /settle, with a channel account configured...");
  const settleRequirements: PaymentRequirements = { ...requirements, amount: actualAmount };
  const settleResult = await facilitator.settle(paymentPayload, settleRequirements);
  console.log("   settle result:", settleResult);
  if (!settleResult.success) {
    throw new Error(`settle failed: ${settleResult.errorReason}`);
  }

  const sellerBalanceAfter = await balanceOf(SELLER_ADDRESS);
  const channelSeqAfter = await sequenceOf(channelSigner.address);
  const facilitatorSeqAfter = await sequenceOf(facilitatorSigner.address);

  console.log(`4. channel account sequence after: ${channelSeqAfter}`);
  console.log(`   facilitator sequence after:      ${facilitatorSeqAfter}`);

  const channelSeqDelta = BigInt(channelSeqAfter) - BigInt(channelSeqBefore);
  const facilitatorSeqDelta = BigInt(facilitatorSeqAfter) - BigInt(facilitatorSeqBefore);
  const sellerDelta = sellerBalanceAfter - sellerBalanceBefore;

  console.log(`5. channel account sequence delta: ${channelSeqDelta} (expect 1)`);
  console.log(`   facilitator sequence delta:      ${facilitatorSeqDelta} (expect 0 — never the tx source)`);
  console.log(`   seller TUSD delta: +${sellerDelta} (expect +${actualAmount})`);

  if (channelSeqDelta !== 1n) {
    throw new Error(`Expected channel account sequence to advance by exactly 1, got ${channelSeqDelta}`);
  }
  if (facilitatorSeqDelta !== 0n) {
    throw new Error(
      `Expected facilitator sequence to be untouched (channel account should be the tx source), got delta ${facilitatorSeqDelta}`,
    );
  }
  if (sellerDelta !== BigInt(actualAmount)) {
    throw new Error(`Seller balance delta mismatch: expected +${actualAmount}, got +${sellerDelta}`);
  }

  console.log("\n✅ CONFORMANCE PASS: settlement submitted with a channel account as the transaction's");
  console.log("   source account (its sequence number advanced), while facilitator.require_auth() was");
  console.log("   still satisfied by the facilitator signer's own signature on the operation — proven by");
  console.log("   the facilitator's own sequence number staying completely untouched — and the settlement");
  console.log("   itself moved funds correctly.");
  console.log(`   Settlement tx: https://stellar.expert/explorer/testnet/tx/${settleResult.transaction}`);
}

main().catch(err => {
  console.error("\n❌ CONFORMANCE FAIL:", err);
  process.exit(1);
});
