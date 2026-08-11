import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // discovery-hooks.test.ts exercises real BazaarCatalog.upsert(), which
    // loads a local embedding model once, lazily, on first use — a few
    // seconds on a cold cache. See packages/discovery/vitest.config.ts.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
