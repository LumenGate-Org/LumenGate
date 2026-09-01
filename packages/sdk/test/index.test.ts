import { describe, expect, it } from "vitest";
import * as sdk from "../src/index.js";

/**
 * The package's public entry point — a smoke test that every advertised
 * export actually exists on the barrel, so a typo or a forgotten `export`
 * line surfaces here rather than only at a consumer's import site.
 */
describe("@x402-stellar/sdk barrel exports", () => {
  it("re-exports every documented value export", () => {
    expect(sdk.createStellarPaymentClient).toBeTypeOf("function");
    expect(sdk.ensureUptoAllowance).toBeTypeOf("function");
    expect(sdk.inspectPaymentRequirements).toBeTypeOf("function");
    expect(sdk.cancelUptoPayment).toBeTypeOf("function");
    expect(sdk.declareStellarResource).toBeTypeOf("function");
    expect(sdk.stellarPaymentOption).toBeTypeOf("function");
  });
});
