import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BazaarCatalog } from "@x402-stellar/discovery";
import type { FacilitatorSettleResultContext, FacilitatorVerifyResultContext } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

/**
 * `extractDiscoveryInfo` (upstream, `@x402/extensions/bazaar`) is mocked
 * rather than exercised for real: its own extraction/validation logic is
 * already the upstream package's concern. What these tests verify is ours —
 * the protocol's literal cataloging trigger (a validated `verify` receipt,
 * not settlement) gated on independent payment-information verification
 * before indexing — see "Automatic cataloging" in docs/architecture.md.
 */
const { extractDiscoveryInfoMock } = vi.hoisted(() => ({ extractDiscoveryInfoMock: vi.fn() }));
vi.mock("@x402/extensions/bazaar", () => ({
  extractDiscoveryInfo: extractDiscoveryInfoMock,
}));

/**
 * `verifyResourceOwnership` makes a real outbound HTTP/MCP connection — not
 * something these hook-level tests should depend on network for. Mocked to
 * `"verified"` by default (preserving every pre-existing test's behavior,
 * since that's a pass-through), with a dedicated "resource-ownership
 * gating" describe block below overriding it to exercise the gating logic
 * itself. Its own SSRF hardening, live-402/MCP matching, and fail-closed
 * behavior are `resource-ownership.test.ts`'s concern, not this file's.
 */
const { verifyResourceOwnershipMock } = vi.hoisted(() => ({ verifyResourceOwnershipMock: vi.fn() }));
vi.mock("../src/resource-ownership.js", () => ({
  verifyResourceOwnership: verifyResourceOwnershipMock,
}));

const {
  createBazaarCatalogingHook,
  createBazaarFailureHook,
  createUsageTrackingHook,
  DEFAULT_MIN_SETTLED_AMOUNT_FOR_UNIQUE_BUYER_CREDIT,
  getBazaarExtensionStatus,
} = await import("../src/discovery-hooks.js");

function requirements(): PaymentRequirements {
  return {
    scheme: "exact",
    network: "stellar:testnet",
    asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    amount: "10000",
    payTo: "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO",
    maxTimeoutSeconds: 60,
  };
}

function payload(): PaymentPayload {
  return {
    x402Version: 2,
    resource: { url: "https://api.example.com/weather" },
    accepted: requirements(),
    payload: {},
  };
}

const discoveredResource = {
  resourceUrl: "https://api.example.com/weather",
  discoveryInfo: { input: { type: "http" } },
  method: "GET",
  x402Version: 2,
  description: "Weather forecast API",
  serviceName: "Example Weather",
  tags: ["weather"],
  extensions: { bazaar: { info: {} } },
};

/**
 * A real, valid `DiscoveredResourceInput` matching `discoveredResource`'s
 * shape (what `extractCatalogInput` would actually build from it) — for
 * tests that need a resource to genuinely exist in the catalog first (the
 * usage-tracking hook's foreign-key precondition), not just an
 * `extractDiscoveryInfoMock` return value.
 */
function catalogInputFromDiscovered() {
  return {
    resourceUrl: discoveredResource.resourceUrl,
    type: "http" as const,
    method: discoveredResource.method,
    x402Version: discoveredResource.x402Version,
    description: discoveredResource.description,
    serviceName: discoveredResource.serviceName,
    tags: discoveredResource.tags,
    payTo: requirements().payTo,
    scheme: requirements().scheme,
    network: requirements().network,
    requirements: requirements(),
    extensions: discoveredResource.extensions,
  };
}

function verifyContext(overrides: Partial<FacilitatorVerifyResultContext> = {}): FacilitatorVerifyResultContext {
  return {
    paymentPayload: payload(),
    requirements: requirements(),
    result: { isValid: true, payer: "GPAYER" },
    ...overrides,
  } as FacilitatorVerifyResultContext;
}

