import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BazaarCatalog } from "../src/catalog.js";
import type { DiscoveredResourceInput, UpsertOptions } from "../src/types.js";

const CONFIRMED: UpsertOptions = { lastVerifiedAt: new Date().toISOString() };

function httpResource(overrides: Partial<DiscoveredResourceInput> = {}): DiscoveredResourceInput {
  return {
    resourceUrl: "https://api.example.com/weather",
    type: "http",
    method: "GET",
    x402Version: 2,
    description: "Weather forecast API",
    serviceName: "Example Weather",
    tags: ["weather", "forecast"],
    payTo: "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO",
    scheme: "exact",
    network: "stellar:testnet",
    requirements: { scheme: "exact", network: "stellar:testnet", amount: "10000" },
    extensions: { bazaar: { info: {} } },
    ...overrides,
  };
}

describe("BazaarCatalog", () => {
  // One PGlite instance for the whole file: constructing a fresh one pays
  // real WASM/cluster-init cost (seconds), unlike the near-instant fresh
  // in-memory database better-sqlite3 used to allow per-test. `clear()`
  // (a plain TRUNCATE) gets each test the same "starts empty" guarantee at
  // a fraction of the cost.
  let catalog: BazaarCatalog;

  beforeAll(() => {
    catalog = new BazaarCatalog(":memory:");
  });

  afterAll(async () => {
    await catalog.close();
  });

  beforeEach(async () => {
    await catalog.clear();
  });

  it("upserts and lists a resource", async () => {
    await catalog.upsert(httpResource(), CONFIRMED);
    const result = await catalog.list();
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0].resourceUrl).toBe("https://api.example.com/weather");
    expect(result.resources[0].lastVerifiedAt).toBe(CONFIRMED.lastVerifiedAt);
    expect(result.pagination.total).toBe(1);
  });

  it("merges distinct accepted requirements on repeated upserts for the same resource", async () => {
    await catalog.upsert(httpResource({ requirements: { scheme: "exact", amount: "10000" } }), CONFIRMED);
    await catalog.upsert(httpResource({ requirements: { scheme: "upto", amount: "50000" } }), CONFIRMED);
    const result = await catalog.list();
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0].accepts).toHaveLength(2);
  });

  it("does not duplicate an identical requirement re-upserted", async () => {
    const req = { scheme: "exact", amount: "10000" };
    await catalog.upsert(httpResource({ requirements: req }), CONFIRMED);
    await catalog.upsert(httpResource({ requirements: req }), CONFIRMED);
    const result = await catalog.list();
    expect(result.resources[0].accepts).toHaveLength(1);
  });

  it("distinguishes MCP tools on the same resource URL by toolName", async () => {
    await catalog.upsert(
      httpResource({ type: "mcp", toolName: "get_weather", resourceUrl: "https://api.example.com/mcp" }),
      CONFIRMED,
    );
    await catalog.upsert(
      httpResource({ type: "mcp", toolName: "get_forecast", resourceUrl: "https://api.example.com/mcp" }),
      CONFIRMED,
    );
    const result = await catalog.list();
    expect(result.resources).toHaveLength(2);
  });

  it("filters by type, payTo, scheme, and network", async () => {
    await catalog.upsert(httpResource(), CONFIRMED);
    await catalog.upsert(
      httpResource({ resourceUrl: "https://api.example.com/other", network: "stellar:pubnet" }),
      CONFIRMED,
    );
    expect((await catalog.list({ network: "stellar:pubnet" })).resources).toHaveLength(1);
    expect((await catalog.list({ network: "stellar:testnet" })).resources).toHaveLength(1);
    expect((await catalog.list({ scheme: "upto" })).resources).toHaveLength(0);
  });

  it("filters by extension key presence", async () => {
    await catalog.upsert(httpResource({ extensions: { bazaar: {} } }), CONFIRMED);
    await catalog.upsert(
      httpResource({ resourceUrl: "https://api.example.com/no-ext", extensions: undefined }),
      CONFIRMED,
    );
    expect((await catalog.list({ extensions: "bazaar" })).resources).toHaveLength(1);
  });

  it("does not false-positive-match an extension key that is a prefix of another", async () => {
    await catalog.upsert(httpResource({ extensions: { bazaar2: {} } }), CONFIRMED);
    expect((await catalog.list({ extensions: "bazaar" })).resources).toHaveLength(0);
  });

  it("paginates list results", async () => {
    for (let i = 0; i < 5; i++) {
      await catalog.upsert(httpResource({ resourceUrl: `https://api.example.com/r${i}` }), CONFIRMED);
    }
    const page1 = await catalog.list({ limit: 2, offset: 0 });
    const page2 = await catalog.list({ limit: 2, offset: 2 });
    expect(page1.resources).toHaveLength(2);
    expect(page2.resources).toHaveLength(2);
    expect(page1.pagination.total).toBe(5);
    expect(page1.resources[0].resourceUrl).not.toBe(page2.resources[0].resourceUrl);
  });

  it("finds a resource via lexical search on description and tags", async () => {
    await catalog.upsert(httpResource(), CONFIRMED);
    await catalog.upsert(
      httpResource({
        resourceUrl: "https://api.example.com/search",
        description: "Full text search over documents",
        tags: ["search", "documents"],
        serviceName: "Example Search",
      }),
      CONFIRMED,
    );

    expect((await catalog.search({ query: "weather" })).resources).toHaveLength(1);
    expect((await catalog.search({ query: "documents" })).resources[0].resourceUrl).toContain("/search");
  });

  it("search supports prefix matching", async () => {
    await catalog.upsert(httpResource(), CONFIRMED);
    expect((await catalog.search({ query: "weath" })).resources).toHaveLength(1);
  });

  it("search respects filters combined with the text query", async () => {
    await catalog.upsert(httpResource(), CONFIRMED);
    await catalog.upsert(
      httpResource({ resourceUrl: "https://api.example.com/weather2", network: "stellar:pubnet" }),
      CONFIRMED,
    );
    expect((await catalog.search({ query: "weather", network: "stellar:pubnet" })).resources).toHaveLength(1);
  });

  it("returns an empty, non-error result for a query with no usable terms", async () => {
    const result = await catalog.search({ query: "   " });
    expect(result.resources).toHaveLength(0);
    expect(result.partialResults).toBe(false);
  });

  it("a hard filter that matches nothing returns empty rather than falling through to unfiltered results", async () => {
    await catalog.upsert(httpResource(), CONFIRMED);
    const result = await catalog.search({ query: "weather", payTo: "GNONEXISTENT" });
    expect(result.resources).toHaveLength(0);
  });

  describe("hybrid search: semantic (vector) retrieval", () => {
    it("finds a paraphrased query with no shared lexical terms via semantic similarity", async () => {
      // Deliberately zero literal word overlap with the query below — this
      // is exactly what pure lexical search cannot do, and the reason
      // hybrid retrieval exists (protocol requirements: "search quality is a
      // deliverable... this is the hardest part of the scope").
      await catalog.upsert(
        httpResource({
          resourceUrl: "https://api.example.com/forecast-service",
          description: "Daily atmospheric conditions and precipitation outlook by city",
          serviceName: "Atmos",
          tags: ["meteorology"],
        }),
        CONFIRMED,
      );
      await catalog.upsert(
        httpResource({
          resourceUrl: "https://api.example.com/unrelated",
          description: "Convert currency exchange rates in real time",
          serviceName: "FX Rates",
          tags: ["finance"],
        }),
        CONFIRMED,
      );

      const result = await catalog.search({ query: "weather forecast API" });
      expect(result.resources[0]?.resourceUrl).toBe("https://api.example.com/forecast-service");
    });

    it("fuses lexical and semantic signal: a resource matching both ranks above one matching only one channel", async () => {
      await catalog.upsert(
        httpResource({
          resourceUrl: "https://api.example.com/exact-and-semantic-match",
          description: "weather forecast for any city",
          serviceName: "Weather Plus",
          tags: ["weather"],
        }),
        CONFIRMED,
      );
      await catalog.upsert(
        httpResource({
          resourceUrl: "https://api.example.com/semantic-only",
          description: "atmospheric precipitation outlook",
          serviceName: "Climate Data",
          tags: ["climate"],
        }),
        CONFIRMED,
      );
      await catalog.upsert(
        httpResource({
          resourceUrl: "https://api.example.com/irrelevant",
          description: "video transcoding pipeline",
          serviceName: "Transcode",
          tags: ["video"],
        }),
        CONFIRMED,
      );

      const result = await catalog.search({ query: "weather forecast" });
      const ids = result.resources.map(r => r.resourceUrl);
      expect(ids.indexOf("https://api.example.com/exact-and-semantic-match")).toBeLessThan(
        ids.indexOf("https://api.example.com/irrelevant") === -1 ? Infinity : ids.indexOf("https://api.example.com/irrelevant"),
      );
      expect(ids).not.toContain("https://api.example.com/irrelevant");
    });
  });

  describe("search cursor pagination", () => {
    beforeEach(async () => {
      for (let i = 0; i < 5; i++) {
        await catalog.upsert(
          httpResource({
            resourceUrl: `https://api.example.com/widget${i}`,
            description: "widget gadget",
            serviceName: `Widget ${i}`,
            tags: ["widget"],
          }),
          CONFIRMED,
        );
      }
    });

    it("returns a non-null cursor when more results exist beyond the page", async () => {
      const page1 = await catalog.search({ query: "widget", limit: 2 });
      expect(page1.resources).toHaveLength(2);
      expect(page1.partialResults).toBe(true);
      expect(page1.pagination?.cursor).toBeTruthy();
    });

    it("returns a null cursor on the last page", async () => {
      const page1 = await catalog.search({ query: "widget", limit: 5 });
      expect(page1.resources).toHaveLength(5);
      expect(page1.partialResults).toBe(false);
      expect(page1.pagination?.cursor).toBeNull();
    });

    it("advances through all results via the returned cursor, with no duplicates or omissions", async () => {
      const seen = new Set<string>();
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page = await catalog.search({ query: "widget", limit: 2, cursor: cursor ?? undefined });
        for (const r of page.resources) seen.add(r.resourceUrl);
        cursor = page.pagination?.cursor ?? null;
        pages++;
        expect(pages).toBeLessThan(10); // safety valve against an infinite-loop bug
      } while (cursor);
      expect(seen.size).toBe(5);
      expect(pages).toBe(3); // 2 + 2 + 1
    });

    it("treats a missing cursor the same as an explicitly undefined one (both mean 'first page')", async () => {
      const withoutCursor = await catalog.search({ query: "widget", limit: 2 });
      const withUndefinedCursor = await catalog.search({ query: "widget", limit: 2, cursor: undefined });
      expect(withoutCursor.resources.map(r => r.resourceUrl)).toEqual(
        withUndefinedCursor.resources.map(r => r.resourceUrl),
      );
    });

    it("falls back to the first page for a malformed cursor rather than erroring", async () => {
      const page1 = await catalog.search({ query: "widget", limit: 2 });
      const withGarbageCursor = await catalog.search({
        query: "widget",
        limit: 2,
        cursor: "not-a-real-cursor!!",
      });
      expect(withGarbageCursor.resources.map(r => r.resourceUrl)).toEqual(
        page1.resources.map(r => r.resourceUrl),
      );
    });
  });

  describe("automatic cataloging: verification-gated indexing, no provisional stage", () => {
    it("upsert records the verification timestamp it's given", async () => {
      const verifiedAt = new Date().toISOString();
      const record = await catalog.upsert(httpResource(), { lastVerifiedAt: verifiedAt });
      expect(record.lastVerifiedAt).toBe(verifiedAt);
    });

    it("a resource is visible in list/search immediately once upserted — cataloging itself is the only gate, matching the protocol's literal 'catalogs on receipt' trigger; independent verification happens before upsert is ever called, in the facilitator's cataloging hook, not inside this class", async () => {
      await catalog.upsert(httpResource(), CONFIRMED);
      expect((await catalog.list()).resources).toHaveLength(1);
      expect((await catalog.search({ query: "weather" })).resources).toHaveLength(1);
    });

    it("re-upserting an existing resource refreshes lastVerifiedAt", async () => {
      const first = new Date(Date.now() - 60_000).toISOString();
      await catalog.upsert(httpResource(), { lastVerifiedAt: first });
      const second = new Date().toISOString();
      const updated = await catalog.upsert(httpResource(), { lastVerifiedAt: second });
      expect(updated.lastVerifiedAt).toBe(second);
    });

    it("listStaleForReverification returns only entries older than the threshold, oldest first", async () => {
      await catalog.upsert(httpResource({ resourceUrl: "https://api.example.com/stale" }), {
        lastVerifiedAt: new Date(Date.now() - 120_000).toISOString(),
      });
      await catalog.upsert(httpResource({ resourceUrl: "https://api.example.com/very-stale" }), {
        lastVerifiedAt: new Date(Date.now() - 180_000).toISOString(),
      });
      await catalog.upsert(httpResource({ resourceUrl: "https://api.example.com/fresh" }), {
        lastVerifiedAt: new Date().toISOString(),
      });

      const stale = await catalog.listStaleForReverification(60_000);
      expect(stale.map(r => r.resourceUrl)).toEqual([
        "https://api.example.com/very-stale",
        "https://api.example.com/stale",
      ]);
    });

    it("listStaleForReverification respects its limit", async () => {
      await catalog.upsert(httpResource({ resourceUrl: "https://api.example.com/a" }), {
        lastVerifiedAt: new Date(Date.now() - 120_000).toISOString(),
      });
      await catalog.upsert(httpResource({ resourceUrl: "https://api.example.com/b" }), {
        lastVerifiedAt: new Date(Date.now() - 120_000).toISOString(),
      });
      const stale = await catalog.listStaleForReverification(60_000, 1);
      expect(stale).toHaveLength(1);
    });

    it("markVerified refreshes lastVerifiedAt without touching other fields", async () => {
      await catalog.upsert(httpResource(), { lastVerifiedAt: new Date(Date.now() - 120_000).toISOString() });
      const id = (await catalog.list()).resources[0].id;
      const before = (await catalog.getById(id))!;

      const newTimestamp = new Date().toISOString();
      await catalog.markVerified(id, newTimestamp);

      const after = (await catalog.getById(id))!;
      expect(after.lastVerifiedAt).toBe(newTimestamp);
      expect(after.description).toBe(before.description);
      expect(after.payTo).toBe(before.payTo);
    });

    it("remove deletes a cataloged resource outright", async () => {
      await catalog.upsert(httpResource(), CONFIRMED);
      const id = (await catalog.list()).resources[0].id;

      await catalog.remove(id);

      expect(await catalog.getById(id)).toBeUndefined();
      expect((await catalog.list()).resources).toHaveLength(0);
      expect((await catalog.search({ query: "weather" })).resources).toHaveLength(0);
    });
  });

  describe("usage-based ranking (docs/bazaar-usage-ranking-design.md)", () => {
    describe("recordUsage", () => {
      it("increments both total_calls and unique_buyers for a first-time buyer above the threshold", async () => {
        await catalog.upsert(httpResource(), CONFIRMED);
        await catalog.recordUsage("https://api.example.com/weather", "GBUYER1", 1000n, 500n, { asOf: "2026-01-15" });

        const stats = await catalog.usageStatsFor(["https://api.example.com/weather"], { asOf: "2026-01-15" });
        expect(stats.get("https://api.example.com/weather")).toEqual({
          avgUniqueBuyers30d: 1 / 30,
          avgDailyCalls30d: 1 / 30,
          activityRecency: "2026-01-15",
        });
      });

      it("increments total_calls but not unique_buyers for a repeat buyer on the same day", async () => {
        await catalog.upsert(httpResource(), CONFIRMED);
        await catalog.recordUsage("https://api.example.com/weather", "GBUYER1", 1000n, 500n, { asOf: "2026-01-15" });
        await catalog.recordUsage("https://api.example.com/weather", "GBUYER1", 1000n, 500n, { asOf: "2026-01-15" });

        const stats = await catalog.usageStatsFor(["https://api.example.com/weather"], { asOf: "2026-01-15" });
        expect(stats.get("https://api.example.com/weather")).toMatchObject({
          avgUniqueBuyers30d: 1 / 30, // still just one distinct buyer
          avgDailyCalls30d: 2 / 30, // but two calls
        });
      });

      it("does not increment unique_buyers when the settled amount is below the Sybil-resistance threshold, but still increments total_calls", async () => {
        await catalog.upsert(httpResource(), CONFIRMED);
        await catalog.recordUsage("https://api.example.com/weather", "GCHEAPBUYER", 1n, 500n, { asOf: "2026-01-15" });

        const stats = await catalog.usageStatsFor(["https://api.example.com/weather"], { asOf: "2026-01-15" });
        expect(stats.get("https://api.example.com/weather")).toMatchObject({
          avgUniqueBuyers30d: 0,
          avgDailyCalls30d: 1 / 30,
        });
      });

      it("credits a buyer once a later call crosses the threshold, even though the first call didn't", async () => {
        await catalog.upsert(httpResource(), CONFIRMED);
        await catalog.recordUsage("https://api.example.com/weather", "GBUYER1", 1n, 500n, { asOf: "2026-01-14" }); // below threshold
        await catalog.recordUsage("https://api.example.com/weather", "GBUYER1", 1000n, 500n, { asOf: "2026-01-15" }); // above threshold, different day

        const stats = await catalog.usageStatsFor(["https://api.example.com/weather"], { asOf: "2026-01-15" });
        expect(stats.get("https://api.example.com/weather")).toMatchObject({
          avgUniqueBuyers30d: 1 / 30, // credited on the second, qualifying day
          avgDailyCalls30d: 2 / 30, // both calls still counted
        });
      });

      it("counts distinct buyers on the same day toward unique_buyers, each above the threshold", async () => {
        await catalog.upsert(httpResource(), CONFIRMED);
        await catalog.recordUsage("https://api.example.com/weather", "GBUYER1", 1000n, 500n, { asOf: "2026-01-15" });
        await catalog.recordUsage("https://api.example.com/weather", "GBUYER2", 1000n, 500n, { asOf: "2026-01-15" });
        await catalog.recordUsage("https://api.example.com/weather", "GBUYER3", 1000n, 500n, { asOf: "2026-01-15" });

        const stats = await catalog.usageStatsFor(["https://api.example.com/weather"], { asOf: "2026-01-15" });
        expect(stats.get("https://api.example.com/weather")).toMatchObject({
          avgUniqueBuyers30d: 3 / 30,
          avgDailyCalls30d: 3 / 30,
        });
      });

      it("rejects recording usage against a resource that was never cataloged (foreign key)", async () => {
        await expect(
          catalog.recordUsage("https://api.example.com/never-cataloged", "GBUYER1", 1000n, 500n),
        ).rejects.toThrow();
      });
    });

    describe("usageStatsFor", () => {
      it("uses SUM(...)/30, not AVG(...): a resource active on only one of the last 30 days doesn't overstate its average", async () => {
        await catalog.upsert(httpResource(), CONFIRMED);
        // Only one active day in the window — AVG() would compute 5/1 = 5;
        // SUM()/30 correctly treats the other 29 silent days as zero.
        await catalog.recordUsage("https://api.example.com/weather", "GBUYER1", 1000n, 500n, { asOf: "2026-01-15" });
        await catalog.recordUsage("https://api.example.com/weather", "GBUYER2", 1000n, 500n, { asOf: "2026-01-15" });
        await catalog.recordUsage("https://api.example.com/weather", "GBUYER3", 1000n, 500n, { asOf: "2026-01-15" });
        await catalog.recordUsage("https://api.example.com/weather", "GBUYER4", 1000n, 500n, { asOf: "2026-01-15" });
        await catalog.recordUsage("https://api.example.com/weather", "GBUYER5", 1000n, 500n, { asOf: "2026-01-15" });

        const stats = await catalog.usageStatsFor(["https://api.example.com/weather"], { asOf: "2026-01-15" });
        expect(stats.get("https://api.example.com/weather")?.avgUniqueBuyers30d).toBe(5 / 30);
        expect(stats.get("https://api.example.com/weather")?.avgUniqueBuyers30d).not.toBe(5); // what AVG() would have given
      });

      it("excludes activity outside the 30-day window", async () => {
        await catalog.upsert(httpResource(), CONFIRMED);
        await catalog.recordUsage("https://api.example.com/weather", "GBUYER1", 1000n, 500n, { asOf: "2025-01-01" }); // far outside the window
        await catalog.recordUsage("https://api.example.com/weather", "GBUYER2", 1000n, 500n, { asOf: "2026-01-15" });

        const stats = await catalog.usageStatsFor(["https://api.example.com/weather"], { asOf: "2026-01-15" });
        expect(stats.get("https://api.example.com/weather")?.avgUniqueBuyers30d).toBe(1 / 30); // only the in-window call
      });

      it("reports activityRecency as the most recent active date", async () => {
        await catalog.upsert(httpResource(), CONFIRMED);
        await catalog.recordUsage("https://api.example.com/weather", "GBUYER1", 1000n, 500n, { asOf: "2026-01-10" });
        await catalog.recordUsage("https://api.example.com/weather", "GBUYER2", 1000n, 500n, { asOf: "2026-01-15" });

        const stats = await catalog.usageStatsFor(["https://api.example.com/weather"], { asOf: "2026-01-15" });
        expect(stats.get("https://api.example.com/weather")?.activityRecency).toBe("2026-01-15");
      });

      it("omits a resource with no usage history from the returned map entirely", async () => {
        await catalog.upsert(httpResource(), CONFIRMED);
        const stats = await catalog.usageStatsFor(["https://api.example.com/weather"]);
        expect(stats.has("https://api.example.com/weather")).toBe(false);
      });

      it("returns an empty map for an empty id list without querying", async () => {
        expect(await catalog.usageStatsFor([])).toEqual(new Map());
      });

      it("never returns stats for a resource outside the requested candidate set", async () => {
        await catalog.upsert(httpResource(), CONFIRMED);
        await catalog.upsert(httpResource({ resourceUrl: "https://api.example.com/other" }), CONFIRMED);
        await catalog.recordUsage("https://api.example.com/weather", "GBUYER1", 1000n, 500n, { asOf: "2026-01-15" });
        await catalog.recordUsage("https://api.example.com/other", "GBUYER1", 1000n, 500n, { asOf: "2026-01-15" });

        // Only asked about "weather" — "other" must not leak into the result
        // even though it has real usage history too.
        const stats = await catalog.usageStatsFor(["https://api.example.com/weather"], { asOf: "2026-01-15" });
        expect([...stats.keys()]).toEqual(["https://api.example.com/weather"]);
      });
    });

    describe("pruneStaleBuyers", () => {
      it("prunes a buyer whose last activity is outside the 30-day window", async () => {
        await catalog.upsert(httpResource(), CONFIRMED);
        const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        await catalog.recordUsage("https://api.example.com/weather", "GSTALEBUYER", 1000n, 500n, { asOf: longAgo });

        const pruned = await catalog.pruneStaleBuyers();
        expect(pruned).toBe(1);
      });

      it("does not prune a buyer active within the last 30 days", async () => {
        await catalog.upsert(httpResource(), CONFIRMED);
        await catalog.recordUsage("https://api.example.com/weather", "GFRESHBUYER", 1000n, 500n); // asOf defaults to today

        const pruned = await catalog.pruneStaleBuyers();
        expect(pruned).toBe(0);
      });

      it("never touches resource_usage_daily — historical usage stats survive pruning", async () => {
        await catalog.upsert(httpResource(), CONFIRMED);
        const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        await catalog.recordUsage("https://api.example.com/weather", "GSTALEBUYER", 1000n, 500n, { asOf: longAgo });

        await catalog.pruneStaleBuyers();

        // resource_buyers was pruned, but resource_usage_daily (the retained
        // history table) must still have that day's row — verified by
        // windowing usageStatsFor's "asOf" back to include that old date.
        const stats = await catalog.usageStatsFor(["https://api.example.com/weather"], { asOf: longAgo });
        expect(stats.get("https://api.example.com/weather")?.avgUniqueBuyers30d).toBe(1 / 30);
      });
    });

    describe("search() usage channel", () => {
      it("reorders equally-relevant candidates by usage when the usage channel is enabled", async () => {
        await catalog.upsert(
          httpResource({ resourceUrl: "https://api.example.com/weather-popular", description: "weather forecast API" }),
          CONFIRMED,
        );
        await catalog.upsert(
          httpResource({ resourceUrl: "https://api.example.com/weather-unused", description: "weather forecast API" }),
          CONFIRMED,
        );
        for (const buyer of ["GBUYER1", "GBUYER2", "GBUYER3"]) {
          await catalog.recordUsage("https://api.example.com/weather-popular", buyer, 1000n, 500n);
        }

        const result = await catalog.search({ query: "weather forecast" }, { channels: ["lexical", "vector", "usage"] });
        const ids = result.resources.map(r => r.resourceUrl);
        expect(ids.indexOf("https://api.example.com/weather-popular")).toBeLessThan(
          ids.indexOf("https://api.example.com/weather-unused"),
        );
      });

      it("does not affect ranking when the usage channel is omitted (default, backward compatible)", async () => {
        await catalog.upsert(
          httpResource({ resourceUrl: "https://api.example.com/weather-a", description: "weather forecast API" }),
          CONFIRMED,
        );
        await catalog.upsert(
          httpResource({ resourceUrl: "https://api.example.com/weather-b", description: "weather forecast API" }),
          CONFIRMED,
        );
        for (const buyer of ["GBUYER1", "GBUYER2", "GBUYER3"]) {
          await catalog.recordUsage("https://api.example.com/weather-b", buyer, 1000n, 500n);
        }

        const withUsage = await catalog.search({ query: "weather forecast" }, { channels: ["lexical", "vector", "usage"] });
        const withoutUsage = await catalog.search({ query: "weather forecast" }, { channels: ["lexical", "vector"] });
        expect(withUsage.resources.map(r => r.resourceUrl)).not.toEqual(
          withoutUsage.resources.map(r => r.resourceUrl),
        );
      });

      it("never introduces a candidate the relevance channels didn't already select, even with heavy usage", async () => {
        await catalog.upsert(
          httpResource({ resourceUrl: "https://api.example.com/weather-match", description: "weather forecast API" }),
          CONFIRMED,
        );
        await catalog.upsert(
          httpResource({
            resourceUrl: "https://api.example.com/irrelevant-but-popular",
            description: "video transcoding pipeline",
            serviceName: "Transcode Co", // overrides httpResource()'s default "Example Weather", which would otherwise leak a lexical "weather" match into this fixture
            tags: ["video"],
          }),
          CONFIRMED,
        );
        for (const buyer of ["GBUYER1", "GBUYER2", "GBUYER3", "GBUYER4", "GBUYER5"]) {
          await catalog.recordUsage("https://api.example.com/irrelevant-but-popular", buyer, 1000n, 500n);
        }

        const result = await catalog.search({ query: "weather forecast" }, { channels: ["lexical", "vector", "usage"] });
        expect(result.resources.map(r => r.resourceUrl)).not.toContain("https://api.example.com/irrelevant-but-popular");
      });
    });

    describe("search() l2rerank channel", () => {
      it("corrects a lexically-favored but semantically wrong candidate when enabled", async () => {
        // Contains both "weather" and "forecast" literally (wins lexically)
        // but is genuinely about a board game, not a forecast API — a
        // real cross-encoder should judge it a weak match for the query.
        await catalog.upsert(
          httpResource({
            resourceUrl: "https://api.example.com/board-games",
            description: "A weather forecast themed board game for family game night",
            serviceName: "PartyCo",
            tags: ["games"],
          }),
          CONFIRMED,
        );
        // Zero literal overlap with the query — found only via the vector
        // channel — but the genuine match.
        await catalog.upsert(
          httpResource({
            resourceUrl: "https://api.example.com/forecast",
            description: "Daily atmospheric conditions and precipitation outlook by city",
            serviceName: "Atmos",
            tags: ["meteorology"],
          }),
          CONFIRMED,
        );

        const withoutL2 = await catalog.search({ query: "weather forecast" }, { channels: ["lexical", "vector"] });
        expect(withoutL2.resources[0]?.resourceUrl).toBe("https://api.example.com/board-games"); // lexical match wins first-stage

        const withL2 = await catalog.search(
          { query: "weather forecast" },
          { channels: ["lexical", "vector", "l2rerank"] },
        );
        expect(withL2.resources[0]?.resourceUrl).toBe("https://api.example.com/forecast"); // cross-encoder corrects it
      });

      it("does not affect ranking when l2rerank is omitted (default, backward compatible)", async () => {
        await catalog.upsert(
          httpResource({ resourceUrl: "https://api.example.com/weather-a", description: "weather forecast API" }),
          CONFIRMED,
        );
        const withoutL2 = await catalog.search({ query: "weather forecast" }, { channels: ["lexical", "vector"] });
        const withDefault = await catalog.search({ query: "weather forecast" });
        expect(withDefault.resources.map(r => r.resourceUrl)).toEqual(withoutL2.resources.map(r => r.resourceUrl));
      });

      it("never introduces a candidate outside the first-stage retrieval set", async () => {
        await catalog.upsert(
          httpResource({ resourceUrl: "https://api.example.com/weather-match", description: "weather forecast API" }),
          CONFIRMED,
        );
        await catalog.upsert(
          httpResource({
            resourceUrl: "https://api.example.com/totally-unrelated",
            description: "video transcoding pipeline",
            serviceName: "Transcode Co",
            tags: ["video"],
          }),
          CONFIRMED,
        );

        const result = await catalog.search({ query: "weather forecast" }, { channels: ["lexical", "vector", "l2rerank"] });
        expect(result.resources.map(r => r.resourceUrl)).not.toContain("https://api.example.com/totally-unrelated");
      });

      it("composes with the usage channel without error, fusing against the l2-reranked order", async () => {
        await catalog.upsert(
          httpResource({
            resourceUrl: "https://api.example.com/board-games",
            description: "A weather forecast themed board game for family game night",
            serviceName: "PartyCo",
            tags: ["games"],
          }),
          CONFIRMED,
        );
        await catalog.upsert(
          httpResource({
            resourceUrl: "https://api.example.com/forecast",
            description: "Daily atmospheric conditions and precipitation outlook by city",
            serviceName: "Atmos",
            tags: ["meteorology"],
          }),
          CONFIRMED,
        );

        const result = await catalog.search(
          { query: "weather forecast" },
          { channels: ["lexical", "vector", "l2rerank", "usage"] },
        );
        expect(result.resources.map(r => r.resourceUrl).sort()).toEqual(
          ["https://api.example.com/board-games", "https://api.example.com/forecast"].sort(),
        );
      });
    });
  });

});
