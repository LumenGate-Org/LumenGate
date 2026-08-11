import { describe, expect, it } from "vitest";
import { formatPrometheusMetrics } from "../src/metrics.js";

describe("formatPrometheusMetrics", () => {
  it("returns an empty string for no families", () => {
    expect(formatPrometheusMetrics([])).toBe("");
  });

  it("renders HELP/TYPE headers and an unlabeled sample", () => {
    const text = formatPrometheusMetrics([
      { name: "facilitator_up", help: "Always 1 while the process is running.", type: "gauge", samples: [{ value: 1 }] },
    ]);
    expect(text).toBe(
      "# HELP facilitator_up Always 1 while the process is running.\n" +
        "# TYPE facilitator_up gauge\n" +
        "facilitator_up 1\n",
    );
  });

  it("renders labeled samples", () => {
    const text = formatPrometheusMetrics([
      {
        name: "facilitator_signer_balance_xlm",
        help: "Native XLM balance of a facilitator signer account.",
        type: "gauge",
        samples: [
          { labels: { network: "stellar:testnet", address: "GABC" }, value: 100.5 },
          { labels: { network: "stellar:pubnet", address: "GABC" }, value: 12 },
        ],
      },
    ]);
    expect(text).toBe(
      "# HELP facilitator_signer_balance_xlm Native XLM balance of a facilitator signer account.\n" +
        "# TYPE facilitator_signer_balance_xlm gauge\n" +
        'facilitator_signer_balance_xlm{network="stellar:testnet",address="GABC"} 100.5\n' +
        'facilitator_signer_balance_xlm{network="stellar:pubnet",address="GABC"} 12\n',
    );
  });

  it("renders multiple metric families in order", () => {
    const text = formatPrometheusMetrics([
      { name: "a_total", help: "A.", type: "counter", samples: [{ value: 1 }] },
      { name: "b_total", help: "B.", type: "counter", samples: [{ value: 2 }] },
    ]);
    expect(text.indexOf("a_total")).toBeLessThan(text.indexOf("b_total"));
  });

  it("escapes backslash, double-quote, and newline in label values", () => {
    const text = formatPrometheusMetrics([
      {
        name: "x",
        help: "h",
        type: "gauge",
        samples: [{ labels: { note: 'back\\slash "quote"\nnewline' }, value: 0 }],
      },
    ]);
    expect(text).toContain('note="back\\\\slash \\"quote\\"\\nnewline"');
  });

  it("omits the label block entirely for a sample with no labels", () => {
    const text = formatPrometheusMetrics([
      { name: "x", help: "h", type: "gauge", samples: [{ value: 5 }] },
    ]);
    expect(text).toContain("x 5\n");
    expect(text).not.toContain("x{");
  });
});
