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

// The MCP path connects with a real @modelcontextprotocol/sdk Client over a
// real network transport — mocked here the same way `fetch` is mocked for
// the HTTP path, so these tests exercise this module's own logic (SSRF
// guards, tool-name matching, fail-closed behavior) without a real MCP
// server.
const mcpConnect = vi.fn();
const mcpListTools = vi.fn();
const mcpClose = vi.fn();
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: mcpConnect,
    listTools: mcpListTools,
    close: mcpClose,
  })),
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));

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
    mcpConnect.mockReset().mockResolvedValue(undefined);
    mcpListTools.mockReset().mockResolvedValue({ tools: [{ name: "get-weather" }] });
    mcpClose.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("MCP resources", () => {
    function mcpInput(overrides: Partial<OwnershipCheckInput> = {}): OwnershipCheckInput {
      return input({ type: "mcp", toolName: "get-weather", ...overrides });
    }

    it("verifies when the live MCP server lists a tool with the matching name", async () => {
      const result = await verifyResourceOwnership(mcpInput());
      expect(result.outcome).toBe("verified");
      expect(mcpConnect).toHaveBeenCalledTimes(1);
      expect(mcpClose).toHaveBeenCalledTimes(1);
    });

    it("fails closed when the live MCP server has no tool with that name", async () => {
      mcpListTools.mockResolvedValue({ tools: [{ name: "some-other-tool" }] });
      const result = await verifyResourceOwnership(mcpInput());
      expect(result.outcome).toBe("failed");
      expect(result).toMatchObject({ reason: expect.stringContaining("get-weather") });
    });

    it("fails closed when connecting to the MCP server throws", async () => {
      mcpConnect.mockRejectedValue(new Error("ECONNREFUSED"));
      const result = await verifyResourceOwnership(mcpInput());
      expect(result.outcome).toBe("failed");
    });

    it("fails closed when toolName is missing from the submission", async () => {
      const result = await verifyResourceOwnership(mcpInput({ toolName: undefined }));
      expect(result.outcome).toBe("failed");
      expect(mcpConnect).not.toHaveBeenCalled();
    });

    it("refuses plain HTTP to a non-loopback MCP host without ever connecting", async () => {
      const result = await verifyResourceOwnership(
        mcpInput({ resourceUrl: "http://seller.example.com/mcp" }),
      );
      expect(result.outcome).toBe("failed");
      expect(mcpConnect).not.toHaveBeenCalled();
    });

    it("refuses an MCP resourceUrl that resolves to a private address", async () => {
      const result = await verifyResourceOwnership(
        mcpInput({ resourceUrl: "http://169.254.169.254/mcp" }),
      );
      expect(result.outcome).toBe("failed");
      expect(mcpConnect).not.toHaveBeenCalled();
    });

    it("always closes the client connection, even on failure", async () => {
      mcpListTools.mockRejectedValue(new Error("boom"));
      await verifyResourceOwnership(mcpInput());
      expect(mcpClose).toHaveBeenCalledTimes(1);
    });
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
