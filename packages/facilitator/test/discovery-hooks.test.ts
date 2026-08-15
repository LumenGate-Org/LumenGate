import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BazaarCatalog } from "@x402-stellar/discovery";
import type { FacilitatorSettleResultContext, FacilitatorVerifyResultContext } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

/**
 * `extractDiscoveryInfo` (upstream, `@x402/extensions/bazaar`) is mocked
 * rather than exercised for real: its own extraction/validation logic is
 * already the upstream package's concern. What these tests verify is ours —
 * protocol cataloging trigger (provisional at a validated `verify`
 * receipt) plus the anti-spam bound on top of it (bounded-lifetime unless
 * confirmed by a real settlement) — see "Automatic cataloging: provisional
 * at receipt, confirmed at settlement" in docs/architecture.md.
 */
const { extractDiscoveryInfoMock } = vi.hoisted(() => ({ extractDiscoveryInfoMock: vi.fn() }));
vi.mock("@x402/extensions/bazaar", () => ({
  extractDiscoveryInfo: extractDiscoveryInfoMock,
}));

/**
 * `verifyResourceOwnership` makes a real outbound HTTP request — not
 * something these hook-level tests should depend on network for. Mocked to
 * `"verified"` by default (preserving every pre-existing test's behavior,
 * since that's a pass-through), with a dedicated "resource-ownership
 * gating" describe block below overriding it to exercise the gating logic
 * itself. Its own SSRF hardening, live-402 matching, and fail-closed
 * behavior are `resource-ownership.test.ts`'s concern, not this file's.
 */
const { verifyResourceOwnershipMock } = vi.hoisted(() => ({ verifyResourceOwnershipMock: vi.fn() }));
vi.mock("../src/resource-ownership.js", () => ({
  verifyResourceOwnership: verifyResourceOwnershipMock,
}));

