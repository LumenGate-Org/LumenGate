/**
 * Minimal Prometheus text-exposition formatting (see
 * https://prometheus.io/docs/instrumenting/exposition_formats/), hand-rolled
 * rather than a client library dependency — the actual formatting is a few
 * lines of string joining, and this project already tends to prefer that
 * over a new dependency for something this small. Deliberately just the
 * formatting: what to measure and how to gather it lives in `server.ts`,
 * which isn't unit-tested (bootstrap/wiring code, matching the rest of this
 * file's role) — this module exists so *that* part is.
 */

export interface MetricSample {
  /** Label values for this sample, e.g. `{ network: "stellar:testnet" }`. Omit for an unlabeled metric. */
  labels?: Record<string, string>;
  value: number;
}

export interface MetricFamily {
  /** Prometheus metric name — should already be snake_case with a unit suffix where relevant. */
  name: string;
  help: string;
  type: "gauge" | "counter";
  samples: MetricSample[];
}

/**
 * Escapes a label value per the Prometheus text format's rules for the
 * label-value string within double quotes: backslash, double-quote, and
 * newline are the only characters requiring escaping.
 *
 * @param value - Raw label value
 * @returns Escaped label value, safe to place between `"..."`
 */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function formatLabels(labels: Record<string, string> | undefined): string {
  if (!labels || Object.keys(labels).length === 0) return "";
  const parts = Object.entries(labels).map(([key, value]) => `${key}="${escapeLabelValue(value)}"`);
  return `{${parts.join(",")}}`;
}

/**
 * Renders metric families as Prometheus text-exposition format, ready to
 * return as the body of `GET /metrics` with `Content-Type: text/plain;
 * version=0.0.4`.
 *
 * @param families - The metric families to render, in order
 * @returns The full exposition-format text body (trailing newline included)
 */
export function formatPrometheusMetrics(families: readonly MetricFamily[]): string {
  const lines: string[] = [];
  for (const family of families) {
    lines.push(`# HELP ${family.name} ${family.help}`);
    lines.push(`# TYPE ${family.name} ${family.type}`);
    for (const sample of family.samples) {
      lines.push(`${family.name}${formatLabels(sample.labels)} ${sample.value}`);
    }
  }
  return lines.length > 0 ? lines.join("\n") + "\n" : "";
}
