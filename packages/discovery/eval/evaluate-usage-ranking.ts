/**
 * Usage-ranking eval scenario (docs/bazaar-usage-ranking-design.md §7): the
 * harness-level validation that section originally flagged as missing —
 * "whether the usage signal itself is doing its job correctly," measured
 * with Recall@k/NDCG@k the same way `evaluate.ts` compares hybrid vs.
 * lexical-only, not just the unit-level "two equally relevant resources"
 * test in `catalog.test.ts`.
 *
 * Reuses the same 12-resource, 13-query labeled fixture `evaluate.ts` uses,
 * layering **synthetic, deterministic usage data** on top — real usage
 * isn't part of this fixture (a resource catalog, not a settlement log), so
 * this is necessarily synthetic, same as it would be for any harness
 * measuring a signal with no organic data source in a seed fixture.
 *
 * Two questions this answers, both against the *same* synthetic dataset:
 *
 * 1. **Non-regression.** Half the seed resources (alternating, by fixture
 *    order — deliberately *not* chosen based on which query they're
 *    relevant to) get moderate usage from 5 distinct buyers, well above the
 *    default Sybil-resistance threshold. This is the realistic shape of
 *    real usage data: catalog-wide, not query-specific, so most
 *    query/usage pairings are incidental, not correlated. Does enabling the
 *    usage channel corrupt relevance quality when a query's ground-truth
 *    resource has no special usage advantage over its usage-boosted
 *    competitors? RRF's bounded per-channel contribution (§2.2 — max
 *    `1/(RRF_K+1) ≈ 0.0164`) is the mechanism that's supposed to prevent
 *    this; this measures whether that bound actually holds in practice
 *    against the real search pipeline, not just as a claim about the
 *    formula.
 * 2. **Positive signal.** One query's ground-truth resource is additionally
 *    given heavy usage (10 distinct buyers, the fixture's maximum). Since
 *    the baseline hybrid result is already near-ceiling (Recall@1 0.949 —
 *    see `evaluate.ts`), there's limited room to show improvement on an
 *    already-correct top-1 answer; the check that matters here is that
 *    usage doesn't *demote* a resource that both channels already agree
 *    is genuinely relevant.
 *
 * Usage: `pnpm eval:usage-ranking` (from packages/discovery)
 */
import { BazaarCatalog, resourceId } from "../src/catalog.js";
import type { DiscoveredResourceInput } from "../src/types.js";
import resourcesFixture from "./resources.json" with { type: "json" };
import queriesFixture from "./queries.json" with { type: "json" };

const K_VALUES = [1, 3, 5, 10];
// Well above DEFAULT_MIN_SETTLED_AMOUNT_FOR_UNIQUE_BUYER_CREDIT (1000n
// atomic units) so every synthetic buyer actually counts.
const SETTLED_AMOUNT = 100_000n;
const SYBIL_THRESHOLD = 1_000n;
const MODERATE_USAGE_BUYERS = ["GBUYER1", "GBUYER2", "GBUYER3", "GBUYER4", "GBUYER5"];
const HEAVY_USAGE_BUYERS = [...MODERATE_USAGE_BUYERS, "GBUYER6", "GBUYER7", "GBUYER8", "GBUYER9", "GBUYER10"];
// The query whose ground-truth resource gets the heavy-usage positive-signal boost.
const POSITIVE_SIGNAL_QUERY = "weather forecast API";

interface LabeledQuery {
  query: string;
  relevantResourceUrls: string[];
  note?: string;
}

function recallAtK(retrievedIds: string[], relevantIds: Set<string>, k: number): number {
  if (relevantIds.size === 0) return 1;
  const topK = new Set(retrievedIds.slice(0, k));
  let found = 0;
  for (const id of relevantIds) if (topK.has(id)) found++;
  return found / relevantIds.size;
}

