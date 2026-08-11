import { describe, expect, it, vi } from "vitest";
import type { PaymentRequirements } from "@x402/core/types";

// Node built-in ESM module namespaces aren't configurable, so `vi.spyOn`
// can't patch `lookup` directly — mock the module instead, wrapping the
// real implementation so every test gets real DNS behavior by default;
// individual tests override with `mockResolvedValueOnce`/`mockRejectedValueOnce`.
vi.mock("node:dns/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return { ...actual, lookup: vi.fn(actual.lookup) };
});

// `decodePaymentRequiredHeader`'s own encode/decode correctness is
// `@x402/core`'s concern, not ours — mocked so `checkPaymentRequiredResponse`
// tests can supply an arbitrary requirements array via a trivial header
// value, without needing to hand-construct a real wire-format header.
const { decodePaymentRequiredHeaderMock } = vi.hoisted(() => ({
  decodePaymentRequiredHeaderMock: vi.fn(),
}));
vi.mock("@x402/core/http", () => ({
  decodePaymentRequiredHeader: decodePaymentRequiredHeaderMock,
}));

import {
  checkPaymentRequiredResponse,
  findRequirementOverCap,
  isHostAllowed,
  isPrivateNetworkHost,
  isSecureUrl,
  resolvesToPrivateNetwork,
} from "../src/guardrails.js";

function requirement(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: "stellar:testnet",
    asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    amount: "1000",
    payTo: "GABC",
    maxTimeoutSeconds: 60,
    ...overrides,
  };
}

describe("isHostAllowed", () => {
  it("allows any host when the allowlist is empty (zero-config default)", () => {
    expect(isHostAllowed("https://anywhere.example.com/paid", [])).toBe(true);
  });

  it("allows a host present in the allowlist", () => {
    expect(isHostAllowed("https://seller.example.com/paid", ["seller.example.com"])).toBe(true);
  });

  it("rejects a host absent from a non-empty allowlist", () => {
    expect(isHostAllowed("https://evil.example.com/paid", ["seller.example.com"])).toBe(false);
  });

  it("compares hostnames only, ignoring path and query", () => {
    expect(
      isHostAllowed("https://seller.example.com/a/b?c=1", ["seller.example.com"]),
    ).toBe(true);
  });
});

describe("isSecureUrl", () => {
  it("allows https to any host", () => {
    expect(isSecureUrl("https://seller.example.com/paid")).toBe(true);
  });

  it("allows plain http to localhost (the local demo flow)", () => {
    expect(isSecureUrl("http://localhost:4022/weather/tokyo")).toBe(true);
  });

  it("allows plain http to 127.0.0.1", () => {
    expect(isSecureUrl("http://127.0.0.1:4022/weather/tokyo")).toBe(true);
  });

  it("allows plain http to the IPv6 loopback literal", () => {
    expect(isSecureUrl("http://[::1]:4022/weather/tokyo")).toBe(true);
  });

  it("rejects plain http to a non-loopback host", () => {
    expect(isSecureUrl("http://seller.example.com/paid")).toBe(false);
  });
});

describe("isPrivateNetworkHost", () => {
  it("does not flag loopback (isSecureUrl's concern, not this one's)", () => {
    expect(isPrivateNetworkHost("http://localhost:4022/x")).toBe(false);
    expect(isPrivateNetworkHost("http://127.0.0.1:4022/x")).toBe(false);
    expect(isPrivateNetworkHost("http://[::1]:4022/x")).toBe(false);
  });

  it("does not flag a public host", () => {
    expect(isPrivateNetworkHost("https://seller.example.com/x")).toBe(false);
    expect(isPrivateNetworkHost("https://8.8.8.8/x")).toBe(false);
  });

  it("flags the cloud metadata endpoint", () => {
    expect(isPrivateNetworkHost("http://169.254.169.254/latest/meta-data")).toBe(true);
  });

  it("flags RFC 1918 private ranges", () => {
    expect(isPrivateNetworkHost("http://10.0.0.5/x")).toBe(true);
    expect(isPrivateNetworkHost("http://172.16.0.5/x")).toBe(true);
    expect(isPrivateNetworkHost("http://172.31.255.255/x")).toBe(true);
    expect(isPrivateNetworkHost("http://192.168.1.1/x")).toBe(true);
  });

  it("does not flag a public address that merely starts with a private-looking octet", () => {
    expect(isPrivateNetworkHost("http://172.32.0.1/x")).toBe(false); // just outside 172.16.0.0/12
    expect(isPrivateNetworkHost("http://192.169.0.1/x")).toBe(false);
  });

  it("flags IPv6 unique-local and link-local addresses", () => {
    expect(isPrivateNetworkHost("http://[fc00::1]/x")).toBe(true);
    expect(isPrivateNetworkHost("http://[fd12:3456::1]/x")).toBe(true);
    expect(isPrivateNetworkHost("http://[fe80::1]/x")).toBe(true);
  });
});

