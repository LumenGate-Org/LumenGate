import { describe, expect, it } from "vitest";
import { encodeBazaarExtensionResponse } from "../src/extension-responses.js";

function decode(header: string): unknown {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
}

describe("encodeBazaarExtensionResponse", () => {
  it("encodes a success status with no rejectedReason field", () => {
    const header = encodeBazaarExtensionResponse("success");
    expect(decode(header)).toEqual({ bazaar: { status: "success" } });
  });

  it("encodes a processing status", () => {
    const header = encodeBazaarExtensionResponse("processing");
    expect(decode(header)).toEqual({ bazaar: { status: "processing" } });
  });

  it("includes rejectedReason when status is rejected and a reason is given", () => {
    const header = encodeBazaarExtensionResponse("rejected", "resource-ownership check failed");
    expect(decode(header)).toEqual({
      bazaar: { status: "rejected", rejectedReason: "resource-ownership check failed" },
    });
  });

  it("omits rejectedReason when status is rejected but no reason is given", () => {
    const header = encodeBazaarExtensionResponse("rejected");
    expect(decode(header)).toEqual({ bazaar: { status: "rejected" } });
  });

  it("ignores a rejectedReason passed for a non-rejected status", () => {
    const header = encodeBazaarExtensionResponse("success", "should be ignored");
    expect(decode(header)).toEqual({ bazaar: { status: "success" } });
  });

  it("produces valid base64 that round-trips through JSON", () => {
    const header = encodeBazaarExtensionResponse("rejected", "a \"quoted\" reason with unicode: café");
    expect(() => decode(header)).not.toThrow();
    expect((decode(header) as { bazaar: { rejectedReason: string } }).bazaar.rejectedReason).toBe(
      'a "quoted" reason with unicode: café',
    );
  });
});
