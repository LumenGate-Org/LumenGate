import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // discovery-hooks.test.ts exercises real BazaarCatalog.upsert(), which
    // loads a local embedding model once, lazily, on first use, and
    // resource-ownership.test.ts's first real query pays PGlite's own
    // WASM cold-start cost — both a few seconds on a warm cache, up to
    // ~40s on a cold one. See packages/discovery/vitest.config.ts.
    testTimeout: 45_000,
    hookTimeout: 45_000,
  },
});
