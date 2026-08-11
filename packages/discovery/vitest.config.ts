import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // The embedding model (`src/embeddings.ts`) downloads and loads once,
    // lazily, on the first `upsert`/`search` call in the whole test run —
    // a few seconds on a cold cache. Individual embed calls afterward are
    // fast (tens of ms); this only needs to be generous enough to cover
    // that one-time cost, not every test.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
