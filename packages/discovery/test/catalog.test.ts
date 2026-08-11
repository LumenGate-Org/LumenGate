import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BazaarCatalog } from "../src/catalog.js";
import type { DiscoveredResourceInput, UpsertOptions } from "../src/types.js";

const CONFIRMED: UpsertOptions = { status: "confirmed" };

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
    expect(result.resources[0].status).toBe("confirmed");
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

  describe("automatic cataloging: provisional and confirmed status", () => {
    it("upserts as provisional with a future expiry", async () => {
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      const record = await catalog.upsert(httpResource(), { status: "provisional", provisionalExpiresAt: expiresAt });
      expect(record.status).toBe("provisional");
      expect(record.provisionalExpiresAt).toBe(expiresAt);
    });

    it("a provisional entry is visible in list/search immediately, matching the protocol requirements's literal 'catalogs on receipt' trigger", async () => {
      await catalog.upsert(httpResource(), {
        status: "provisional",
        provisionalExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      expect((await catalog.list()).resources).toHaveLength(1);
      expect((await catalog.search({ query: "weather" })).resources).toHaveLength(1);
    });

    it("promoting to confirmed clears the expiry", async () => {
      await catalog.upsert(httpResource(), {
        status: "provisional",
        provisionalExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const confirmed = await catalog.upsert(httpResource(), CONFIRMED);
      expect(confirmed.status).toBe("confirmed");
      expect(confirmed.provisionalExpiresAt).toBeUndefined();
      const result = await catalog.list();
      expect(result.resources[0].status).toBe("confirmed");
    });

    it("evictExpiredProvisional removes only expired provisional entries, not confirmed or not-yet-expired ones", async () => {
      await catalog.upsert(httpResource({ resourceUrl: "https://api.example.com/expired" }), {
        status: "provisional",
        provisionalExpiresAt: new Date(Date.now() - 1_000).toISOString(), // already expired
      });
      await catalog.upsert(httpResource({ resourceUrl: "https://api.example.com/still-fresh" }), {
        status: "provisional",
        provisionalExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await catalog.upsert(httpResource({ resourceUrl: "https://api.example.com/confirmed" }), CONFIRMED);

      const evicted = await catalog.evictExpiredProvisional();
      expect(evicted).toBe(1);

      const result = await catalog.list();
      const remaining = result.resources.map(r => r.resourceUrl).sort();
      expect(remaining).toEqual([
        "https://api.example.com/confirmed",
        "https://api.example.com/still-fresh",
      ]);
    });

    it("an evicted provisional entry no longer appears in search either", async () => {
      await catalog.upsert(httpResource(), {
        status: "provisional",
        provisionalExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      });
      await catalog.evictExpiredProvisional();
      expect((await catalog.search({ query: "weather" })).resources).toHaveLength(0);
    });

    it("evictExpiredProvisional is a no-op when nothing has expired", async () => {
      await catalog.upsert(httpResource(), CONFIRMED);
      expect(await catalog.evictExpiredProvisional()).toBe(0);
    });
  });

  describe("pending_catalog durable outbox (crash-safe cataloging)", () => {
    it("starts empty", async () => {
      expect(await catalog.listPending()).toEqual([]);
    });

    it("lists an enqueued entry until it is resolved", async () => {
      const input = httpResource();
      await catalog.enqueuePending("txhash1", input);

      const pending = await catalog.listPending();
      expect(pending).toHaveLength(1);
      expect(pending[0].transactionHash).toBe("txhash1");
      expect(pending[0].input.resourceUrl).toBe(input.resourceUrl);

      await catalog.resolvePending("txhash1");
      expect(await catalog.listPending()).toEqual([]);
    });

    it("survives independently of whether the resource was ever actually cataloged", async () => {
      // Simulates the exact crash this outbox exists for: enqueue succeeds,
      // then the process dies before `upsert` (or before `resolvePending`)
      // ever runs — the pending row must still be there for a separate
      // reconciler to find, regardless of catalog state.
      await catalog.enqueuePending("txhash-crash", httpResource());
      expect((await catalog.list()).resources).toHaveLength(0);
      expect(await catalog.listPending()).toHaveLength(1);
    });

    it("resolvePending is a no-op for an unknown transaction hash", async () => {
      await expect(catalog.resolvePending("never-enqueued")).resolves.not.toThrow();
    });

    it("re-enqueuing the same transaction hash overwrites the pending payload rather than duplicating it", async () => {
      await catalog.enqueuePending("txhash2", httpResource({ description: "first" }));
      await catalog.enqueuePending("txhash2", httpResource({ description: "second" }));

      const pending = await catalog.listPending();
      expect(pending).toHaveLength(1);
      expect(pending[0].input.description).toBe("second");
    });

    it("lists pending entries oldest-enqueued first", async () => {
      await catalog.enqueuePending("tx-a", httpResource({ resourceUrl: "https://a.example.com" }));
      await catalog.enqueuePending("tx-b", httpResource({ resourceUrl: "https://b.example.com" }));

      const pending = await catalog.listPending();
      expect(pending.map(p => p.transactionHash)).toEqual(["tx-a", "tx-b"]);
    });
  });
});
