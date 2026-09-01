import { describe, expect, it } from "vitest";
import * as discovery from "../src/index.js";

/** Smoke test for the package's public barrel — see the equivalent test in
 * `packages/sdk` for why this exists. */
describe("@x402-stellar/discovery barrel exports", () => {
  it("re-exports every documented value export", () => {
    expect(discovery.BazaarCatalog).toBeTypeOf("function");
    expect(discovery.resourceId).toBeTypeOf("function");
    expect(discovery.DEFAULT_REVERIFICATION_INTERVAL_MS).toBeTypeOf("number");
    expect(discovery.createDiscoveryRouter).toBeTypeOf("function");
    expect(discovery.EXTENSION_RESPONSES_HEADER).toBe("EXTENSION-RESPONSES");
    expect(discovery.encodeBazaarExtensionResponse).toBeTypeOf("function");
    expect(discovery.embed).toBeTypeOf("function");
    expect(discovery.warmUpEmbeddings).toBeTypeOf("function");
    expect(discovery.EMBEDDING_DIMENSIONS).toBeTypeOf("number");
  });
});
