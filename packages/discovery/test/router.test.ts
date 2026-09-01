import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { createDiscoveryRouter } from "../src/router.js";
import type { BazaarCatalog } from "../src/catalog.js";

/**
 * `createDiscoveryRouter` returns a plain Express `Router` — no HTTP server
 * needed to exercise it. Each route's handler is invoked directly (found by
 * walking `router.stack`), with a fake `catalog` dependency and minimal
 * req/res doubles, matching how `catalog`'s own real behavior is already
 * covered by `catalog.test.ts` — this file is only about the router's own
 * query-parsing and pass-through logic.
 */
function handlerFor(router: ReturnType<typeof createDiscoveryRouter>, path: string) {
  const layer = router.stack.find(l => l.route?.path === path);
  if (!layer?.route) throw new Error(`no route registered for ${path}`);
  return layer.route.stack[0].handle as (req: Request, res: Response) => Promise<void>;
}

function fakeReq(query: Record<string, unknown>): Request {
  return { query } as unknown as Request;
}

function fakeRes(): Response & { json: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> } {
  const res = {} as Response & { json: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> };
  res.json = vi.fn().mockReturnValue(res);
  res.status = vi.fn().mockReturnValue(res);
  return res;
}

function fakeCatalog(): BazaarCatalog {
  return {
    list: vi.fn().mockResolvedValue({ resources: [], pagination: { limit: 50, offset: 0, total: 0 } }),
    search: vi.fn().mockResolvedValue({ resources: [], pagination: { cursor: null } }),
  } as unknown as BazaarCatalog;
}

describe("createDiscoveryRouter: GET /resources", () => {
  it("passes string filters through and parses limit/offset as numbers", async () => {
    const catalog = fakeCatalog();
    const router = createDiscoveryRouter(catalog);
    const handler = handlerFor(router, "/resources");
    const res = fakeRes();

    await handler(
      fakeReq({ type: "http", payTo: "GABC", scheme: "exact", network: "stellar:testnet", limit: "10", offset: "5" }),
      res,
    );

    expect(catalog.list).toHaveBeenCalledWith({
      type: "http",
      payTo: "GABC",
      scheme: "exact",
      network: "stellar:testnet",
      extensions: undefined,
      limit: 10,
      offset: 5,
    });
    expect(res.json).toHaveBeenCalledWith({ resources: [], pagination: { limit: 50, offset: 0, total: 0 } });
  });

  it("omits filters that are missing or empty rather than passing empty strings through", async () => {
    const catalog = fakeCatalog();
    const router = createDiscoveryRouter(catalog);
    const handler = handlerFor(router, "/resources");

    await handler(fakeReq({ type: "" }), fakeRes());

    expect(catalog.list).toHaveBeenCalledWith({
      type: undefined,
      payTo: undefined,
      scheme: undefined,
      network: undefined,
      extensions: undefined,
      limit: undefined,
      offset: undefined,
    });
  });

  it("treats a non-numeric limit/offset as absent rather than NaN", async () => {
    const catalog = fakeCatalog();
    const router = createDiscoveryRouter(catalog);
    const handler = handlerFor(router, "/resources");

    await handler(fakeReq({ limit: "not-a-number" }), fakeRes());

    expect(catalog.list).toHaveBeenCalledWith(expect.objectContaining({ limit: undefined }));
  });
});

describe("createDiscoveryRouter: GET /search", () => {
  it("requires a query parameter, returning 400 without calling catalog.search", async () => {
    const catalog = fakeCatalog();
    const router = createDiscoveryRouter(catalog);
    const handler = handlerFor(router, "/search");
    const res = fakeRes();

    await handler(fakeReq({}), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "query parameter is required" });
    expect(catalog.search).not.toHaveBeenCalled();
  });

  it("rejects an empty-string query the same way as a missing one", async () => {
    const catalog = fakeCatalog();
    const router = createDiscoveryRouter(catalog);
    const handler = handlerFor(router, "/search");
    const res = fakeRes();

    await handler(fakeReq({ query: "" }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(catalog.search).not.toHaveBeenCalled();
  });

  it("passes the query and filters through, with the default search channels", async () => {
    const catalog = fakeCatalog();
    const router = createDiscoveryRouter(catalog);
    const handler = handlerFor(router, "/search");

    await handler(fakeReq({ query: "weather", cursor: "abc" }), fakeRes());

    expect(catalog.search).toHaveBeenCalledWith(
      expect.objectContaining({ query: "weather", cursor: "abc" }),
      { channels: ["lexical", "vector", "usage"] },
    );
  });

  it("uses a caller-supplied searchChannels override instead of the default", async () => {
    const catalog = fakeCatalog();
    const router = createDiscoveryRouter(catalog, { searchChannels: ["lexical"] });
    const handler = handlerFor(router, "/search");

    await handler(fakeReq({ query: "weather" }), fakeRes());

    expect(catalog.search).toHaveBeenCalledWith(expect.anything(), { channels: ["lexical"] });
  });
});
