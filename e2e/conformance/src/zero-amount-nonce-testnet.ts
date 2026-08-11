/**
 * Live testnet regression for the zero-amount settlement fix.
 *
 * Before the fix, `UptoStellarScheme.settle()` short-circuited a
 * `settleAmount === 0n` settlement off-chain, returning `success: true`
 * without ever submitting a transaction. The deployed contract's own
 * zero-settlement path (`contracts/upto-settlement/src/lib.rs`) writes the
 * nonce to storage BEFORE checking `actual_amount == 0`, so a real on-chain
 * zero-settlement is just as final as a nonzero one. The off-chain shortcut
 * broke that: the witness stayed usable, so the same nonce could later be
 * settled for real money.
 *
 * This script proves the fix: settle a witness for `actualAmount = 0`
 * (expecting a real transaction hash, not an empty one), then attempt to
 * settle the exact same witness/nonce again for a nonzero amount and confirm
 * it is now rejected on-chain (`NonceAlreadyUsed`), because the zero
 * settlement already burned it.
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

async function main(): Promise<void> {
  const buyerSigner: ClientStellarSigner = createEd25519Signer(BUYER_SECRET, STELLAR_TESTNET_CAIP2);
  const facilitatorSigner: FacilitatorStellarSigner = createEd25519Signer(
    FACILITATOR_SECRET,
    STELLAR_TESTNET_CAIP2,
  );

  const maxAmount = "10000000"; // 1.0 ZTUSD ceiling, never actually charged

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
      feeBps: 0,
      areFeesSponsored: true,
    },
  };

  console.log("1. Client signs one witness (maxAmount = 1.0 ZTUSD)...");
  const client = new UptoStellarClient(buyerSigner, { rpcConfig: { url: RPC_URL } });
  const paymentResult = await client.createPaymentPayload(2, requirements);

  const paymentPayload: PaymentPayload = {
    x402Version: 2,
    resource: { url: "https://example.com/zero-amount-nonce-check" },
    accepted: requirements,
    payload: paymentResult.payload,
  };

  const facilitator = new UptoStellarFacilitator(
    [facilitatorSigner],
    { [STELLAR_TESTNET_CAIP2]: SETTLEMENT_CONTRACT },
    { rpcConfig: { url: RPC_URL } },
  );

  console.log("2. Facilitator /settle for actualAmount = 0 (should submit a real on-chain tx)...");
  const zeroRequirements: PaymentRequirements = { ...requirements, amount: "0" };
  const zeroResult = await facilitator.settle(paymentPayload, zeroRequirements);
  console.log("   settle(0) result:", zeroResult);
  if (!zeroResult.success) {
    throw new Error(`settle(0) unexpectedly failed: ${zeroResult.errorReason}`);
  }
  if (!zeroResult.transaction) {
    throw new Error(
      "REGRESSION: settle(0) returned success with no transaction hash — the off-chain " +
        "short-circuit is back, the nonce was never burned on-chain.",
    );
  }
  console.log(`   ✓ real transaction submitted: https://stellar.expert/explorer/testnet/tx/${zeroResult.transaction}`);

  console.log("3. Attempting to settle the SAME witness/nonce again for a nonzero amount...");
  const nonzeroRequirements: PaymentRequirements = { ...requirements, amount: "1000000" };
  const replayResult = await facilitator.settle(paymentPayload, nonzeroRequirements);
  console.log("   settle(1000000) result:", replayResult);

  if (replayResult.success) {
    throw new Error(
      "REGRESSION: a witness already settled for zero was settled AGAIN for a nonzero amount " +
        "— the nonce was not burned on-chain by the zero settlement.",
    );
  }

  console.log("\n✅ REGRESSION PASS: zero-amount settlement submitted a real transaction and");
  console.log("   permanently burned the nonce — a later nonzero settlement of the same witness");
  console.log(`   correctly fails on-chain (${replayResult.errorReason}).`);
}

main().catch(err => {
  console.error("\n❌ REGRESSION FAIL:", err);
  process.exit(1);
});
