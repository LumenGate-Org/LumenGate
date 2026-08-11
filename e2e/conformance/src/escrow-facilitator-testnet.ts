/**
 * Live testnet conformance check for `UptoStellarEscrowScheme` — the actual
 * TypeScript facilitator class (`packages/stellar-upto/src/facilitator/
 * scheme-escrow.ts`) now wired as the default `upto`/`managed upto`
 * implementation in `packages/facilitator` (Design B, escrow-and-refund).
 *
 * Deliberately mirrors `upto-testnet.ts` (Design A's equivalent check) as
 * closely as possible — same structure, same client class
 * (`UptoStellarScheme` from `@x402-stellar/upto/client`, unmodified, since
 * it's already contract-agnostic: it simulates whatever contract
 * `extra.settlementContract` names), same managed-upto fee-split assertion
 * — the one difference is which facilitator class drives verify/settle, and
 * that this run needs no prior `approve()` step at all, since Design B has
 * no allowance to approve.
 *
 * This is the proof that matters for making Design B the *default*: the
 * earlier `escrow-design-b-testnet.ts` proved the raw contract and its
 * security fix work live; this proves the actual TS integration a
 * facilitator operator runs (`UptoStellarEscrowScheme.verify()`/`.settle()`,
 * including its balance pre-flight, idempotency cache, and channel-account
 * support) talks to that same deployed contract correctly, end to end.
 */
import {
  createEd25519Signer,
  STELLAR_TESTNET_CAIP2,
  type ClientStellarSigner,
  type FacilitatorStellarSigner,
} from "@x402/stellar";
import { UptoStellarScheme as UptoStellarClient } from "@x402-stellar/upto/client";
import { UptoStellarEscrowScheme as UptoStellarEscrowFacilitator } from "@x402-stellar/upto/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { contract, nativeToScVal, scValToNative } from "@stellar/stellar-sdk";

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
};

const ESCROW_CONTRACT = env("ESCROW_CONTRACT");
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

/**
 * Re-polls `balanceOf` until it differs from `staleValue` or `maxAttempts` is
 * exhausted. Guards against the public testnet RPC's read path occasionally
 * serving a `simulateTransaction` balance read from a ledger snapshot that
 * hasn't caught up to a transaction that just landed (confirmed via
 * `getTransaction` returning SUCCESS) — a read-after-write staleness window
 * observed directly while building this script: the settlement's own
 * `getTransaction` poll reported SUCCESS, and seller/facilitator balance
 * reads immediately reflected the new state, but the buyer's `balance` read
 * briefly still echoed the pre-settlement value on the same RPC endpoint.
 */
