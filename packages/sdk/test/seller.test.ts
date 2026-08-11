import { describe, expect, it, vi } from "vitest";

/**
 * `declareDiscoveryExtension` (upstream, `@x402/extensions/bazaar`) is
 * mocked so these tests isolate what this module actually adds — Stellar
 * pricing/address validation and defaults — rather than re-testing
 * upstream's own extension encoding.
 */
const { declareDiscoveryExtensionMock } = vi.hoisted(() => ({ declareDiscoveryExtensionMock: vi.fn() }));
vi.mock("@x402/extensions/bazaar", () => ({
  declareDiscoveryExtension: declareDiscoveryExtensionMock,
}));

const { declareStellarResource, stellarPaymentOption } = await import("../src/seller.js");

const PAY_TO = "GANYLKM3JW555MX52DCOJNRF4KA6MM222V4LA3JKHRQNTI3JQV735NDC";
const ASSET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

describe("stellarPaymentOption", () => {
  it("builds a PaymentOption defaulting to testnet", () => {
    const option = stellarPaymentOption({ scheme: "exact", payTo: PAY_TO, asset: ASSET, amount: "10000" });
    expect(option).toEqual({
      scheme: "exact",
      payTo: PAY_TO,
      price: { amount: "10000", asset: ASSET },
      network: "stellar:testnet",
      maxTimeoutSeconds: undefined,
    });
  });

  it("respects an explicit network", () => {
    const option = stellarPaymentOption({
      scheme: "upto",
      payTo: PAY_TO,
      asset: ASSET,
      amount: "500000",
      network: "stellar:pubnet",
    });
    expect(option.network).toBe("stellar:pubnet");
    expect(option.scheme).toBe("upto");
  });

  it("rejects an invalid payTo address", () => {
    expect(() =>
      stellarPaymentOption({ scheme: "exact", payTo: "not-an-address", asset: ASSET, amount: "10000" }),
    ).toThrow(/Invalid Stellar payTo address/);
  });

  it("rejects an invalid asset address", () => {
    expect(() =>
      stellarPaymentOption({ scheme: "exact", payTo: PAY_TO, asset: "not-an-asset", amount: "10000" }),
    ).toThrow(/Invalid Stellar asset address/);
  });
});

describe("declareStellarResource", () => {
  it("builds a RouteConfig with a single accepts entry and no extensions when discovery is omitted", () => {
    const route = declareStellarResource({
      scheme: "exact",
      payTo: PAY_TO,
      asset: ASSET,
      amount: "10000",
      description: "Current weather",
      mimeType: "application/json",
    });
    expect(route.accepts).toEqual([
      { scheme: "exact", payTo: PAY_TO, price: { amount: "10000", asset: ASSET }, network: "stellar:testnet", maxTimeoutSeconds: undefined },
    ]);
    expect(route.description).toBe("Current weather");
    expect(route.mimeType).toBe("application/json");
    expect(route.extensions).toBeUndefined();
    expect(declareDiscoveryExtensionMock).not.toHaveBeenCalled();
  });

  it("wires the discovery config through to declareDiscoveryExtension and spreads the result", () => {
    declareDiscoveryExtensionMock.mockReturnValue({ bazaar: { info: { fake: true } } });
    const discoveryConfig = { pathParamsSchema: { properties: {}, required: [] } };

    const route = declareStellarResource({
      scheme: "exact",
      payTo: PAY_TO,
      asset: ASSET,
      amount: "10000",
      discovery: discoveryConfig,
    });

    expect(declareDiscoveryExtensionMock).toHaveBeenCalledWith(discoveryConfig);
    expect(route.extensions).toEqual({ bazaar: { info: { fake: true } } });
  });

  it("propagates validation errors from the underlying payment option", () => {
    expect(() =>
      declareStellarResource({ scheme: "exact", payTo: "bad", asset: ASSET, amount: "10000" }),
    ).toThrow(/Invalid Stellar payTo address/);
  });
});