describe("discovery-hooks", () => {
  // One PGlite instance for the whole file — see the same rationale in
  // packages/discovery/test/catalog.test.ts.
  let catalog: BazaarCatalog;

  beforeAll(() => {
    catalog = new BazaarCatalog(":memory:");
  });

  afterAll(async () => {
    await catalog.close();
  });

  beforeEach(async () => {
    await catalog.clear();
    extractDiscoveryInfoMock.mockReset();
    verifyResourceOwnershipMock.mockReset();
    verifyResourceOwnershipMock.mockResolvedValue({ outcome: "verified" });
  });

  describe("createBazaarCatalogingHook (onAfterVerify)", () => {
    it("catalogs a well-formed extension immediately, gated on independent verification", async () => {
      extractDiscoveryInfoMock.mockReturnValue(discoveredResource);
      const p = payload();
      await createBazaarCatalogingHook(catalog)({
        paymentPayload: p,
        requirements: requirements(),
        result: { isValid: true, payer: "GPAYER" },
      } as FacilitatorVerifyResultContext);

      const resources = (await catalog.list()).resources;
      expect(resources).toHaveLength(1);
      expect(resources[0].lastVerifiedAt).toBeTruthy();
      expect(verifyResourceOwnershipMock).toHaveBeenCalledTimes(1);
      expect(getBazaarExtensionStatus(p)).toEqual({ status: "success" });
    });

    it("does nothing when verification failed", async () => {
      const p = payload();
      await createBazaarCatalogingHook(catalog)({
        paymentPayload: p,
        requirements: requirements(),
        result: { isValid: false, invalidReason: "bad_signature" },
      } as FacilitatorVerifyResultContext);

      expect(extractDiscoveryInfoMock).not.toHaveBeenCalled();
      expect(getBazaarExtensionStatus(p)).toBeUndefined();
      expect((await catalog.list()).resources).toHaveLength(0);
    });

    it("does nothing when no extension was declared", async () => {
      extractDiscoveryInfoMock.mockReturnValue(undefined);
      const p = payload();
      await createBazaarCatalogingHook(catalog)(verifyContext({ paymentPayload: p }));

      expect(getBazaarExtensionStatus(p)).toBeUndefined();
      expect((await catalog.list()).resources).toHaveLength(0);
    });

    it("catalogs what the client accepted (the advertised ceiling), not a settle-phase override — cataloging never sees settle-phase context at all", async () => {
      extractDiscoveryInfoMock.mockReturnValue(discoveredResource);
      const advertised = requirements();
      advertised.scheme = "upto";
      advertised.amount = "500000"; // the true, client-authorized ceiling
      const p: PaymentPayload = { ...payload(), accepted: advertised };

      await createBazaarCatalogingHook(catalog)(
        verifyContext({ paymentPayload: p, requirements: advertised }),
      );

      const [resource] = (await catalog.list()).resources;
      expect(resource.accepts).toHaveLength(1);
      expect((resource.accepts[0] as PaymentRequirements).amount).toBe("500000");
      expect(extractDiscoveryInfoMock).toHaveBeenCalledWith(p, advertised, true);
    });
  });

  describe("resource-ownership gating (onAfterVerify)", () => {
    it("runs the ownership check for a brand-new resourceUrl and rejects cataloging on failure", async () => {
      extractDiscoveryInfoMock.mockReturnValue(discoveredResource);
      verifyResourceOwnershipMock.mockResolvedValue({
        outcome: "failed",
        reason: "resource's live payTo does not match the catalog submission",
      });
      const p = payload();

      await createBazaarCatalogingHook(catalog)(verifyContext({ paymentPayload: p }));

      expect(verifyResourceOwnershipMock).toHaveBeenCalledTimes(1);
      expect((await catalog.list()).resources).toHaveLength(0);
      expect(getBazaarExtensionStatus(p)).toEqual({
        status: "rejected",
        rejectedReason: "resource-ownership check failed: resource's live payTo does not match the catalog submission",
      });
    });

    it("catalogs normally when the ownership check for a new resourceUrl verifies", async () => {
      extractDiscoveryInfoMock.mockReturnValue(discoveredResource);
      const p = payload();

      await createBazaarCatalogingHook(catalog)(verifyContext({ paymentPayload: p }));

      expect(verifyResourceOwnershipMock).toHaveBeenCalledTimes(1);
      expect((await catalog.list()).resources).toHaveLength(1);
    });

    it("skips the ownership check when an already-cataloged resource re-submits with the same payTo", async () => {
      extractDiscoveryInfoMock.mockReturnValue(discoveredResource);
      const p1 = payload();
      await createBazaarCatalogingHook(catalog)(verifyContext({ paymentPayload: p1 }));
      expect(verifyResourceOwnershipMock).toHaveBeenCalledTimes(1);

      // Second receipt for the same resourceUrl, same payTo — no reason to
      // pay the cost of another live check; nothing about "who gets paid"
      // is changing.
      const p2 = payload();
      await createBazaarCatalogingHook(catalog)(verifyContext({ paymentPayload: p2 }));

      expect(verifyResourceOwnershipMock).toHaveBeenCalledTimes(1); // still just once
      expect(getBazaarExtensionStatus(p2)).toEqual({ status: "success" });
    });

    it("re-verifies (and can reject) when a new receipt would change an existing resource's payTo", async () => {
      // This is the actual squatting/impersonation shape: same resourceUrl,
      // a different payTo trying to overwrite the real one.
      extractDiscoveryInfoMock.mockReturnValue(discoveredResource);
      const p1 = payload();
      await createBazaarCatalogingHook(catalog)(verifyContext({ paymentPayload: p1 }));

      verifyResourceOwnershipMock.mockResolvedValue({
        outcome: "failed",
        reason: "resource's live payTo does not match the catalog submission",
      });
      const hijackRequirements = { ...requirements(), payTo: "GATTACKER00000000000000000000000000000000000000000000000" };
      const p2: PaymentPayload = { ...payload(), accepted: hijackRequirements };

      await createBazaarCatalogingHook(catalog)(
        verifyContext({ paymentPayload: p2, requirements: hijackRequirements, result: { isValid: true, payer: "GATTACKER" } }),
      );

      expect(verifyResourceOwnershipMock).toHaveBeenCalledTimes(2);
      const resources = (await catalog.list()).resources;
      expect(resources).toHaveLength(1);
      expect(resources[0].payTo).toBe(requirements().payTo); // unchanged — the hijack attempt was rejected
      expect(getBazaarExtensionStatus(p2)).toEqual({
        status: "rejected",
        rejectedReason: "resource-ownership check failed: resource's live payTo does not match the catalog submission",
      });
    });
  });

  describe("createUsageTrackingHook (onAfterSettle)", () => {
    it("records usage against a resource that was already cataloged", async () => {
      extractDiscoveryInfoMock.mockReturnValue(discoveredResource);
      await catalog.upsert(catalogInputFromDiscovered(), { lastVerifiedAt: new Date().toISOString() });
      const recordUsageSpy = vi.spyOn(catalog, "recordUsage");
      const p = payload();

      await createUsageTrackingHook(catalog)({
        paymentPayload: p,
        requirements: requirements(),
        result: { success: true, transaction: "abc123", network: "stellar:testnet", payer: "GPAYER" },
      } as FacilitatorSettleResultContext);

      expect(recordUsageSpy).toHaveBeenCalledWith(
        "https://api.example.com/weather",
        "GPAYER",
        10000n,
        DEFAULT_MIN_SETTLED_AMOUNT_FOR_UNIQUE_BUYER_CREDIT,
      );
      recordUsageSpy.mockRestore();
    });

    it("does nothing when settlement failed", async () => {
      extractDiscoveryInfoMock.mockReturnValue(discoveredResource);
      const recordUsageSpy = vi.spyOn(catalog, "recordUsage");

      await createUsageTrackingHook(catalog)({
        paymentPayload: payload(),
        requirements: requirements(),
        result: { success: false, transaction: "", network: "stellar:testnet", errorReason: "insufficient_funds" },
      } as FacilitatorSettleResultContext);

      expect(recordUsageSpy).not.toHaveBeenCalled();
      recordUsageSpy.mockRestore();
    });

    it("does nothing when no bazaar extension was declared", async () => {
      extractDiscoveryInfoMock.mockReturnValue(undefined);
      const recordUsageSpy = vi.spyOn(catalog, "recordUsage");

      await createUsageTrackingHook(catalog)({
        paymentPayload: payload(),
        requirements: requirements(),
        result: { success: true, transaction: "abc123", network: "stellar:testnet", payer: "GPAYER" },
      } as FacilitatorSettleResultContext);

      expect(recordUsageSpy).not.toHaveBeenCalled();
      recordUsageSpy.mockRestore();
    });

    it("does nothing (and does not throw) when the resource was never actually cataloged", async () => {
      // Simulates cataloging having been rejected at verify-time (e.g. by
      // the resource-ownership check) — recordUsage's foreign key would
      // reject an id that isn't in `resources`, so this must be caught
      // before that, not surfaced as an error.
      extractDiscoveryInfoMock.mockReturnValue(discoveredResource);
      const recordUsageSpy = vi.spyOn(catalog, "recordUsage");

      await expect(
        createUsageTrackingHook(catalog)({
          paymentPayload: payload(),
          requirements: requirements(),
          result: { success: true, transaction: "abc123", network: "stellar:testnet", payer: "GPAYER" },
        } as FacilitatorSettleResultContext),
      ).resolves.not.toThrow();

      expect(recordUsageSpy).not.toHaveBeenCalled();
      recordUsageSpy.mockRestore();
    });

    it("does nothing when the settlement result has no payer", async () => {
      extractDiscoveryInfoMock.mockReturnValue(discoveredResource);
      await catalog.upsert(catalogInputFromDiscovered(), { lastVerifiedAt: new Date().toISOString() });
      const recordUsageSpy = vi.spyOn(catalog, "recordUsage");

      await createUsageTrackingHook(catalog)({
        paymentPayload: payload(),
        requirements: requirements(),
        result: { success: true, transaction: "abc123", network: "stellar:testnet" }, // no payer
      } as FacilitatorSettleResultContext);

      expect(recordUsageSpy).not.toHaveBeenCalled();
      recordUsageSpy.mockRestore();
    });

    it("uses a per-seller threshold function when provided", async () => {
      extractDiscoveryInfoMock.mockReturnValue(discoveredResource);
      await catalog.upsert(catalogInputFromDiscovered(), { lastVerifiedAt: new Date().toISOString() });
      const recordUsageSpy = vi.spyOn(catalog, "recordUsage");
      const thresholdFn = vi.fn().mockReturnValue(5000n);

      await createUsageTrackingHook(catalog, { minSettledAmountForUniqueBuyerCredit: thresholdFn })({
        paymentPayload: payload(),
        requirements: requirements(),
        result: { success: true, transaction: "abc123", network: "stellar:testnet", payer: "GPAYER" },
      } as FacilitatorSettleResultContext);

      expect(thresholdFn).toHaveBeenCalledWith(requirements().payTo);
      expect(recordUsageSpy).toHaveBeenCalledWith("https://api.example.com/weather", "GPAYER", 10000n, 5000n);
      recordUsageSpy.mockRestore();
    });

    it("logs and swallows a recordUsage failure without affecting the reported cataloging outcome", async () => {
      // The exact isolation createUsageTrackingHook's doc comment promises:
      // run right after a real, successful cataloging pass (at verify-time),
      // confirm a usage-write failure (at settle-time) never retroactively
      // marks that cataloging as rejected.
      extractDiscoveryInfoMock.mockReturnValue(discoveredResource);
      const p = payload();

      await createBazaarCatalogingHook(catalog)(verifyContext({ paymentPayload: p }));
      expect(getBazaarExtensionStatus(p)).toEqual({ status: "success" });

      const recordUsageSpy = vi.spyOn(catalog, "recordUsage").mockImplementation(() => {
        throw new Error("simulated usage-write failure");
      });

      await expect(
        createUsageTrackingHook(catalog)({
          paymentPayload: p,
          requirements: requirements(),
          result: { success: true, transaction: "abc123", network: "stellar:testnet", payer: "GPAYER" },
        } as FacilitatorSettleResultContext),
      ).resolves.not.toThrow();

      expect(getBazaarExtensionStatus(p)).toEqual({ status: "success" }); // unchanged
      recordUsageSpy.mockRestore();
    });
  });

  describe("createBazaarFailureHook (onVerifyFailure)", () => {
    it("marks the payload as rejected with the error message", async () => {
      const p = payload();
      await createBazaarFailureHook()({
        paymentPayload: p,
        requirements: requirements(),
        error: new Error("bad signature"),
      } as never);

      expect(getBazaarExtensionStatus(p)).toEqual({ status: "rejected", rejectedReason: "bad signature" });
    });
  });
});
