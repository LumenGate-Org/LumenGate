import { describe, expect, it } from "vitest";
import { buildQuery } from "../src/query.js";

describe("buildQuery", () => {
  it("encodes defined params", () => {
    expect(buildQuery({ query: "weather", limit: 10 })).toBe("query=weather&limit=10");
  });

  it("omits undefined params entirely, rather than stringifying them", () => {
    expect(buildQuery({ query: "weather", type: undefined })).toBe("query=weather");
  });

  it("returns an empty string when all params are undefined", () => {
    expect(buildQuery({ a: undefined, b: undefined })).toBe("");
  });

  it("URL-encodes special characters", () => {
    expect(buildQuery({ query: "a b&c" })).toBe("query=a+b%26c");
  });
});
