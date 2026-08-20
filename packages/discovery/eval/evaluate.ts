/**
 * Search-quality evaluation harness.
 *
 * Loads a seed catalog (`resources.json`) and a labeled set of
 * natural-language queries with manually-identified ground-truth relevant
 * resources (`queries.json`), runs each query through the real hybrid
 * search implementation (`BazaarCatalog.search`), and reports two standard
 * information-retrieval metrics per query and averaged:
 *
 * - **Recall@k**: of all the resources actually relevant to a query, what
 *   fraction appear somewhere in the top k results? Measures completeness —
 *   are we finding what's out there.
 * - **NDCG@k** (Normalized Discounted Cumulative Gain): of the results we
 *   did return, are the relevant ones ranked near the top? Measures
 *   ordering quality, not just presence — a search that finds the right
 *   resource but buries it at position 15 scores well on Recall but poorly
 *   on NDCG.
 *
 * This seed set (12 resources, 13 queries) is a starting point, not a
 * claim of statistical rigor — explicitly designed to be maintained and
 * expanded by the community (add entries to `queries.json`/`resources.json`
 * in the same shape; no code changes needed). About half the queries are
 * deliberately paraphrased with zero literal word overlap against their
 * relevant resource's description, specifically to measure whether
 * semantic (vector) retrieval is pulling its weight, not just lexical
 * (Postgres full-text/`ts_rank`) matching — see each query's `note` field
 * in `queries.json`.
 *
 * Usage: `pnpm eval:search` (from packages/discovery)
 */
import { BazaarCatalog } from "../src/catalog.js";
import type { DiscoveredResourceInput } from "../src/types.js";
import resourcesFixture from "./resources.json" with { type: "json" };
import queriesFixture from "./queries.json" with { type: "json" };

const K_VALUES = [1, 3, 5, 10];

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
    dcg += rel / Math.log2(i + 2); // i+2: position is 1-indexed, log2(1+1)=1 at rank 1
  }
  const idealRelevantCount = Math.min(k, relevantIds.size);
  let idcg = 0;
  for (let i = 0; i < idealRelevantCount; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 1 : dcg / idcg;
}

async function main(): Promise<void> {
  const catalog = new BazaarCatalog(":memory:");

  console.log(`Loading ${resourcesFixture.length} seed resources...`);
  for (const resource of resourcesFixture as DiscoveredResourceInput[]) {
    await catalog.upsert(resource, { lastVerifiedAt: new Date().toISOString() });
  }

  const queries = queriesFixture as LabeledQuery[];
  const perQueryResults: {
    query: string;
    recall: Record<number, number>;
    ndcg: Record<number, number>;
  }[] = [];

  const lexicalOnlyResults: typeof perQueryResults = [];

  console.log(`\nRunning ${queries.length} labeled queries (hybrid, then lexical-only baseline)...\n`);
  for (const labeled of queries) {
    const relevantIds = new Set(labeled.relevantResourceUrls);

    const hybrid = await catalog.search({ query: labeled.query, limit: 20 });
    const hybridIds = hybrid.resources.map(r => r.resourceUrl);
    const lexicalOnly = await catalog.search({ query: labeled.query, limit: 20 }, { channels: ["lexical"] });
    const lexicalOnlyIds = lexicalOnly.resources.map(r => r.resourceUrl);

    const hybridMetrics = { recall: {} as Record<number, number>, ndcg: {} as Record<number, number> };
    const lexicalMetrics = { recall: {} as Record<number, number>, ndcg: {} as Record<number, number> };
    for (const k of K_VALUES) {
      hybridMetrics.recall[k] = recallAtK(hybridIds, relevantIds, k);
      hybridMetrics.ndcg[k] = ndcgAtK(hybridIds, relevantIds, k);
      lexicalMetrics.recall[k] = recallAtK(lexicalOnlyIds, relevantIds, k);
      lexicalMetrics.ndcg[k] = ndcgAtK(lexicalOnlyIds, relevantIds, k);
    }
    perQueryResults.push({ query: labeled.query, ...hybridMetrics });
    lexicalOnlyResults.push({ query: labeled.query, ...lexicalMetrics });

    const hybridTop = hybridIds[0] ?? "(none)";
    const lexicalTop = lexicalOnlyIds[0] ?? "(none)";
    const hybridHit = relevantIds.has(hybridIds[0]) ? "✅" : "❌";
    const lexicalHit = relevantIds.has(lexicalOnlyIds[0]) ? "✅" : "❌";
    console.log(`"${labeled.query}"`);
    console.log(`   hybrid   ${hybridHit} top=${hybridTop}`);
    console.log(`   lexical  ${lexicalHit} top=${lexicalTop}`);
  }

  function printAverages(label: string, results: typeof perQueryResults): void {
    console.log(`\n=== ${label} ===`);
    console.log("k   | Recall@k | NDCG@k");
    console.log("----|----------|-------");
    for (const k of K_VALUES) {
      const avgRecall = results.reduce((sum, r) => sum + r.recall[k], 0) / results.length;
      const avgNdcg = results.reduce((sum, r) => sum + r.ndcg[k], 0) / results.length;
      console.log(`${String(k).padEnd(3)} | ${avgRecall.toFixed(3).padEnd(8)} | ${avgNdcg.toFixed(3)}`);
    }
  }

  printAverages("Hybrid (lexical + semantic, RRF-fused) — the shipped default", perQueryResults);
  printAverages("Lexical-only baseline (Postgres full-text/ts_rank, no vector channel)", lexicalOnlyResults);

  catalog.close();
}

main().catch(err => {
  console.error("Evaluation failed:", err);
  process.exit(1);
});