async function balanceOfFresh(address: string, staleValue: bigint, maxAttempts = 10): Promise<bigint> {
  for (let i = 0; i < maxAttempts; i++) {
    const value = await balanceOf(address);
    if (value !== staleValue) return value;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  return balanceOf(address);
}

async function main(): Promise<void> {
  const buyerSigner: ClientStellarSigner = createEd25519Signer(BUYER_SECRET, STELLAR_TESTNET_CAIP2);
  const facilitatorSigner: FacilitatorStellarSigner = createEd25519Signer(
    FACILITATOR_SECRET,
    STELLAR_TESTNET_CAIP2,
  );

  const feeBps = 500; // 5% — exercises the "managed upto" atomic on-chain fee split
  const maxAmount = "500000"; // 0.05 TUSD (7 decimals)
  const actualAmount = "200000"; // 0.02 TUSD metered usage — leaves a real refund

  const requirements: PaymentRequirements = {
    scheme: "upto",
    network: STELLAR_TESTNET_CAIP2,
    asset: ASSET_TOKEN,
    amount: maxAmount,
    payTo: SELLER_ADDRESS,
    maxTimeoutSeconds: 120,
    extra: {
      settlementContract: ESCROW_CONTRACT,
      facilitatorAddress: facilitatorSigner.address,
      feeBps,
      areFeesSponsored: true,
    },
  };

  console.log("0. No approve() step — Design B needs none. Buyer only needs a sufficient balance.");
  console.log("1. Client (UptoStellarScheme, unmodified) signs the witness (maxAmount = 0.05 TUSD)...");
  const client = new UptoStellarClient(buyerSigner, { rpcConfig: { url: RPC_URL } });
  const paymentResult = await client.createPaymentPayload(2, requirements);
  console.log(
    `   signed authEntry (${(paymentResult.payload as { authEntry: string }).authEntry.length} bytes b64), ` +
      "simulated directly against the deployed escrow contract, zero hand-built XDR.",
  );

  const paymentPayload: PaymentPayload = {
    x402Version: 2,
    resource: { url: "https://example.com/upto-escrow-conformance-check" },
    accepted: requirements,
    payload: paymentResult.payload,
  };

  const facilitator = new UptoStellarEscrowFacilitator(
    [facilitatorSigner],
    { [STELLAR_TESTNET_CAIP2]: ESCROW_CONTRACT },
    { rpcConfig: { url: RPC_URL } },
  );

  console.log("2. UptoStellarEscrowScheme.verify() — including the balance pre-flight (no allowance check)...");
  const verifyResult = await facilitator.verify(paymentPayload, requirements);
  console.log("   verify result:", verifyResult);
  if (!verifyResult.isValid) {
    throw new Error(`verify failed: ${verifyResult.invalidReason} ${verifyResult.invalidMessage ?? ""}`);
  }

  const buyerBalanceBefore = await balanceOf(buyerSigner.address);
  const sellerBalanceBefore = await balanceOf(SELLER_ADDRESS);
  const facilitatorBalanceBefore = await balanceOf(facilitatorSigner.address);

  console.log("3. UptoStellarEscrowScheme.settle() (requirements.amount = 0.02 TUSD, metered actual)...");
  const settleRequirements: PaymentRequirements = { ...requirements, amount: actualAmount };
  const settleResult = await facilitator.settle(paymentPayload, settleRequirements);
  console.log("   settle result:", settleResult);
  if (!settleResult.success) {
    throw new Error(`settle failed: ${settleResult.errorReason}`);
  }

  const buyerBalanceAfter = await balanceOfFresh(buyerSigner.address, buyerBalanceBefore);
  const sellerBalanceAfter = await balanceOfFresh(SELLER_ADDRESS, sellerBalanceBefore);
  const facilitatorBalanceAfter = await balanceOfFresh(facilitatorSigner.address, facilitatorBalanceBefore);

  const buyerDelta = buyerBalanceBefore - buyerBalanceAfter; // net paid = actual (escrowed max, refunded the rest)
  const sellerDelta = sellerBalanceAfter - sellerBalanceBefore;
  const facilitatorDelta = facilitatorBalanceAfter - facilitatorBalanceBefore;
  const expectedFee = (BigInt(actualAmount) * BigInt(feeBps)) / 10_000n;
  const expectedSeller = BigInt(actualAmount) - expectedFee;

  console.log(
    `4. On-chain balance deltas: buyer net -${buyerDelta}, seller +${sellerDelta}, facilitator +${facilitatorDelta}`,
  );
  console.log(
    `   expected:                buyer net -${actualAmount}, seller +${expectedSeller}, facilitator +${expectedFee}`,
  );

  if (
    buyerDelta !== BigInt(actualAmount) ||
    sellerDelta !== expectedSeller ||
    facilitatorDelta !== expectedFee
  ) {
    throw new Error("Balance deltas did not match the expected escrow-pull + atomic fee split + refund");
  }

  console.log(
    "\n✅ CONFORMANCE PASS: UptoStellarEscrowScheme (the actual TS class wired as the default `upto`",
  );
  console.log("   /managed-upto implementation) verified and settled live against the deployed escrow");
  console.log("   contract, with no approve() prerequisite, the managed-upto fee split executed atomically,");
  console.log("   and the buyer's unused ceiling correctly refunded in the same transaction.");
  console.log(`   Settlement tx: https://stellar.expert/explorer/testnet/tx/${settleResult.transaction}`);
}

main().catch(err => {
  console.error("\n❌ CONFORMANCE FAIL:", err);
  process.exit(1);
});
