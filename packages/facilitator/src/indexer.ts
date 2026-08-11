import "dotenv/config";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BazaarCatalog } from "@x402-stellar/discovery";

/**
 * Decoupled reconciler for the Bazaar catalog. Two independent jobs, both
 * genuinely separate from the facilitator's request/response path (a
 * separate process, a separate deploy, a cron job):
 *
 * 1. **Pending-outbox reconciliation** (`pending_catalog` in
 *    `packages/discovery/src/catalog.ts`). A settlement's cataloging
 *    normally happens inline, synchronously, inside the same
 *    `onAfterSettle` hook that reports success back to the caller
 *    (`createBazaarCatalogingHook` in `discovery-hooks.ts`) — fast, and
 *    correct in the overwhelmingly common case. But if the facilitator
 *    process dies in the narrow window between a settlement confirming
 *    on-chain and that hook's `upsert` call completing, the resource would
 *    previously stay permanently un-confirmed with nothing to notice or
 *    retry — a real gap flagged in external validation and documented in
 *    docs/architecture.md. This does NOT reach into the blockchain
 *    directly to reconstruct missing settlements from scratch — the full
 *    discovery metadata a catalog entry needs (service name, description,
 *    tags, route template) only ever existed off-chain, in the
 *    `PaymentPayload` the resource server sent over HTTP; it was never
 *    part of the on-chain `settle()` call, so no amount of chain-watching
 *    alone could recover it. The durable outbox is what makes that
 *    metadata survivable across a crash instead.
 *
 * 2. **Provisional-entry eviction.** Resources cataloged at verify-time
 *    (`status: "provisional"`, see `createBazaarVerifyPvalidationHook`) that
 *    are never confirmed by a real settlement are evicted once their TTL
 *    passes — bounding a validated-but-never-settled catalog entry's
 *    visibility instead of leaving it indefinitely, per "Automatic
 *    cataloging: provisional at receipt, confirmed at settlement" in
 *    docs/architecture.md.
 *
 * Usage:
 *   pnpm indexer          # runs continuously, reconciling every INDEXER_INTERVAL_MS
 *   pnpm indexer:once      # single pass, for a cron-triggered deployment, then exits
 */

const DISCOVERY_DB_PATH = process.env.DISCOVERY_DB_PATH ?? "./data/discovery.db";
const INTERVAL_MS = Number(process.env.INDEXER_INTERVAL_MS ?? 30_000);
const RUN_ONCE = process.argv.includes("--once");

if (DISCOVERY_DB_PATH !== ":memory:") mkdirSync(dirname(DISCOVERY_DB_PATH), { recursive: true });
const catalog = new BazaarCatalog(DISCOVERY_DB_PATH);

async function reconcilePendingOutbox(): Promise<{ retried: number; resolved: number; stillFailing: number }> {
  const pending = await catalog.listPending();
  let resolved = 0;
  let stillFailing = 0;

  for (const entry of pending) {
    try {
      // Everything in the pending outbox was enqueued by
      // `createBazaarCatalogingHook` at settle-time — always `"confirmed"`,
      // never provisional (verify-time cataloging writes directly, with no
      // outbox, since losing an unconfirmed provisional entry is harmless).
      await catalog.upsert(entry.input, { status: "confirmed" });
      await catalog.resolvePending(entry.transactionHash);
      resolved++;
      console.info(
        `[indexer] recovered pending catalog entry for tx ${entry.transactionHash} ` +
          `(enqueued ${entry.enqueuedAt}, resource ${entry.input.resourceUrl})`,
      );
    } catch (error) {
      stillFailing++;
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[indexer] retry failed for tx ${entry.transactionHash}: ${reason}`);
    }
  }

  return { retried: pending.length, resolved, stillFailing };
}

async function runOnce(): Promise<void> {
  const { retried, resolved, stillFailing } = await reconcilePendingOutbox();
  if (retried === 0) {
    console.info("[indexer] no pending catalog entries — nothing to reconcile");
  } else {
    console.info(`[indexer] reconciled ${resolved}/${retried} pending entries (${stillFailing} still failing)`);
  }

  const evicted = await catalog.evictExpiredProvisional();
  if (evicted > 0) {
    console.info(`[indexer] evicted ${evicted} expired provisional (never-settled) catalog entries`);
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
