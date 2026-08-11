/**
 * Live testnet conformance check for the (upstream, unmodified) `exact`
 * scheme, included so the conformance report covers all three billing tiers
 * end to end, not just the novel `upto` work.
 */
import {
  createEd25519Signer,
  STELLAR_TESTNET_CAIP2,
  type ClientStellarSigner,
  type FacilitatorStellarSigner,
} from "@x402/stellar";
import { ExactStellarScheme as ExactStellarClient } from "@x402/stellar/exact/client";
import { ExactStellarScheme as ExactStellarFacilitator } from "@x402/stellar/exact/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
};

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

  const requirements: PaymentRequirements = {
    scheme: "exact",
    network: STELLAR_TESTNET_CAIP2,
    asset: ASSET_TOKEN,
    amount: "1000000", // 0.1 TUSD
    payTo: SELLER_ADDRESS,
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true },
  };

  console.log("1. Client signs the exact-amount transfer...");
  const client = new ExactStellarClient(buyerSigner, { url: RPC_URL });
  const paymentResult = await client.createPaymentPayload(2, requirements);

  const paymentPayload: PaymentPayload = {
    x402Version: 2,
    resource: { url: "https://example.com/exact-conformance-check" },
    accepted: requirements,
    payload: paymentResult.payload,
  };

  const facilitator = new ExactStellarFacilitator([facilitatorSigner], { rpcConfig: { url: RPC_URL } });

  console.log("2. Facilitator /verify...");
  const verifyResult = await facilitator.verify(paymentPayload, requirements);
  console.log("   verify result:", verifyResult);
  if (!verifyResult.isValid) throw new Error(`verify failed: ${verifyResult.invalidReason}`);

  console.log("3. Facilitator /settle...");
  const settleResult = await facilitator.settle(paymentPayload, requirements);
  console.log("   settle result:", settleResult);
  if (!settleResult.success) throw new Error(`settle failed: ${settleResult.errorReason}`);

  console.log("\n✅ CONFORMANCE PASS: exact scheme settled on testnet.");
  console.log(`   Settlement tx: https://stellar.expert/explorer/testnet/tx/${settleResult.transaction}`);
}

main().catch(err => {
  console.error("\n❌ CONFORMANCE FAIL:", err);
  process.exit(1);
});