function ndcgAtK(retrievedIds: string[], relevantIds: Set<string>, k: number): number {
  if (relevantIds.size === 0) return 1;
  let dcg = 0;
  for (let i = 0; i < Math.min(k, retrievedIds.length); i++) {
    const rel = relevantIds.has(retrievedIds[i]) ? 1 : 0;
    dcg += rel / Math.log2(i + 2);
  }
  const idealRelevantCount = Math.min(k, relevantIds.size);
  let idcg = 0;
  for (let i = 0; i < idealRelevantCount; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 1 : dcg / idcg;
}

async function main(): Promise<void> {
  const catalog = new BazaarCatalog(":memory:");
  const resources = resourcesFixture as DiscoveredResourceInput[];

  console.log(`Loading ${resources.length} seed resources...`);
  for (const resource of resources) {
    await catalog.upsert(resource, { lastVerifiedAt: new Date().toISOString() });
  }

  const queries = queriesFixture as LabeledQuery[];
  const positiveSignalResourceUrl = queries.find(q => q.query === POSITIVE_SIGNAL_QUERY)?.relevantResourceUrls[0];

  console.log("\nLayering synthetic usage data (deterministic, query-uncorrelated)...");
  let boosted = 0;
  for (const [i, resource] of resources.entries()) {
    const id = resourceId(resource);
    const isPositiveSignalResource = id === positiveSignalResourceUrl;
    const buyers = isPositiveSignalResource
      ? HEAVY_USAGE_BUYERS
      : i % 2 === 0
        ? MODERATE_USAGE_BUYERS
        : [];
    for (const buyer of buyers) {
      await catalog.recordUsage(id, buyer, SETTLED_AMOUNT, SYBIL_THRESHOLD);
    }
    if (buyers.length > 0) boosted++;
  }
  console.log(
    `${boosted}/${resources.length} resources given synthetic usage ` +
      `(1 with heavy/positive-signal usage, ${boosted - 1} with moderate/uncorrelated usage).`,
  );

  const withUsageResults: { query: string; recall: Record<number, number>; ndcg: Record<number, number> }[] = [];
  const withoutUsageResults: typeof withUsageResults = [];

  console.log(`\nRunning ${queries.length} labeled queries (hybrid+usage, then hybrid without usage)...\n`);
  for (const labeled of queries) {
    const relevantIds = new Set(labeled.relevantResourceUrls);

    const withUsage = await catalog.search({ query: labeled.query, limit: 20 }, { channels: ["lexical", "vector", "usage"] });
    const withUsageIds = withUsage.resources.map(r => r.resourceUrl);
    const withoutUsage = await catalog.search({ query: labeled.query, limit: 20 }, { channels: ["lexical", "vector"] });
    const withoutUsageIds = withoutUsage.resources.map(r => r.resourceUrl);

    const withUsageMetrics = { recall: {} as Record<number, number>, ndcg: {} as Record<number, number> };
    const withoutUsageMetrics = { recall: {} as Record<number, number>, ndcg: {} as Record<number, number> };
    for (const k of K_VALUES) {
      withUsageMetrics.recall[k] = recallAtK(withUsageIds, relevantIds, k);
      withUsageMetrics.ndcg[k] = ndcgAtK(withUsageIds, relevantIds, k);
      withoutUsageMetrics.recall[k] = recallAtK(withoutUsageIds, relevantIds, k);
      withoutUsageMetrics.ndcg[k] = ndcgAtK(withoutUsageIds, relevantIds, k);
    }
    withUsageResults.push({ query: labeled.query, ...withUsageMetrics });
    withoutUsageResults.push({ query: labeled.query, ...withoutUsageMetrics });

    const changed = withUsageIds[0] !== withoutUsageIds[0];
    const flag = labeled.query === POSITIVE_SIGNAL_QUERY ? " (positive-signal query)" : "";
    console.log(
      `"${labeled.query}"${flag} — top-1 ${changed ? "CHANGED" : "unchanged"} ` +
        `(without usage: ${withoutUsageIds[0] ?? "(none)"}; with usage: ${withUsageIds[0] ?? "(none)"})`,
    );
  }

  function printAverages(label: string, results: typeof withUsageResults): void {
    console.log(`\n=== ${label} ===`);
    console.log("k   | Recall@k | NDCG@k");
    console.log("----|----------|-------");
    for (const k of K_VALUES) {
      const avgRecall = results.reduce((sum, r) => sum + r.recall[k], 0) / results.length;
      const avgNdcg = results.reduce((sum, r) => sum + r.ndcg[k], 0) / results.length;
      console.log(`${String(k).padEnd(3)} | ${avgRecall.toFixed(3).padEnd(8)} | ${avgNdcg.toFixed(3)}`);
    }
  }

  printAverages("With usage channel + synthetic usage data", withUsageResults);
  printAverages("Without usage channel (hybrid relevance only, same synthetic data ignored)", withoutUsageResults);

  catalog.close();
}

main().catch(err => {
  console.error("Evaluation failed:", err);
  process.exit(1);
});
