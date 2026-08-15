import { describe, expect, it } from "vitest";
import { rerank } from "../src/reranker.js";

describe("rerank", () => {
  it("returns an empty map for no candidates, without loading the model", async () => {
    const scores = await rerank("weather forecast", []);
    expect(scores).toEqual(new Map());
  });

  it("scores a genuinely matching candidate clearly higher than unrelated ones", async () => {
    const scores = await rerank("weather forecast for a city", [
      { id: "weather", text: "Daily atmospheric conditions and precipitation outlook by city" },
      { id: "translate", text: "Translate text between languages in real time" },
      { id: "stocks", text: "Get real-time stock quotes and market data" },
    ]);

    expect(scores.size).toBe(3);
    const weatherScore = scores.get("weather")!;
    const translateScore = scores.get("translate")!;
    const stocksScore = scores.get("stocks")!;
    // A real, wide separation — not just "slightly higher" — is what a
    // working cross-encoder should produce here (see the design doc's own
    // live-verified numbers, docs/bazaar-usage-ranking-design.md §2.1).
    expect(weatherScore).toBeGreaterThan(translateScore + 5);
    expect(weatherScore).toBeGreaterThan(stocksScore + 5);
  });

  it("returns one score per candidate id, preserving all ids even with duplicate text", async () => {
    const scores = await rerank("weather", [
      { id: "a", text: "weather forecast" },
      { id: "b", text: "weather forecast" },
    ]);
    expect([...scores.keys()].sort()).toEqual(["a", "b"]);
  });
});
