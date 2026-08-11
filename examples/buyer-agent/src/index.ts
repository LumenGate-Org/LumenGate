import "dotenv/config";
import { createEd25519Signer, STELLAR_TESTNET_CAIP2 } from "@x402/stellar";
import { x402HTTPClient } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createStellarPaymentClient } from "@x402-stellar/sdk";

const BUYER_SECRET = requireEnv("BUYER_SECRET");
const BASE_URL = process.env.RESOURCE_SERVER_URL ?? "http://localhost:4022";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

async function main(): Promise<void> {
  const signer = createEd25519Signer(BUYER_SECRET, STELLAR_TESTNET_CAIP2);
  console.log(`Agent address: ${signer.address}`);

  const client = createStellarPaymentClient(signer);
  const httpClient = new x402HTTPClient(client);
  const fetchWithPayment = wrapFetchWithPayment(fetch, httpClient);

  console.log("\n=== 1. Weather lookup (exact scheme) ===");
  const weatherResponse = await fetchWithPayment(`${BASE_URL}/weather/san-francisco`);
  const weatherResult = await httpClient.processResponse(weatherResponse);
  console.dir(weatherResult, { depth: null });

  console.log("\n=== 2. Metered LLM call (managed upto scheme) ===");
  // No allowance step needed here: the facilitator's default upto contract
  // (x402UptoStellarEscrowSettlement, escrow-and-refund) pulls directly from
  // the buyer's balance at settlement time — there's nothing to pre-approve.
  // `@x402-stellar/sdk`'s `ensureUptoAllowance`/`cancelUptoPayment` remain
  // available for a facilitator specifically configured for the alternative
  // allowance-based design (`UPTO_DESIGN=allowance`) — see "Integrating as a
  // buyer/agent" in docs/developer-guide.md.
  const llmResponse = await fetchWithPayment(`${BASE_URL}/llm/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "Write a haiku about the ocean" }),
  });
  const llmResult = await httpClient.processResponse(llmResponse);
  console.dir(llmResult, { depth: null });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
