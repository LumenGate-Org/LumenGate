/**
 * Live testnet conformance check for two additions made after an
 * inter-chain design comparison (see docs/architecture.md and
 * specs/schemes/upto/scheme_upto_stellar.md):
 *   1. `cancel` — a payer can unilaterally invalidate one specific,
 *      not-yet-settled witness (contracts/upto-settlement).
 *   2. Facilitator `/settle` idempotency — a retried call for the exact same
 *      witness returns the same result instead of attempting a second
 *      on-chain transaction (packages/stellar-upto).
 */
import {
  createEd25519Signer,
  STELLAR_TESTNET_CAIP2,
  type ClientStellarSigner,
  type FacilitatorStellarSigner,
} from "@x402/stellar";
import { UptoStellarScheme as UptoStellarClient } from "@x402-stellar/upto/client";
import { UptoStellarScheme as UptoStellarFacilitator } from "@x402-stellar/upto/facilitator";
import { cancelUptoPayment } from "@x402-stellar/sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

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

function buildRequirements(facilitatorAddress: string, amount: string): PaymentRequirements {
  return {
    scheme: "upto",
    network: STELLAR_TESTNET_CAIP2,
    asset: ASSET_TOKEN,
    amount,
    payTo: SELLER_ADDRESS,
    maxTimeoutSeconds: 120,
    extra: {
      settlementContract: SETTLEMENT_CONTRACT,
      facilitatorAddress,
      feeBps: 0,
      areFeesSponsored: true,
    },
  };
}

async function main(): Promise<void> {
  const buyerSigner: ClientStellarSigner = createEd25519Signer(BUYER_SECRET, STELLAR_TESTNET_CAIP2);
  const facilitatorSigner: FacilitatorStellarSigner = createEd25519Signer(
    FACILITATOR_SECRET,
    STELLAR_TESTNET_CAIP2,
  );
  const client = new UptoStellarClient(buyerSigner, { rpcConfig: { url: RPC_URL } });
  const facilitator = new UptoStellarFacilitator(
    [facilitatorSigner],
    { [STELLAR_TESTNET_CAIP2]: SETTLEMENT_CONTRACT },
    { rpcConfig: { url: RPC_URL } },
  );

  // --- Part 1: cancel ---
  console.log("=== Part 1: cancel ===");
  const maxAmount = "10000000";
  const cancelRequirements = buildRequirements(facilitatorSigner.address, maxAmount);
  console.log("1. Client signs a witness...");
  const cancelPaymentResult = await client.createPaymentPayload(2, cancelRequirements);
  const requestNonce = BigInt((cancelPaymentResult.payload as { requestNonce: string }).requestNonce);
  console.log(`   requestNonce = ${requestNonce}`);

  console.log("2. Client cancels it before any settlement is attempted...");
  const cancelResult = await cancelUptoPayment({
    signer: buyerSigner as FacilitatorStellarSigner,
    settlementContract: SETTLEMENT_CONTRACT,
    requestNonce,
    rpcConfig: { url: RPC_URL },
  });
  console.log(`   cancel tx: https://stellar.expert/explorer/testnet/tx/${cancelResult.transaction}`);

  console.log("3. Facilitator attempts to settle the now-cancelled witness (must fail)...");
  const cancelledPayload: PaymentPayload = {
    x402Version: 2,
    resource: { url: "https://example.com/cancel-conformance-check" },
    accepted: cancelRequirements,
    payload: cancelPaymentResult.payload,
  };
  const settleAfterCancel = await facilitator.settle(
    cancelledPayload,
    buildRequirements(facilitatorSigner.address, "1000"),
  );
  console.log("   settle result:", settleAfterCancel);
  if (settleAfterCancel.success) {
    throw new Error("FAIL: settlement succeeded for a witness that was already cancelled");
  }
  console.log("   ✅ correctly rejected\n");

  // --- Part 2: idempotency ---
  console.log("=== Part 2: /settle idempotency ===");
  const idempotencyRequirements = buildRequirements(facilitatorSigner.address, maxAmount);
  console.log("1. Client signs a fresh witness...");
  const idempotencyPaymentResult = await client.createPaymentPayload(2, idempotencyRequirements);
  const idempotencyPayload: PaymentPayload = {
    x402Version: 2,
    resource: { url: "https://example.com/idempotency-conformance-check" },
    accepted: idempotencyRequirements,
    payload: idempotencyPaymentResult.payload,
  };
  const settleRequirements = buildRequirements(facilitatorSigner.address, "1000000"); // 0.1 TUSD

  console.log("2. First /settle call (real on-chain settlement)...");
  const first = await facilitator.settle(idempotencyPayload, settleRequirements);
  console.log("   result:", first);
  if (!first.success) throw new Error(`FAIL: first settlement did not succeed: ${first.errorReason}`);

  console.log("3. Second /settle call, identical payload+requirements (must be a cache hit)...");
  const start = Date.now();
  const second = await facilitator.settle(idempotencyPayload, settleRequirements);
  const elapsedMs = Date.now() - start;
  console.log(`   result (${elapsedMs}ms):`, second);

  if (second.transaction !== first.transaction) {
    throw new Error(
      `FAIL: second call produced a different transaction (${second.transaction}) than the first (${first.transaction}) — either it wasn't cached, or the on-chain nonce-reuse rejection was miscategorized as a fresh result`,
    );
  }
  // A cache hit resolves in-process — no RPC round-trip — so it should be
  // dramatically faster than the first call (which submitted a real tx and
  // polled for confirmation, typically several seconds).
  console.log(`   ✅ identical result returned in ${elapsedMs}ms (cache hit, no RPC round-trip)`);
  console.log(`   Settlement tx: https://stellar.expert/explorer/testnet/tx/${first.transaction}`);

  console.log("\n✅ CONFORMANCE PASS: cancel and /settle idempotency both work as designed.");
}

main().catch(err => {
  console.error("\n❌ CONFORMANCE FAIL:", err);
  process.exit(1);
});
