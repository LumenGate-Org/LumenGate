import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectPaymentRequirements } from "../src/inspect.js";

const SAMPLE_REQUIREMENTS = [
  {
    scheme: "exact",
    network: "stellar:testnet",
    amount: "10000",
    asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    payTo: "GANYLKM3JW555MX52DCOJNRF4KA6MM222V4LA3JKHRQNTI3JQV735NDC",
    maxTimeoutSeconds: 300,
    extra: { areFeesSponsored: true },
  },
];

function encodeHeader(paymentRequired: unknown): string {
  return Buffer.from(JSON.stringify(paymentRequired), "utf8").toString("base64");
}

describe("inspectPaymentRequirements", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("decodes PaymentRequirements from a 402 response", async () => {
    const header = encodeHeader({ x402Version: 2, accepts: SAMPLE_REQUIREMENTS });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 402, headers: { "PAYMENT-REQUIRED": header } })),
    );

    const result = await inspectPaymentRequirements("https://example.com/paid");
    expect(result).toEqual(SAMPLE_REQUIREMENTS);
  });

  it("returns null for a non-402 response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    const result = await inspectPaymentRequirements("https://example.com/free");
    expect(result).toBeNull();
  });

  it("returns null when a 402 response has no PAYMENT-REQUIRED header", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 402 })));
    const result = await inspectPaymentRequirements("https://example.com/malformed");
    expect(result).toBeNull();
  });

  it("forwards the request init to fetch", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 402,
          headers: { "PAYMENT-REQUIRED": encodeHeader({ x402Version: 2, accepts: SAMPLE_REQUIREMENTS }) },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const init = { method: "POST", body: JSON.stringify({ prompt: "hi" }) };
    await inspectPaymentRequirements("https://example.com/llm", init);
    expect(fetchMock).toHaveBeenCalledWith("https://example.com/llm", init);
  });
});
