import "dotenv/config";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BazaarCatalog, DEFAULT_REVERIFICATION_INTERVAL_MS } from "@x402-stellar/discovery";
import type { PaymentRequirements } from "@x402/core/types";
import { verifyResourceOwnership } from "./resource-ownership.js";

/**
 * Decoupled reconciler for the Bazaar catalog. Two independent jobs, both
 * genuinely separate from the facilitator's request/response path (a
 * separate process, a separate deploy, a cron job):
 *
 * 1. **Periodic re-verification.** Cataloging (`createBazaarCatalogingHook`
 *    in `discovery-hooks.ts`) already independently verifies a resource's
 *    actual payment information before indexing it — but only at the
 *    moment a discovery-enabled `PaymentPayload` is received. A resource's
 *    operator could change its `payTo`/pricing at any later point, and
 *    nobody might resubmit discovery metadata for it again soon enough to
 *    catch that drift. This job re-runs the same `verifyResourceOwnership`
 *    check against already-cataloged resources whose verification has gone
 *    stale (`BazaarCatalog.listStaleForReverification`), independently of
 *    any particular buyer's request: still matching keeps the entry (just
 *    refreshing `lastVerifiedAt`), no-longer-matching removes it — a stale,
 *    inaccurate listing is worse than no listing. See "Automatic
 *    cataloging" in docs/architecture.md.
 *
 * 2. **Stale-buyer retention** (docs/bazaar-usage-ranking-design.md §6).
 *    `resource_buyers` — the dedup structure usage-ranking's write path
 *    uses to compute a correct per-day unique-buyer count — is pruned to a
 *    30-day active window; unlike `resource_usage_daily` (kept indefinitely,
 *    since that history is what lets a usage trend be tracked over time),
 *    this table's only purpose is answering "who's active right now," so
 *    unbounded growth here buys nothing. Reuses this same reconciliation
 *    loop rather than a new scheduling mechanism.
 *
 * Usage:
 *   pnpm indexer          # runs continuously, reconciling every INDEXER_INTERVAL_MS
 *   pnpm indexer:once      # single pass, for a cron-triggered deployment, then exits
 */

const DISCOVERY_DB_PATH = process.env.DISCOVERY_DB_PATH ?? "./data/discovery.db";
const INTERVAL_MS = Number(process.env.INDEXER_INTERVAL_MS ?? 30_000);
const REVERIFICATION_INTERVAL_MS = Number(
  process.env.DISCOVERY_REVERIFICATION_INTERVAL_MS ?? DEFAULT_REVERIFICATION_INTERVAL_MS,
);
const REVERIFICATION_BATCH_SIZE = Number(process.env.DISCOVERY_REVERIFICATION_BATCH_SIZE ?? 100);
const RUN_ONCE = process.argv.includes("--once");

if (DISCOVERY_DB_PATH !== ":memory:") mkdirSync(dirname(DISCOVERY_DB_PATH), { recursive: true });
const catalog = new BazaarCatalog(DISCOVERY_DB_PATH);

async function reverifyStaleResources(): Promise<{ checked: number; refreshed: number; removed: number }> {
  const stale = await catalog.listStaleForReverification(REVERIFICATION_INTERVAL_MS, REVERIFICATION_BATCH_SIZE);
  let refreshed = 0;
  let removed = 0;

  for (const resource of stale) {
    try {
      const ownership = await verifyResourceOwnership({
        resourceUrl: resource.resourceUrl,
        type: resource.type,
        method: resource.method,
        toolName: resource.toolName,
        payTo: resource.payTo,
        // The most recently accepted requirements — same shape
        // `verifyResourceOwnership` already expects from live cataloging.
        requirements: resource.accepts[resource.accepts.length - 1] as PaymentRequirements,
      });

      if (ownership.outcome === "failed") {
        await catalog.remove(resource.id);
        removed++;
        console.warn(
          `[indexer] removed ${resource.resourceUrl} on re-verification: ${ownership.reason}`,
        );
      } else {
        await catalog.markVerified(resource.id);
        refreshed++;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[indexer] re-verification errored for ${resource.resourceUrl}: ${reason}`);
    }
  }

  return { checked: stale.length, refreshed, removed };
}

async function runOnce(): Promise<void> {
  const { checked, refreshed, removed } = await reverifyStaleResources();
  if (checked === 0) {
    console.info("[indexer] no stale catalog entries due for re-verification");
  } else {
    console.info(`[indexer] re-verified ${checked} entries: ${refreshed} refreshed, ${removed} removed`);
  }

  const pruned = await catalog.pruneStaleBuyers();
  if (pruned > 0) {
    console.info(`[indexer] pruned ${pruned} stale resource_buyers rows (outside the 30-day active window)`);
  }
}

if (RUN_ONCE) {
  await runOnce();
  await catalog.close();
} else {
  console.info(`[indexer] starting, reconciling every ${INTERVAL_MS}ms against ${DISCOVERY_DB_PATH}`);
  await runOnce();
  setInterval(() => {
    runOnce().catch(error => console.error("[indexer] reconciliation pass failed:", error));
  }, INTERVAL_MS);
}
