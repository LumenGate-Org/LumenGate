import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // The embedding model (`src/embeddings.ts`) downloads and loads once,
    // lazily, on the first `upsert`/`search` call in the whole test run,
    // and PGlite pays its own WASM cold-start cost on the same first call —
    // together up to ~40s on a cold cache. Individual calls afterward are
    // fast (tens of ms); this only needs to be generous enough to cover
    // that one-time cost, not every test. See packages/facilitator/vitest.config.ts.
    testTimeout: 45_000,
    hookTimeout: 45_000,
  },
});
