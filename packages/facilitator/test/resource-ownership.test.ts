import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";

// Node built-in ESM module namespaces aren't configurable, so `vi.spyOn`
// can't patch `lookup` directly — mock the module instead, wrapping the
// real implementation so every test gets real DNS behavior by default;
// individual tests override with `mockResolvedValueOnce`.
vi.mock("node:dns/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return { ...actual, lookup: vi.fn(actual.lookup) };
});

import { verifyResourceOwnership, type OwnershipCheckInput } from "../src/resource-ownership.js";

function requirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: "stellar:testnet",
    asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    amount: "10000",
    payTo: "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO",
    maxTimeoutSeconds: 60,
    extra: {},
    ...overrides,
  };
}

function input(overrides: Partial<OwnershipCheckInput> = {}): OwnershipCheckInput {
  return {
    resourceUrl: "https://seller.example.com/weather",
    type: "http",
    method: "GET",
    payTo: requirements().payTo,
    requirements: requirements(),
    ...overrides,
  };
}

function response402(accepts: PaymentRequirements[]): Response {
  const header = encodePaymentRequiredHeader({
    x402Version: 2,
    resource: { url: "https://seller.example.com/weather" },
    accepts,
  });
  return new Response(null, { status: 402, headers: { "PAYMENT-REQUIRED": header } });
}

describe("verifyResourceOwnership", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("skips MCP resources (not implemented for that transport)", async () => {
    const result = await verifyResourceOwnership(input({ type: "mcp" }));
    expect(result.outcome).toBe("skipped");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("verifies when the live 402 names the same payTo for the matching scheme/network/asset", async () => {
    vi.mocked(fetch).mockResolvedValue(response402([requirements()]));
    const result = await verifyResourceOwnership(input());
    expect(result.outcome).toBe("verified");
  });

  it("fails when the live 402 names a different payTo — the actual squatting/hijack signature", async () => {
    vi.mocked(fetch).mockResolvedValue(
      response402([requirements({ payTo: "GDIFFERENTPAYTO0000000000000000000000000000000000000000" })]),
    );
    const result = await verifyResourceOwnership(input());
    expect(result.outcome).toBe("failed");
    expect(result).toMatchObject({ reason: expect.stringContaining("does not match") });
  });

  it("fails closed when the resource never responds with 402 at all", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("ok", { status: 200 }));
    const result = await verifyResourceOwnership(input());
    expect(result.outcome).toBe("failed");
  });

  it("fails closed on a redirect rather than following it", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://evil.example.com/" } }));
    const result = await verifyResourceOwnership(input());
    expect(result.outcome).toBe("failed");
  });

  it("passes redirect: manual to fetch, so redirects are never silently followed", async () => {
    vi.mocked(fetch).mockResolvedValue(response402([requirements()]));
    await verifyResourceOwnership(input());
    expect(fetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("fails closed when no accepts entry matches scheme/network/asset", async () => {
    vi.mocked(fetch).mockResolvedValue(response402([requirements({ scheme: "upto" })]));
    const result = await verifyResourceOwnership(input());
    expect(result.outcome).toBe("failed");
  });

  it("fails closed when the 402 response has no PAYMENT-REQUIRED header", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 402 }));
    const result = await verifyResourceOwnership(input());
    expect(result.outcome).toBe("failed");
  });

  it("fails closed when fetch itself throws (network error, timeout, etc.)", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await verifyResourceOwnership(input());
    expect(result.outcome).toBe("failed");
  });

  it("refuses plain HTTP to a non-loopback host without ever calling fetch", async () => {
    const result = await verifyResourceOwnership(input({ resourceUrl: "http://seller.example.com/weather" }));
    expect(result.outcome).toBe("failed");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("allows plain HTTP to localhost (the local demo flow)", async () => {
    vi.mocked(fetch).mockResolvedValue(response402([requirements()]));
    const result = await verifyResourceOwnership(input({ resourceUrl: "http://localhost:4022/weather" }));
    expect(result.outcome).toBe("verified");
  });

  it("refuses a literal private/link-local IP host without ever calling fetch", async () => {
    const result = await verifyResourceOwnership(input({ resourceUrl: "http://169.254.169.254/weather" }));
    expect(result.outcome).toBe("failed");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a domain name that resolves to a private address", async () => {
    const dns = await import("node:dns/promises");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(dns.lookup).mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }] as any);
    const result = await verifyResourceOwnership(input({ resourceUrl: "https://attacker-controlled.example/weather" }));
    expect(result.outcome).toBe("failed");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed on a malformed resourceUrl", async () => {
    const result = await verifyResourceOwnership(input({ resourceUrl: "not a url" }));
    expect(result.outcome).toBe("failed");
    expect(fetch).not.toHaveBeenCalled();
  });
});
