import "dotenv/config";
import express from "express";
import { paymentMiddleware, setSettlementOverrides } from "@x402/express";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactStellarScheme as ExactStellarServerScheme } from "@x402/stellar/exact/server";
import { UptoStellarScheme as UptoStellarServerScheme } from "@x402-stellar/upto/server";
import { STELLAR_TESTNET_CAIP2 } from "@x402/stellar";
import { declareStellarResource } from "@x402-stellar/sdk";

const PORT = Number(process.env.PORT ?? 4022);
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "http://localhost:4021";
const SELLER_ADDRESS = process.env.SELLER_ADDRESS;
// Defaults to testnet USDC (@x402/stellar's default), but this example is
// most often run against a throwaway test token instead (see
// e2e/conformance/README.md) — set ASSET_TOKEN to match whatever the buyer
// actually holds a balance/allowance in.
const ASSET_TOKEN = process.env.ASSET_TOKEN ?? "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
if (!SELLER_ADDRESS) {
  console.error("SELLER_ADDRESS is required (the Stellar address that receives payment)");
  process.exit(1);
}

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });

// Tier 1 (exact) and tier 3 (managed upto, feeBps > 0 — the facilitator's fee is
// computed and paid atomically on-chain by the settlement contract, in the same
// transaction as the seller's payment; see contracts/upto-settlement).
const resourceServer = new x402ResourceServer(facilitatorClient)
  .register(STELLAR_TESTNET_CAIP2, new ExactStellarServerScheme())
  .register(STELLAR_TESTNET_CAIP2, new UptoStellarServerScheme({ feeBps: 500 }));

const app = express();
app.use(express.json());

app.use(
  paymentMiddleware(
    {
      // Fixed-price endpoint — the `exact` scheme, billed off-chain by the
      // facilitator (tier 1 in docs/architecture.md).
      "GET /weather/:city": declareStellarResource({
        scheme: "exact",
        payTo: SELLER_ADDRESS,
        asset: ASSET_TOKEN,
        amount: "10000",
        network: STELLAR_TESTNET_CAIP2,
        description: "Current weather for a city",
        mimeType: "application/json",
        discovery: {
          pathParamsSchema: {
            properties: { city: { type: "string", description: "City name slug" } },
            required: ["city"],
          },
          output: { example: { city: "san-francisco", weather: "foggy", temperature: 60 } },
        },
      }),

      // Usage-metered endpoint — the `upto` scheme at feeBps: 500 (managed
      // tier). The client authorizes up to $0.05; the actual charge is set
      // per-request below via `setSettlementOverrides`, and the facilitator's
      // 5% cut is paid atomically on-chain alongside the seller's share.
      "POST /llm/generate": declareStellarResource({
        scheme: "upto",
        payTo: SELLER_ADDRESS,
        asset: ASSET_TOKEN,
        amount: "500000",
        network: STELLAR_TESTNET_CAIP2,
        description: "Text generation, billed per output token (managed upto: facilitator fee paid on-chain)",
        mimeType: "application/json",
        discovery: {
          bodyType: "json",
          input: { prompt: "Write a haiku about the ocean" },
          output: { example: { text: "...", tokens: 12 } },
        },
      }),
    },
    resourceServer,
  ),
);

app.get("/weather/:city", (req, res) => {
  const { city } = req.params;
  const weatherData: Record<string, { weather: string; temperature: number }> = {
    "san-francisco": { weather: "foggy", temperature: 60 },
    "new-york": { weather: "cloudy", temperature: 55 },
    tokyo: { weather: "rainy", temperature: 65 },
  };
  const data = weatherData[city] ?? { weather: "sunny", temperature: 70 };
  res.json({ city, ...data });
});

const MAX_TOKENS = 50;

app.post("/llm/generate", (req, res) => {
  const prompt: string = typeof req.body?.prompt === "string" ? req.body.prompt : "";

  // Stand-in for a real LLM call: deterministic "generation" so the example
  // is runnable without an external API key. Token count is what actually
  // varies per request and drives the metered charge below.
  const tokens = Math.min(MAX_TOKENS, Math.max(1, Math.ceil(prompt.length / 4)));
  const text = `Generated ${tokens} tokens in response to: "${prompt.slice(0, 60)}"`;

  // Percentage of the declared max (500000 atomic units) rather than a
  // dollar amount — decimals-agnostic, and this example prices in raw atomic
  // units already (see `accepts` above), not dollars.
  const percentOfMax = ((tokens / MAX_TOKENS) * 100).toFixed(2);
  setSettlementOverrides(res, { amount: `${percentOfMax}%` });

  res.json({ text, tokens });
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`Seller example listening on http://localhost:${PORT}`);
  console.log(`  Facilitator: ${FACILITATOR_URL}`);
  console.log(`  GET  /weather/:city   (exact, $0.001)`);
  console.log(`  POST /llm/generate    (managed upto, up to $0.05, metered per token)`);
});
