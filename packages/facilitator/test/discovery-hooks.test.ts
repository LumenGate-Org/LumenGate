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

const {
  createBazaarCatalogingHook,
  createBazaarFailureHook,
  createBazaarVerifyPreviewHook,
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