const {
  createBazaarCatalogingHook,
  createBazaarFailureHook,
  createBazaarVerifyPreviewHook,
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

  describe("createBazaarVerifyPreviewHook (onAfterVerify)", () => {
    it("catalogs a well-formed extension as provisional, with a future expiry", async () => {
      extractDiscoveryInfoMock.mockReturnValue(discoveredResource);
      const p = payload();
      await createBazaarVerifyPreviewHook(catalog)({
        paymentPayload: p,
        requirements: requirements(),
        result: { isValid: true, payer: "GPAYER" },
      } as FacilitatorVerifyResultContext);

      const resources = (await catalog.list()).resources;
      expect(resources).toHaveLength(1);
      expect(resources[0].status).toBe("provisional");
      expect(new Date(resources[0].provisionalExpiresAt!).getTime()).toBeGreaterThan(Date.now());
      expect(getBazaarExtensionStatus(p)).toEqual({ status: "processing" });
    });

    it("does nothing when verification failed", async () => {
      const p = payload();
      await createBazaarVerifyPreviewHook(catalog)({
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
      await createBazaarVerifyPreviewHook(catalog)({
        paymentPayload: p,
        requirements: requirements(),
        result: { isValid: true, payer: "GPAYER" },
      } as FacilitatorVerifyResultContext);

      expect(getBazaarExtensionStatus(p)).toBeUndefined();
      expect((await catalog.list()).resources).toHaveLength(0);
    });
  });

  describe("createBazaarCatalogingHook (onAfterSettle)", () => {
    it("catalogs a well-formed extension as confirmed after a successful settlement", async () => {
      extractDiscoveryInfoMock.mockReturnValue(discoveredResource);
      const p = payload();
      await createBazaarCatalogingHook(catalog)({
        paymentPayload: p,
        requirements: requirements(),
        result: { success: true, transaction: "abc123", network: "stellar:testnet", payer: "GPAYER" },
      } as FacilitatorSettleResultContext);

      const resources = (await catalog.list()).resources;
      expect(resources).toHaveLength(1);
      expect(resources[0].status).toBe("confirmed");
      expect(getBazaarExtensionStatus(p)).toEqual({ status: "success" });
    });

    it("does not catalog when settlement failed, even with a well-formed extension", async () => {
      extractDiscoveryInfoMock.mockReturnValue(discoveredResource);
      const p = payload();
      await createBazaarCatalogingHook(catalog)({
        paymentPayload: p,
        requirements: requirements(),
        result: { success: false, transaction: "", network: "stellar:testnet", errorReason: "insufficient_funds" },
      } as FacilitatorSettleResultContext);

      expect((await catalog.list()).resources).toHaveLength(0);
      expect(extractDiscoveryInfoMock).not.toHaveBeenCalled();
    });

    it("catalogs the advertised max, not the settle-phase actual charge, for upto", async () => {
      // `upto` is phase-dependent: verify-time `requirements.amount` is the
      // ceiling the client authorized (echoed unchanged as `paymentPayload.
      // accepted`); settle-time `requirements.amount` is this one request's
      // metered actual charge (`@x402/core`'s `settlePayment` builds it as
      // `{ ...accepted, amount: <override> }`). Cataloging the latter would
      // publish a one-off charge as the resource's advertised price.
      extractDiscoveryInfoMock.mockReturnValue(discoveredResource);
      const advertised = requirements(); // amount: "10000" stands in for the true ceiling
      advertised.scheme = "upto";
      advertised.amount = "500000"; // the true, client-authorized ceiling
      const p: PaymentPayload = { ...payload(), accepted: advertised };
      const settlePhaseRequirements: PaymentRequirements = { ...advertised, amount: "80000" }; // this request's metered actual charge

      await createBazaarCatalogingHook(catalog)({
        paymentPayload: p,
        requirements: settlePhaseRequirements,
        result: { success: true, transaction: "abc123", network: "stellar:testnet", payer: "GPAYER", amount: "80000" },
      } as FacilitatorSettleResultContext);

      const [resource] = (await catalog.list()).resources;
      expect(resource.accepts).toHaveLength(1);
      expect((resource.accepts[0] as PaymentRequirements).amount).toBe("500000");
      expect(extractDiscoveryInfoMock).toHaveBeenCalledWith(p, advertised, true);
    });

    it("leaves nothing in the durable outbox after a normal, successful catalog write", async () => {
      extractDiscoveryInfoMock.mockReturnValue(discoveredResource);
      const p = payload();
      await createBazaarCatalogingHook(catalog)({
        paymentPayload: p,
        requirements: requirements(),
        result: { success: true, transaction: "abc123", network: "stellar:testnet", payer: "GPAYER" },
      } as FacilitatorSettleResultContext);

      expect(await catalog.listPending()).toEqual([]);
    });

    it("crash-safety: a pending outbox entry survives if the actual catalog upsert throws", async () => {
      // Simulates the exact crash this outbox exists for (see "Automatic
      // cataloging" in docs/architecture.md): something goes wrong between
      // the durable enqueue and the upsert actually landing. The row must
      // survive so packages/facilitator/src/indexer.ts can find and retry it
      // later — proving the fix actually closes the gap, not just that the
      // happy path still works.
      extractDiscoveryInfoMock.mockReturnValue(discoveredResource);
      const upsertSpy = vi.spyOn(catalog, "upsert").mockImplementation(() => {
        throw new Error("simulated crash mid-write");
      });
      const p = payload();

      await createBazaarCatalogingHook(catalog)({
        paymentPayload: p,
        requirements: requirements(),
        result: { success: true, transaction: "crash-tx", network: "stellar:testnet", payer: "GPAYER" },
      } as FacilitatorSettleResultContext);

      upsertSpy.mockRestore();

      const pending = await catalog.listPending();
      expect(pending).toHaveLength(1);
      expect(pending[0].transactionHash).toBe("crash-tx");
      expect(getBazaarExtensionStatus(p)).toEqual({ status: "rejected", rejectedReason: "simulated crash mid-write" });

      // A separate reconciler pass (what packages/facilitator/src/indexer.ts
      // does) can now retry it independently, with upsert working normally again.
      await catalog.upsert(pending[0].input, { status: "confirmed" });
      await catalog.resolvePending(pending[0].transactionHash);
      expect((await catalog.list()).resources).toHaveLength(1);
      expect(await catalog.listPending()).toEqual([]);
    });

    it("promotes a provisional entry (from verify) to confirmed (at settle), clearing its expiry", async () => {
      // The end-to-end lifecycle: a resource server's paid endpoint gets
      // hit, /verify runs first (provisional, per the protocol
      // trigger), then /settle runs (confirmed, permanent) for the same
      // request — this is the protocol-aligned path replacing the old
      // settlement-only trigger.
      extractDiscoveryInfoMock.mockReturnValue(discoveredResource);
      const p = payload();

      await createBazaarVerifyPreviewHook(catalog)({
        paymentPayload: p,
        requirements: requirements(),
        result: { isValid: true, payer: "GPAYER" },
      } as FacilitatorVerifyResultContext);
      expect((await catalog.list()).resources[0].status).toBe("provisional");

      await createBazaarCatalogingHook(catalog)({
        paymentPayload: p,
        requirements: requirements(),
        result: { success: true, transaction: "abc123", network: "stellar:testnet", payer: "GPAYER" },
      } as FacilitatorSettleResultContext);

      const resources = (await catalog.list()).resources;
      expect(resources).toHaveLength(1); // same resource id, not duplicated
      expect(resources[0].status).toBe("confirmed");
      expect(resources[0].provisionalExpiresAt).toBeUndefined();
    });

    it("a verify-only flow (never settled) stays provisional, not permanently invisible nor permanently visible", async () => {
      // Per protocol cataloging trigger (Section 3.2), a validated
      // receipt catalogs the resource immediately — this is intentional,
      // not a spam hole reopened: the entry is bounded-lifetime
      // (`provisionalExpiresAt`) and packages/facilitator/src/indexer.ts
      // evicts it if never confirmed. See catalog.test.ts's
      // "evictExpiredProvisional" tests for the eviction mechanics.
      extractDiscoveryInfoMock.mockReturnValue(discoveredResource);
      const p = payload();
      await createBazaarVerifyPreviewHook(catalog)({
        paymentPayload: p,
        requirements: requirements(),
        result: { isValid: true, payer: "GPAYER" },
      } as FacilitatorVerifyResultContext);

      const resources = (await catalog.list()).resources;
      expect(resources).toHaveLength(1);
      expect(resources[0].status).toBe("provisional");
    });
  });

  describe("resource-ownership gating (onAfterSettle)", () => {
    it("runs the ownership check for a brand-new resourceUrl and rejects cataloging on failure", async () => {
      extractDiscoveryInfoMock.mockReturnValue(discoveredResource);
      verifyResourceOwnershipMock.mockResolvedValue({
        outcome: "failed",
        reason: "resource's live payTo does not match the catalog submission",
      });
      const p = payload();

      await createBazaarCatalogingHook(catalog)({
        paymentPayload: p,
        requirements: requirements(),
        result: { success: true, transaction: "abc123", network: "stellar:testnet", payer: "GPAYER" },
      } as FacilitatorSettleResultContext);

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

      await createBazaarCatalogingHook(catalog)({
        paymentPayload: p,
        requirements: requirements(),
        result: { success: true, transaction: "abc123", network: "stellar:testnet", payer: "GPAYER" },
      } as FacilitatorSettleResultContext);

      expect(verifyResourceOwnershipMock).toHaveBeenCalledTimes(1);
      expect((await catalog.list()).resources).toHaveLength(1);
    });

    it("skips the ownership check when an existing confirmed resource re-settles with the same payTo", async () => {
      extractDiscoveryInfoMock.mockReturnValue(discoveredResource);
      const p1 = payload();
      await createBazaarCatalogingHook(catalog)({
        paymentPayload: p1,
        requirements: requirements(),
        result: { success: true, transaction: "tx1", network: "stellar:testnet", payer: "GPAYER" },
      } as FacilitatorSettleResultContext);
      expect(verifyResourceOwnershipMock).toHaveBeenCalledTimes(1);

      // Second settlement for the same resourceUrl, same payTo — no reason
      // to pay the cost of another live fetch; nothing about "who gets
      // paid" is changing.
      const p2 = payload();
      await createBazaarCatalogingHook(catalog)({
        paymentPayload: p2,
        requirements: requirements(),
        result: { success: true, transaction: "tx2", network: "stellar:testnet", payer: "GPAYER" },
      } as FacilitatorSettleResultContext);

      expect(verifyResourceOwnershipMock).toHaveBeenCalledTimes(1); // still just once
      expect(getBazaarExtensionStatus(p2)).toEqual({ status: "success" });
    });

    it("re-verifies (and can reject) when a settlement would change an existing resource's payTo", async () => {
      // This is the actual squatting/impersonation shape: same resourceUrl,
      // a different payTo trying to overwrite the real one.
      extractDiscoveryInfoMock.mockReturnValue(discoveredResource);
      const p1 = payload();
      await createBazaarCatalogingHook(catalog)({
        paymentPayload: p1,
        requirements: requirements(),
        result: { success: true, transaction: "tx1", network: "stellar:testnet", payer: "GPAYER" },
      } as FacilitatorSettleResultContext);

      verifyResourceOwnershipMock.mockResolvedValue({
        outcome: "failed",
        reason: "resource's live payTo does not match the catalog submission",
      });
      const hijackRequirements = { ...requirements(), payTo: "GATTACKER00000000000000000000000000000000000000000000000" };
      const p2: PaymentPayload = { ...payload(), accepted: hijackRequirements };

      await createBazaarCatalogingHook(catalog)({
        paymentPayload: p2,
        requirements: hijackRequirements,
        result: { success: true, transaction: "tx2", network: "stellar:testnet", payer: "GATTACKER" },
      } as FacilitatorSettleResultContext);

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
      await catalog.upsert(catalogInputFromDiscovered(), { status: "confirmed" });
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
      // Simulates cataloging having been rejected this round (e.g. by the
      // resource-ownership check) — recordUsage's foreign key would reject
      // an id that isn't in `resources`, so this must be caught before that,
      // not surfaced as an error.
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
      await catalog.upsert(catalogInputFromDiscovered(), { status: "confirmed" });
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
      await catalog.upsert(catalogInputFromDiscovered(), { status: "confirmed" });
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
      // run right after a real, successful cataloging pass, confirm a
      // usage-write failure never retroactively marks that settlement as
      // rejected.
      extractDiscoveryInfoMock.mockReturnValue(discoveredResource);
      const p = payload();

      await createBazaarCatalogingHook(catalog)({
        paymentPayload: p,
        requirements: requirements(),
        result: { success: true, transaction: "abc123", network: "stellar:testnet", payer: "GPAYER" },
      } as FacilitatorSettleResultContext);
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