describe("resolvesToPrivateNetwork", () => {
  // `dns.lookup` on a literal IP resolves locally (no real DNS query), so
  // these run offline and fast — same for `localhost`, which the OS
  // resolver serves from the hosts file / a built-in shortcut.

  it("flags a literal private IP (subsumes isPrivateNetworkHost for this case)", async () => {
    await expect(resolvesToPrivateNetwork("http://169.254.169.254/latest/meta-data")).resolves.toBe(true);
    await expect(resolvesToPrivateNetwork("http://10.0.0.5/x")).resolves.toBe(true);
  });

  it("does not flag localhost (loopback stays isSecureUrl's concern)", async () => {
    await expect(resolvesToPrivateNetwork("http://localhost/x")).resolves.toBe(false);
  });

  it("does not flag a literal public IP", async () => {
    await expect(resolvesToPrivateNetwork("https://8.8.8.8/x")).resolves.toBe(false);
  });

  it("does not block (fails open) when DNS resolution errors", async () => {
    const dns = await import("node:dns/promises");
    vi.mocked(dns.lookup).mockRejectedValueOnce(new Error("ENOTFOUND"));
    await expect(resolvesToPrivateNetwork("http://this-will-not-resolve.example/x")).resolves.toBe(false);
  });

  it("flags a domain name that resolves to a private address", async () => {
    const dns = await import("node:dns/promises");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(dns.lookup).mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }] as any);
    await expect(resolvesToPrivateNetwork("http://attacker-controlled.example/x")).resolves.toBe(true);
  });
});

describe("findRequirementOverCap", () => {
  it("returns undefined when no cap is configured", () => {
    expect(findRequirementOverCap([requirement({ amount: "999999999" })], undefined)).toBeUndefined();
  });

  it("returns undefined when requirements are undefined", () => {
    expect(findRequirementOverCap(undefined, 1_000n)).toBeUndefined();
  });

  it("returns undefined when every requirement is within the cap", () => {
    const reqs = [requirement({ amount: "500" }), requirement({ amount: "1000" })];
    expect(findRequirementOverCap(reqs, 1_000n)).toBeUndefined();
  });

  it("returns the first requirement that exceeds the cap", () => {
    const over = requirement({ amount: "5000", scheme: "upto" });
    const reqs = [requirement({ amount: "500" }), over];
    expect(findRequirementOverCap(reqs, 1_000n)).toBe(over);
  });

  it("fails closed (does not throw) on a non-digit amount from a remote resource server", () => {
    const malformed = requirement({ amount: "1e3" });
    expect(() => findRequirementOverCap([malformed], 1_000n)).not.toThrow();
    expect(findRequirementOverCap([malformed], 1_000n)).toBe(malformed);
  });
});

describe("checkPaymentRequiredResponse", () => {
  function response402(): Response {
    return new Response(null, { status: 402, headers: { "PAYMENT-REQUIRED": "irrelevant-mocked-header" } });
  }

  it("returns null requirements (no error) for a non-402 response", () => {
    decodePaymentRequiredHeaderMock.mockReturnValue({ accepts: [requirement({ amount: "999999999" })] });
    const result = checkPaymentRequiredResponse(new Response(null, { status: 200 }), 1_000n);
    expect(result).toEqual({ requirements: null, overCap: undefined });
    expect(decodePaymentRequiredHeaderMock).not.toHaveBeenCalled();
  });

  it("returns null requirements for a 402 with no PAYMENT-REQUIRED header", () => {
    const result = checkPaymentRequiredResponse(new Response(null, { status: 402 }), 1_000n);
    expect(result).toEqual({ requirements: null, overCap: undefined });
  });

  it("fails closed (returns null, no throw) when the header fails to decode", () => {
    decodePaymentRequiredHeaderMock.mockImplementation(() => {
      throw new Error("malformed");
    });
    expect(() => checkPaymentRequiredResponse(response402(), 1_000n)).not.toThrow();
    expect(checkPaymentRequiredResponse(response402(), 1_000n)).toEqual({ requirements: null, overCap: undefined });
  });

  it("decodes requirements and reports no overCap when within the configured cap", () => {
    const within = requirement({ amount: "500" });
    decodePaymentRequiredHeaderMock.mockReturnValue({ accepts: [within] });
    const result = checkPaymentRequiredResponse(response402(), 1_000n);
    expect(result).toEqual({ requirements: [within], overCap: undefined });
  });

  it("decodes requirements and reports overCap when the quote exceeds the configured cap", () => {
    // This is the actual quote `wrapFetchWithPayment` would pay — the whole
    // point of checking here rather than against a separate probe response
    // is that a resource server can't quote one price to a probe and a
    // higher price to the real request without this seeing the real one.
    const over = requirement({ amount: "999999999", scheme: "upto" });
    decodePaymentRequiredHeaderMock.mockReturnValue({ accepts: [over] });
    const result = checkPaymentRequiredResponse(response402(), 1_000n);
    expect(result).toEqual({ requirements: [over], overCap: over });
  });

  it("skips the cap check entirely when no cap is configured", () => {
    const huge = requirement({ amount: "999999999" });
    decodePaymentRequiredHeaderMock.mockReturnValue({ accepts: [huge] });
    const result = checkPaymentRequiredResponse(response402(), undefined);
    expect(result).toEqual({ requirements: [huge], overCap: undefined });
  });
});
