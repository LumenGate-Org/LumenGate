import { Router } from "express";
import type { BazaarCatalog } from "./catalog.js";

/**
 * Builds the discovery HTTP endpoints per `specs/extensions/bazaar.md`:
 * `GET /resources` (paginated browse) and `GET /search` (natural-language
 * query, hybrid lexical+semantic ranked). Mount at `/discovery` on the
 * facilitator's Express app.
 *
 * @param catalog - The backing Bazaar catalog
 * @param options.searchChannels - Which `search()` channels this endpoint
 *   uses (default: lexical + vector + usage). Exists so an operator can
 *   disable the usage-ranking channel instantly (docs/bazaar-usage-ranking-design.md
 *   §8's "toggleable off if it misbehaves") without an app-level code
 *   change — see `PORT`-adjacent env vars in `packages/facilitator/src/server.ts`
 *   for how this is actually wired to a runtime setting.
 * @returns An Express router exposing the two discovery endpoints
 */
export function createDiscoveryRouter(
  catalog: BazaarCatalog,
  options: { searchChannels?: ("lexical" | "vector" | "usage")[] } = {},
): Router {
  const router = Router();
  const searchChannels = options.searchChannels ?? ["lexical", "vector", "usage"];

  router.get("/resources", async (req, res) => {
    const { type, payTo, scheme, network, extensions, limit, offset } = req.query;
    const result = await catalog.list({
      type: asString(type),
      payTo: asString(payTo),
      scheme: asString(scheme),
      network: asString(network),
      extensions: asString(extensions),
      limit: asNumber(limit),
      offset: asNumber(offset),
    });
    res.json(result);
  });

  router.get("/search", async (req, res) => {
    const { query, type, payTo, scheme, network, extensions, limit, cursor } = req.query;
    const queryStr = asString(query);
    if (!queryStr) {
      res.status(400).json({ error: "query parameter is required" });
      return;
    }
    const result = await catalog.search(
      {
        query: queryStr,
        type: asString(type),
        payTo: asString(payTo),
        scheme: asString(scheme),
        network: asString(network),
        extensions: asString(extensions),
        limit: asNumber(limit),
        cursor: asString(cursor),
      },
      { channels: searchChannels },
    );
    res.json(result);
  });

  return router;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
