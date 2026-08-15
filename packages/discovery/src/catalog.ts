import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { embed, EMBEDDING_DIMENSIONS } from "./embeddings.js";
import { rerank } from "./reranker.js";
import type {
  CatalogResource,
  DiscoveredResourceInput,
  ListFilters,
  ListResult,
  SearchFilters,
  SearchResult,
  UpsertOptions,
} from "./types.js";

const DEFAULT_LIST_LIMIT = 100;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_LIMIT = 200;
// Delimiter-wrapped so `LIKE '%,key,%'` never matches a key that's merely a
// substring of another (e.g. "bazaar" vs "bazaar2").
const EXTENSION_KEY_DELIMITER = ",";
// How many top candidates each retrieval channel (lexical, vector)
// contributes to Reciprocal Rank Fusion before pagination — bounds the cost
// of fusing in application code (see `search()`) at prototype scale; a catalog
// wanting exact fusion over its full result set would need a real search
// engine's query planner, not appropriate to build here.
const RRF_CANDIDATE_POOL_SIZE = 200;
// Standard Reciprocal Rank Fusion constant from Cormack et al. (2009),
// "Reciprocal Rank Fusion outperforms Condorcet and individual Rank
// Learning Methods" — the de facto default used across production hybrid
// search systems (Elasticsearch's RRF retriever and Azure AI Search's
// hybrid ranking both default to it).
const RRF_K = 60;
// Minimum cosine similarity for a vector-channel candidate to count at all
// (pgvector's `<=>` operator returns cosine *distance* = 1 - similarity).
// Without this, a small catalog's nearest-neighbor query ranks every row by
// distance regardless of whether any of them are actually related to the
// query. Measured empirically against Xenova/all-MiniLM-L6-v2 (see
// packages/discovery/eval/): clearly related text pairs scored ~0.45-0.55
// cosine similarity, clearly unrelated pairs scored ~-0.05 to 0.04. 0.15
// sits well below real matches and well above noise.
const MIN_SEMANTIC_SIMILARITY = 0.15;
// L2 semantic reranking (docs/bazaar-usage-ranking-design.md §2.1) only
// re-scores this many top first-stage candidates. Fixed at Azure AI
// Search's own documented hard limit for its L2 semantic ranking ("Even if
// results include more than 50 results, only the top 50 results progress
// to semantic ranking") — adopted verbatim rather than re-deriving a
// cost/quality tradeoff a production system at far larger scale already
// settled.
const L2_RERANK_TOP_K = 50;
// A provisional (verify-time, not-yet-settled) catalog entry is evicted if
// never confirmed within this window. Generous relative to a typical
// verify->settle round trip (seconds) to tolerate real-world latency and
// retries, but still bounds a spammed/never-settled entry's visibility to
// a fixed window rather than forever — see "Automatic cataloging" below.
export const DEFAULT_PROVISIONAL_TTL_MS = 15 * 60 * 1000;
// Usage-based ranking window (see docs/bazaar-usage-ranking-design.md, §5
// "Derived signals" and §6 "Retention"): both the 30-day rolling average
// and the `resource_buyers` retention sweep use the same window.
const USAGE_WINDOW_DAYS = 30;

/** Per-resource usage signals, windowed to the last `USAGE_WINDOW_DAYS` days (see `usageStatsFor`). */
export interface UsageStats {
  avgUniqueBuyers30d: number;
  avgDailyCalls30d: number;
  /** The most recent date (YYYY-MM-DD) this resource was used at all, or `undefined` if never. */
  activityRecency: string | undefined;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `days` before/after (negative) `fromIsoDate` — unlike a `Date.now()`-relative helper, this composes correctly with a test's `asOf` override. */
function offsetDate(fromIsoDate: string, days: number): string {
  const d = new Date(`${fromIsoDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

/**
 * Computes the catalog's unique resource id: `resourceUrl` for HTTP resources,
 * `resourceUrl#toolName` for MCP (per the bazaar spec's note that MCP
 * multiplexes multiple tools over one endpoint, so `resourceUrl` alone isn't
 * a unique key).
 */
export function resourceId(input: Pick<DiscoveredResourceInput, "resourceUrl" | "type" | "toolName">): string {
  return input.type === "mcp" && input.toolName
    ? `${input.resourceUrl}#${input.toolName}`
    : input.resourceUrl;
}

/**
 * The text a resource is searched by — both lexically (Postgres full-text)
 * and semantically (embedding). Kept as one function so the two retrieval
 * channels can never drift into indexing different content for the same
 * resource.
 */
function buildSearchableText(record: Pick<CatalogResource, "resourceUrl" | "description" | "serviceName" | "tags" | "type" | "toolName">): string {
  return [
    record.resourceUrl,
    record.description ?? "",
    record.serviceName ?? "",
    ...(record.tags ?? []),
    record.type,
    record.toolName ?? "",
  ]
    .join(" ")
    .toLowerCase();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromRow(row: any): CatalogResource {
  return {
    id: row.id,
    resourceUrl: row.resource_url,
    type: row.type,
    method: row.method ?? undefined,
    toolName: row.tool_name ?? undefined,
    x402Version: row.x402_version,
    description: row.description ?? undefined,
    mimeType: row.mime_type ?? undefined,
    serviceName: row.service_name ?? undefined,
    tags: row.tags ? JSON.parse(row.tags) : undefined,
    iconUrl: row.icon_url ?? undefined,
    payTo: row.pay_to,
    scheme: row.scheme,
    network: row.network,
    accepts: JSON.parse(row.accepts),
    extensions: row.extensions ? JSON.parse(row.extensions) : undefined,
    lastUpdated: row.last_updated,
    status: row.status,
    provisionalExpiresAt: row.provisional_expires_at ?? undefined,
  };
}

function toVectorLiteral(vec: Float32Array): string {
  return `[${Array.from(vec).join(",")}]`;
}

/**
 * Orders two candidates by `(avgUniqueBuyers30d, avgDailyCalls30d,
 * activityRecency)` descending, each field breaking ties in the previous —
 * §2.2's usage-popularity ordering, most-used first.
 */
function compareUsage(a: UsageStats, b: UsageStats): number {
  if (b.avgUniqueBuyers30d !== a.avgUniqueBuyers30d) return b.avgUniqueBuyers30d - a.avgUniqueBuyers30d;
  if (b.avgDailyCalls30d !== a.avgDailyCalls30d) return b.avgDailyCalls30d - a.avgDailyCalls30d;
  return (b.activityRecency ?? "").localeCompare(a.activityRecency ?? "");
}

/**
 * Hybrid Bazaar discovery catalog, backed by **real PostgreSQL** — via
 * PGlite, a WASM build of Postgres packaged as a library, not a hosted
 * service or a system dependency (see "Why PGlite" below) — with `pgvector`
 * for the semantic channel and Postgres's own full-text search
 * (`tsvector`/`ts_rank`) for the lexical channel, fused via Reciprocal Rank
 * Fusion. Search is a core product surface, and
 * explicitly requires "real ranking" (Section 3.2), which pure lexical
 * matching cannot deliver for paraphrased natural-language queries (e.g.
 * "weather API" should find a resource described only as "forecast
 * service") — this is the same hard-filters-then-lexical-plus-vector-then-fuse
 * shape as Azure AI Search's hybrid ranking, the architecture external
 * validation specifically named.
 *
 * **Why PGlite, not a standalone Postgres server.** external validation asked
 * specifically for PostgreSQL + `pgvector`. A real, separately-run Postgres
 * server was not reachable from this project's original development
 * environment (no root/sudo access to install one, no Docker) — PGlite
 * resolves that without changing the architecture asked for: it *is* a real
 * Postgres build (compiled to WASM), running the actual `pgvector` extension
 * and the actual `tsvector`/`ts_rank` full-text engine, just packaged as an
 * in-process library rather than a server a client connects to over the
 * network. The SQL in this file is standard Postgres SQL; pointing this
 * class at a real standalone Postgres server instead (via `pg`/`node-postgres`
 * with the same connection-string-shaped config real deployments already
 * expect) would need no changes to the queries themselves, only to how the
 * client connection is constructed — see "Scaling path" in
 * `docs/runbook.md` for when that swap is worth making.
 *
 * One instance per facilitator process; PGlite serializes its own access
 * internally, so concurrent calls from one process are safe.
 */
export class BazaarCatalog {
  private readonly db: PGlite;
  private readonly ready: Promise<void>;

  constructor(dbPath: string = ":memory:") {
    this.db = dbPath === ":memory:" ? new PGlite({ extensions: { vector } }) : new PGlite(dbPath, { extensions: { vector } });
    this.ready = this.migrate();
  }

  private async migrate(): Promise<void> {
    await this.db.exec(`CREATE EXTENSION IF NOT EXISTS vector;`);
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS resources (
        id TEXT PRIMARY KEY,
        resource_url TEXT NOT NULL,
        type TEXT NOT NULL,
        method TEXT,
        tool_name TEXT,
        x402_version INTEGER NOT NULL,
        description TEXT,
        mime_type TEXT,
        service_name TEXT,
        tags TEXT,
        icon_url TEXT,
        pay_to TEXT NOT NULL,
        scheme TEXT NOT NULL,
        network TEXT NOT NULL,
        accepts TEXT NOT NULL,
        extensions TEXT,
        extension_keys TEXT,
        last_updated TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'confirmed',
        provisional_expires_at TEXT,
        haystack tsvector,
        embedding vector(${EMBEDDING_DIMENSIONS})
      );
      CREATE INDEX IF NOT EXISTS idx_resources_pay_to ON resources(pay_to);
      CREATE INDEX IF NOT EXISTS idx_resources_scheme ON resources(scheme);
      CREATE INDEX IF NOT EXISTS idx_resources_network ON resources(network);
      CREATE INDEX IF NOT EXISTS idx_resources_type ON resources(type);
      CREATE INDEX IF NOT EXISTS idx_resources_status ON resources(status, provisional_expires_at);
      CREATE INDEX IF NOT EXISTS idx_resources_haystack ON resources USING GIN(haystack);

      -- Durable outbox for crash-safe cataloging (see "Automatic cataloging"
      -- in docs/architecture.md): a settlement's full discovery payload is
      -- written here BEFORE the actual upsert is attempted, and deleted only
      -- once the upsert succeeds. If the process dies in between, the row
      -- survives and a separate reconciler
      -- (packages/facilitator/src/indexer.ts) can find and retry it
      -- independently of the original request/response cycle that created it.
      CREATE TABLE IF NOT EXISTS pending_catalog (
        transaction_hash TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        enqueued_at TEXT NOT NULL
      );

      -- Usage-based ranking (see docs/bazaar-usage-ranking-design.md).
      -- Per-resource, per-day call/unique-buyer counters, retained
      -- indefinitely (§6 — this history is what lets a usage trend be
      -- tracked over time, not just a rolling snapshot).
      CREATE TABLE IF NOT EXISTS resource_usage_daily (
        resource_id TEXT NOT NULL REFERENCES resources(id),
        date DATE NOT NULL,
        total_calls INTEGER NOT NULL DEFAULT 0,
        unique_buyers INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (resource_id, date)
      );
      CREATE INDEX IF NOT EXISTS idx_resource_usage_daily_date ON resource_usage_daily(date);

      -- Tracks each buyer's most recent activity date per resource — the
      -- dedup structure §4's write-path upsert uses to compute a correct
      -- per-day unique count, and the table §6's retention sweep prunes (30
      -- active-day window; unlike resource_usage_daily, this table is NOT
      -- kept indefinitely — its only purpose is answering "who's active
      -- right now").
      CREATE TABLE IF NOT EXISTS resource_buyers (
        resource_id TEXT NOT NULL REFERENCES resources(id),
        buyer TEXT NOT NULL,
        last_seen_date DATE NOT NULL,
        PRIMARY KEY (resource_id, buyer)
      );
      CREATE INDEX IF NOT EXISTS idx_resource_buyers_last_seen ON resource_buyers(last_seen_date);
    `);
    // Forward-compatible schema evolution: Postgres's ADD COLUMN IF NOT
    // EXISTS is natively idempotent (unlike SQLite, which needed a manual
    // PRAGMA table_info check) — safe to run unconditionally on every
    // startup, including against a database created by an earlier version
    // of this schema.
    await this.db.exec(`
      ALTER TABLE resources ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'confirmed';
      ALTER TABLE resources ADD COLUMN IF NOT EXISTS provisional_expires_at TEXT;
    `);
  }

  /**
   * Durably records the intent to catalog `input`, keyed by the settlement's
   * transaction hash, before attempting the actual write.
   */
  async enqueuePending(transactionHash: string, input: DiscoveredResourceInput): Promise<void> {
    await this.ready;
    await this.db.query(
      `INSERT INTO pending_catalog (transaction_hash, payload, enqueued_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (transaction_hash) DO UPDATE SET payload = excluded.payload`,
      [transactionHash, JSON.stringify(input), new Date().toISOString()],
    );
  }

  /**
   * Marks a previously-enqueued pending entry as resolved (cataloging
   * succeeded), removing it from the outbox. A no-op if nothing is pending
   * for this hash.
   */
  async resolvePending(transactionHash: string): Promise<void> {
    await this.ready;
    await this.db.query(`DELETE FROM pending_catalog WHERE transaction_hash = $1`, [transactionHash]);
  }

  /**
   * Lists all not-yet-resolved pending catalog entries, oldest first — for
   * an external reconciler process to retry independently of the original
   * request that enqueued them.
   */
  async listPending(): Promise<{ transactionHash: string; input: DiscoveredResourceInput; enqueuedAt: string }[]> {
    await this.ready;
    const result = await this.db.query<{ transaction_hash: string; payload: string; enqueued_at: string }>(
      `SELECT transaction_hash, payload, enqueued_at FROM pending_catalog ORDER BY enqueued_at ASC`,
    );
    return result.rows.map(row => ({
      transactionHash: row.transaction_hash,
      input: JSON.parse(row.payload) as DiscoveredResourceInput,
      enqueuedAt: row.enqueued_at,
    }));
  }

  /**
   * Inserts or updates a cataloged resource. Callers are responsible for
   * validating/sanitizing `input` first — see `@x402/extensions/bazaar`'s
   * `extractDiscoveryInfo`, `validateDiscoveryExtension`, and
   * `sanitizeResourceServiceMetadata`, which this package deliberately does
   * not re-implement (the facilitator calls those before calling this).
   *
   * `options.status` implements "Automatic cataloging: provisional at
   * receipt, confirmed at settlement" (docs/architecture.md): call with
   * `status: "provisional"` at verify-time (`createBazaarVerifyPvalidationHook`)
   * and `status: "confirmed"` at settle-time (`createBazaarCatalogingHook`),
   * which overwrites any provisional record for the same resource and
   * clears its expiry.
   */
  async upsert(input: DiscoveredResourceInput, options: UpsertOptions): Promise<CatalogResource> {
    await this.ready;
    const id = resourceId(input);
    const now = new Date().toISOString();

    const existing = await this.getById(id);
    let accepts: unknown[] = [input.requirements];
    if (existing) {
      const merged = [...existing.accepts];
      const isDuplicate = merged.some(r => JSON.stringify(r) === JSON.stringify(input.requirements));
      if (!isDuplicate) merged.push(input.requirements);
      accepts = merged;
    }

    const record: CatalogResource = {
      ...input,
      id,
      accepts,
      lastUpdated: now,
      status: options.status,
      provisionalExpiresAt:
        options.status === "provisional"
          ? options.provisionalExpiresAt ?? new Date(Date.now() + DEFAULT_PROVISIONAL_TTL_MS).toISOString()
          : undefined,
    };

    const haystack = buildSearchableText(record);
    const embedding = await embed(haystack);

    await this.db.query(
      `INSERT INTO resources (
         id, resource_url, type, method, tool_name, x402_version, description, mime_type,
         service_name, tags, icon_url, pay_to, scheme, network, accepts, extensions,
         extension_keys, last_updated, status, provisional_expires_at, haystack, embedding
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
         $17, $18, $19, $20, to_tsvector('english', $21), $22
       )
       ON CONFLICT (id) DO UPDATE SET
         resource_url = excluded.resource_url, type = excluded.type, method = excluded.method,
         tool_name = excluded.tool_name, x402_version = excluded.x402_version,
         description = excluded.description, mime_type = excluded.mime_type,
         service_name = excluded.service_name, tags = excluded.tags, icon_url = excluded.icon_url,
         pay_to = excluded.pay_to, scheme = excluded.scheme, network = excluded.network,
         accepts = excluded.accepts, extensions = excluded.extensions,
         extension_keys = excluded.extension_keys, last_updated = excluded.last_updated,
         status = excluded.status, provisional_expires_at = excluded.provisional_expires_at,
         haystack = excluded.haystack, embedding = excluded.embedding`,
      [
        record.id,
        record.resourceUrl,
        record.type,
        record.method ?? null,
        record.toolName ?? null,
        record.x402Version,
        record.description ?? null,
        record.mimeType ?? null,
        record.serviceName ?? null,
        record.tags ? JSON.stringify(record.tags) : null,
        record.iconUrl ?? null,
        record.payTo,
        record.scheme,
        record.network,
        JSON.stringify(record.accepts),
        record.extensions ? JSON.stringify(record.extensions) : null,
        record.extensions
          ? `${EXTENSION_KEY_DELIMITER}${Object.keys(record.extensions).join(EXTENSION_KEY_DELIMITER)}${EXTENSION_KEY_DELIMITER}`
          : null,
        record.lastUpdated,
        record.status,
        record.provisionalExpiresAt ?? null,
        haystack,
        toVectorLiteral(embedding),
      ],
    );

    return record;
  }

  /**
   * Deletes `"provisional"` entries whose `provisionalExpiresAt` has passed
   * without being confirmed by a real settlement. Intended to be called
   * periodically by `packages/facilitator/src/indexer.ts`'s reconciliation
   * loop — not part of the request/response path.
   *
   * @returns The number of evicted entries
   */
  async evictExpiredProvisional(): Promise<number> {
    await this.ready;
    const result = await this.db.query(
      `DELETE FROM resources WHERE status = 'provisional' AND provisional_expires_at < $1 RETURNING id`,
      [new Date().toISOString()],
    );
    return result.rows.length;
  }

  /**
   * Records one settled call against `resourceId` — the write path from
   * docs/bazaar-usage-ranking-design.md §4, one atomic upsert covering both
   * usage tables. `total_calls` increments unconditionally; `unique_buyers`
   * only increments the first time this `(resourceId, buyer)` pair is seen
   * on `asOf`, and only when `settledAmount >= minUniqueBuyerAmount` — the
   * Sybil-resistance gate from §2.3: sponsored network fees make minting
   * distinct addresses free, so counting *every* distinct address toward
   * "unique buyers" would be free to inflate; gating on a real settled
   * amount raises the cost of that back up. This does not eliminate the
   * attack (a funded attacker can still pay the threshold per fake
   * account) — it only removes the free version of it. `total_calls` stays
   * ungated deliberately: it's already the weaker, gameable-by-one-buyer
   * signal `unique_buyers` is the primary sort key specifically to avoid
   * relying on.
   *
   * Callers are responsible for confirming `resourceId` is actually
   * cataloged first (`getById`) — `resource_usage_daily`/`resource_buyers`
   * both have a `REFERENCES resources(id)` foreign key, so recording usage
   * against a resource that was never (or not yet) cataloged fails at the
   * database level rather than silently creating an orphaned row.
   *
   * @param resourceId - The catalog id usage is being recorded against (see `resourceId()`)
   * @param buyer - The address that paid for this call (`SettleResponse.payer`)
   * @param settledAmount - The atomic-unit amount actually settled for this call
   * @param minUniqueBuyerAmount - The `minSettledAmountForUniqueBuyerCredit` threshold (§2.3), in the same atomic units
   * @param options.asOf - Overrides "today" (YYYY-MM-DD) — test seam; real callers omit it
   */
  async recordUsage(
    resourceId: string,
    buyer: string,
    settledAmount: bigint,
    minUniqueBuyerAmount: bigint,
    options: { asOf?: string } = {},
  ): Promise<void> {
    await this.ready;
    const date = options.asOf ?? isoDate(new Date());
    await this.db.query(
      `WITH upsert AS (
         INSERT INTO resource_buyers (resource_id, buyer, last_seen_date)
         VALUES ($1, $2, $5::date)
         ON CONFLICT (resource_id, buyer) DO UPDATE
           SET last_seen_date = EXCLUDED.last_seen_date
         WHERE resource_buyers.last_seen_date IS DISTINCT FROM EXCLUDED.last_seen_date
         RETURNING resource_id
       )
       INSERT INTO resource_usage_daily (resource_id, date, total_calls, unique_buyers)
       VALUES (
         $1, $5::date, 1,
         CASE WHEN $3::numeric >= $4::numeric THEN (SELECT COUNT(*) FROM upsert) ELSE 0 END
       )
       ON CONFLICT (resource_id, date) DO UPDATE SET
         total_calls = resource_usage_daily.total_calls + 1,
         unique_buyers = resource_usage_daily.unique_buyers +
           CASE WHEN $3::numeric >= $4::numeric THEN (SELECT COUNT(*) FROM upsert) ELSE 0 END`,
      [resourceId, buyer, settledAmount.toString(), minUniqueBuyerAmount.toString(), date],
    );
  }

  /**
   * Computes `UsageStats` (§5's derived signals) for exactly the given
   * candidate `ids`, windowed to the last `USAGE_WINDOW_DAYS` days — never
   * a broader set, since `search()`'s usage-ranking pass must only ever
   * reorder within a candidate set the relevance stages already selected
   * (§2.2), never introduce new candidates by querying usage independently.
   * A resource absent from the returned map has no usage history in the
   * window at all (distinct from having zero calls on a day it does have a
   * row for).
   *
   * `SUM(...) / USAGE_WINDOW_DAYS`, not `AVG(...)`: `resource_usage_daily`
   * only has a row on days with actual activity, so `AVG()` would divide by
   * the count of *active* days only, overstating the true 30-day average
   * for anything used on fewer than 30 of the last 30 days — see §5's
   * "Corrected per direct feedback" for the full reasoning.
   *
   * @param ids - The candidate resource ids to compute stats for (typically a search()-stage candidate set)
   * @param options.asOf - Overrides "today" for the window's end — test seam; real callers omit it
   */
  async usageStatsFor(ids: readonly string[], options: { asOf?: string } = {}): Promise<Map<string, UsageStats>> {
    await this.ready;
    const stats = new Map<string, UsageStats>();
    if (ids.length === 0) return stats;

    const asOf = options.asOf ?? isoDate(new Date());
    const windowStart = offsetDate(asOf, -(USAGE_WINDOW_DAYS - 1));
    const placeholders = ids.map((_, i) => `$${i + 3}`).join(", ");
    const result = await this.db.query<{
      resource_id: string;
      avg_unique_buyers_30d: string;
      avg_daily_calls_30d: string;
      // PGlite returns a `DATE` aggregate (`MAX(date)`) as a JS `Date`, not
      // the plain string every other date value in this file is kept as —
      // normalized back to `YYYY-MM-DD` below via `isoDate`, so `UsageStats`
      // has one consistent date representation regardless of driver quirks.
      activity_recency: Date | string;
    }>(
      `SELECT resource_id,
         (SUM(unique_buyers)::numeric / ${USAGE_WINDOW_DAYS}) AS avg_unique_buyers_30d,
         (SUM(total_calls)::numeric / ${USAGE_WINDOW_DAYS}) AS avg_daily_calls_30d,
         MAX(date) AS activity_recency
       FROM resource_usage_daily
       WHERE date BETWEEN $1::date AND $2::date AND resource_id IN (${placeholders})
       GROUP BY resource_id`,
      [windowStart, asOf, ...ids],
    );

    for (const row of result.rows) {
      stats.set(row.resource_id, {
        avgUniqueBuyers30d: Number(row.avg_unique_buyers_30d),
        avgDailyCalls30d: Number(row.avg_daily_calls_30d),
        activityRecency: isoDate(new Date(row.activity_recency)),
      });
    }
    return stats;
  }

  /**
   * Prunes `resource_buyers` rows whose `last_seen_date` has fallen outside
   * the `USAGE_WINDOW_DAYS`-day active window (§6's retention rule) —
   * intended to be called periodically by `packages/facilitator/src/indexer.ts`,
   * the same way `evictExpiredProvisional` is. `resource_usage_daily` is
   * deliberately never pruned here (or anywhere): §6 keeps that table's
   * history indefinitely, since it's what lets a usage trend be tracked
   * over time, not just a rolling snapshot.
   *
   * @returns The number of pruned rows
   */
  async pruneStaleBuyers(): Promise<number> {
    await this.ready;
    const cutoff = offsetDate(isoDate(new Date()), -USAGE_WINDOW_DAYS);
    const result = await this.db.query(`DELETE FROM resource_buyers WHERE last_seen_date < $1::date RETURNING resource_id`, [
      cutoff,
    ]);
    return result.rows.length;
  }

  /**
   * Looks up a resource by its catalog id (see `resourceId`). Public so
   * callers outside this class can check what a resource is *currently*
   * cataloged as before writing a new `upsert` over it — e.g.
   * `createBazaarCatalogingHook`'s resource-ownership check, which needs to
   * know whether a settlement is about to change an already-confirmed
   * resource's `payTo` before that overwrite happens.
   */
  async getById(id: string): Promise<CatalogResource | undefined> {
    const result = await this.db.query(`SELECT * FROM resources WHERE id = $1`, [id]);
    return result.rows.length > 0 ? fromRow(result.rows[0]) : undefined;
  }

  async list(filters: ListFilters = {}): Promise<ListResult> {
    await this.ready;
    const { where, params } = buildWhereClause(filters);
    const limit = clampLimit(filters.limit, DEFAULT_LIST_LIMIT);
    const offset = Math.max(0, filters.offset ?? 0);

    const totalResult = await this.db.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM resources ${where}`,
      params,
    );
    const total = Number(totalResult.rows[0].count);

    const rowsResult = await this.db.query(
      `SELECT * FROM resources ${where} ORDER BY last_updated DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );

    return {
      x402Version: 2,
      resources: rowsResult.rows.map(fromRow),
      pagination: { limit, offset, total },
    };
  }

  /**
   * Hybrid search: Bazaar's hard filters (type/payTo/scheme/network/
   * extensions) applied first, then lexical (Postgres full-text,
   * `ts_rank`) and semantic (`pgvector` cosine similarity) candidates
   * retrieved over that identical filtered set — both channels query the
   * same `resources` table directly, no separate virtual-table/allowed-id
   * reconciliation needed — then fused via Reciprocal Rank Fusion. See the
   * class docs above for the full rationale and "Search quality
   * evaluation" in docs/architecture.md for how this is measured.
   *
   * Two further, optional stages layer on top of that first-stage relevance
   * order, both from docs/bazaar-usage-ranking-design.md and both
   * independently toggleable (§8):
   *
   * - **`"l2rerank"`** (§2.1): a genuine second-stage cross-encoder
   *   (`reranker.ts`) re-scores the top `L2_RERANK_TOP_K` first-stage
   *   candidates against the query, producing a **new, authoritative**
   *   relevance order for just that subset — not blended with the
   *   first-stage RRF scores, since the whole point is an independently
   *   computed judgment, not a recombination of one the first stage
   *   already had. Candidates beyond the top-K keep their first-stage
   *   relative order, trailing behind the reranked ones. Meaningfully more
   *   expensive than everything else in this method (measured ~800ms for
   *   50 candidates on commodity hardware — see §2.1) — off by default,
   *   opt in via `options.channels`.
   * - **`"usage"`** (§2.2): a *second* Reciprocal Rank Fusion pass, fusing
   *   whatever the current relevance order is at this point (the
   *   L2-reranked order if that stage ran, otherwise the first-stage
   *   lexical+vector order) with a usage-popularity order — never
   *   retrieves independently or introduces a candidate the earlier stages
   *   didn't already select, only reorders within that set, by
   *   `(avgUniqueBuyers30d, avgDailyCalls30d, activityRecency)` descending.
   *
   * @param filters - Query text plus Bazaar's standard filters
   * @param options - `channels` restricts retrieval to a subset of channels
   *   (default: lexical + vector only, matching pre-ranking-work behavior —
   *   the HTTP endpoint opts into `"usage"` and optionally `"l2rerank"`
   *   explicitly via `createDiscoveryRouter`'s own option, so both stay
   *   instantly toggleable without an app-level code change);
   *   `eval/evaluate.ts` also uses this to report a lexical-only baseline
   *   alongside the real hybrid result.
   */
  async search(
    filters: SearchFilters,
    options: { channels?: ("lexical" | "vector" | "usage" | "l2rerank")[] } = {},
  ): Promise<SearchResult> {
    await this.ready;
    const channels = options.channels ?? ["lexical", "vector"];
    const trimmedQuery = filters.query.trim();
    if (!trimmedQuery) {
      return { x402Version: 2, resources: [], partialResults: false, pagination: null };
    }

    const { where, params } = buildWhereClause(filters);
    const limit = clampLimit(filters.limit, DEFAULT_SEARCH_LIMIT);
    const offset = decodeCursor(filters.cursor);
    const joinWhere = where ? `${where} AND` : "WHERE";

    // --- Lexical candidates (ts_rank, higher = more relevant). ---
    const lexicalRanks = new Map<string, number>();
    const tsQuery = toTsQuery(trimmedQuery);
    if (channels.includes("lexical") && tsQuery) {
      const p = [...params, tsQuery];
      const rows = await this.db.query<{ id: string }>(
        `SELECT id FROM resources
         ${joinWhere} haystack @@ to_tsquery('english', $${p.length})
         ORDER BY ts_rank(haystack, to_tsquery('english', $${p.length})) DESC
         LIMIT ${RRF_CANDIDATE_POOL_SIZE}`,
        p,
      );
      rows.rows.forEach((row, i) => lexicalRanks.set(row.id, i + 1));
    }

    // --- Semantic candidates (cosine distance = 1 - similarity, lower =
    // more similar), same hard-filtered universe as the lexical query. A
    // `MIN_SEMANTIC_SIMILARITY` floor excludes candidates the model itself
    // considers unrelated — see that constant's doc comment. ---
    const vectorRanks = new Map<string, number>();
    if (channels.includes("vector")) {
      const queryEmbedding = toVectorLiteral(await embed(trimmedQuery));
      const maxDistance = 1 - MIN_SEMANTIC_SIMILARITY;
      const p = [...params, queryEmbedding, maxDistance];
      const rows = await this.db.query<{ id: string }>(
        `SELECT id FROM resources
         ${joinWhere} embedding IS NOT NULL AND (embedding <=> $${p.length - 1}) <= $${p.length}
         ORDER BY embedding <=> $${p.length - 1}
         LIMIT ${RRF_CANDIDATE_POOL_SIZE}`,
        p,
      );
      rows.rows.forEach((row, i) => vectorRanks.set(row.id, i + 1));
    }

    // --- Reciprocal Rank Fusion: score(d) = sum over each ranking d
    // appears in of 1 / (RRF_K + rank). A document only one channel found
    // still scores (partial credit), just lower than one both agree on. ---
    const fusedScores = new Map<string, number>();
    for (const [id, rank] of lexicalRanks) {
      fusedScores.set(id, (fusedScores.get(id) ?? 0) + 1 / (RRF_K + rank));
    }
    for (const [id, rank] of vectorRanks) {
      fusedScores.set(id, (fusedScores.get(id) ?? 0) + 1 / (RRF_K + rank));
    }

    // --- L2 semantic reranking (§2.1): for the top-K first-stage
    // candidates only, REPLACES (not blends with) their score above with a
    // fresh one derived purely from the cross-encoder's own rank —
    // "producing the authoritative relevance order for those candidates,"
    // literally, not a recombination of the first-stage lexical/vector
    // score they walked in with. Candidates outside the top-K are left
    // exactly as the first-stage RRF scored them. ---
    if (channels.includes("l2rerank") && fusedScores.size > 0) {
      await this.applyL2Rerank(trimmedQuery, fusedScores);
    }

    // --- Usage as a second RRF pass (§2.2): added directly on top of
    // whatever's in `fusedScores` at this point (first-stage lexical+vector,
    // with the top-K possibly L2-replaced) — the same "just another
    // RRF channel" shape the first pass already uses, deliberately not
    // collapsed into a single win-or-lose relevance rank first. That
    // distinction matters empirically, not just stylistically: a
    // candidate two first-stage channels agree on already carries roughly
    // double the score of a single-channel match, and preserving that
    // margin is what keeps usage — itself only ever one more bounded
    // channel — from casually overturning a strong relevance consensus.
    // An earlier version of this method collapsed first-stage scores into
    // one relevance rank before fusing usage, giving usage equal footing
    // with the *entire* first-stage result regardless of how many channels
    // had agreed on it; `eval/evaluate-usage-ranking.ts` caught this
    // directly — Recall@1 dropped from 0.949 to 0.615 against synthetic,
    // query-uncorrelated usage data, a real regression, not a rounding
    // difference. Reverted to this additive-channel shape and re-verified:
    // see that eval script's own output for the current numbers. ---
    if (channels.includes("usage") && fusedScores.size > 0) {
      const candidateIds = [...fusedScores.keys()];
      const usageStats = await this.usageStatsFor(candidateIds);
      const usageOrder = candidateIds
        .filter(id => usageStats.has(id))
        .sort((a, b) => compareUsage(usageStats.get(a)!, usageStats.get(b)!));
      usageOrder.forEach((id, i) => {
        fusedScores.set(id, (fusedScores.get(id) ?? 0) + 1 / (RRF_K + i + 1));
      });
    }

    const fusedOrder = [...fusedScores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);

    const partialResults = fusedOrder.length > offset + limit;
    const pageIds = fusedOrder.slice(offset, offset + limit);
    const nextCursor = partialResults ? encodeCursor(offset + limit) : null;

    if (pageIds.length === 0) {
      return { x402Version: 2, resources: [], partialResults, pagination: { limit, cursor: nextCursor } };
    }

    const placeholders = pageIds.map((_, i) => `$${i + 1}`).join(", ");
    const rowsResult = await this.db.query(`SELECT * FROM resources WHERE id IN (${placeholders})`, pageIds);
    const byId = new Map(rowsResult.rows.map(row => [(row as { id: string }).id, fromRow(row)]));
    const orderedResources = pageIds.map(id => byId.get(id)).filter((r): r is CatalogResource => r !== undefined);

    return {
      x402Version: 2,
      resources: orderedResources,
      partialResults,
      pagination: { limit, cursor: nextCursor },
    };
  }

  /**
   * §2.1's L2 semantic reranking: re-scores the top `L2_RERANK_TOP_K`
   * candidates currently in `fusedScores` (by their existing score,
   * descending) against `query` via a real cross-encoder (`reranker.ts`),
   * then **replaces** each one's entry in `fusedScores` with a fresh score
   * derived purely from its new cross-encoder rank — mutates the map
   * in place rather than returning a new structure, since "replace, don't
   * blend" only makes sense as an in-place overwrite of the same score
   * space usage's RRF pass reads from afterward. Candidates outside the
   * top-K are left with their original first-stage score, untouched.
   *
   * The text fed to the reranker is the same combined searchable text the
   * lexical/vector channels already index (`buildSearchableText`), not a
   * new text-assembly pipeline — matching the design's "candidate text
   * should be the resource's existing text, not arbitrary unbounded
   * content."
   */
  private async applyL2Rerank(query: string, fusedScores: Map<string, number>): Promise<void> {
    const order = [...fusedScores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    const topK = order.slice(0, L2_RERANK_TOP_K);
    if (topK.length === 0) return;

    const placeholders = topK.map((_, i) => `$${i + 1}`).join(", ");
    const rowsResult = await this.db.query<{
      id: string;
      resource_url: string;
      description: string | null;
      service_name: string | null;
      tags: string | null;
      type: "http" | "mcp";
      tool_name: string | null;
    }>(
      `SELECT id, resource_url, description, service_name, tags, type, tool_name
       FROM resources WHERE id IN (${placeholders})`,
      topK,
    );

    const candidates = rowsResult.rows.map(row => ({
      id: row.id,
      text: buildSearchableText({
        resourceUrl: row.resource_url,
        description: row.description ?? undefined,
        serviceName: row.service_name ?? undefined,
        tags: row.tags ? (JSON.parse(row.tags) as string[]) : undefined,
        type: row.type,
        toolName: row.tool_name ?? undefined,
      }),
    }));

    const scores = await rerank(query, candidates);
    const rerankedTopK = [...topK].sort((a, b) => (scores.get(b) ?? -Infinity) - (scores.get(a) ?? -Infinity));
    rerankedTopK.forEach((id, i) => fusedScores.set(id, 1 / (RRF_K + i + 1)));
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  /**
   * Empties both tables without dropping/recreating them. Not used by the
   * facilitator or indexer — exists so tests can reuse a single PGlite
   * instance across many cases (a fresh `new BazaarCatalog()` per test
   * pays real WASM/cluster-init cost, seconds rather than the near-zero
   * cost a fresh in-memory SQLite database used to have) instead of
   * constructing a new one for every test.
   */
  async clear(): Promise<void> {
    await this.ready;
    await this.db.exec(`TRUNCATE resources, pending_catalog, resource_usage_daily, resource_buyers;`);
  }
}

function clampLimit(requested: number | undefined, fallback: number): number {
  if (!requested || requested <= 0) return fallback;
  return Math.min(requested, MAX_LIMIT);
}

const CURSOR_PREFIX = "off1:";

/**
 * Encodes a page offset as an opaque cursor token. Deliberately simple
 * (offset-based over the fused ranking, not true keyset pagination): the
 * fused score is computed per-request from two live retrieval channels, not
 * a single stored, indexed column. The tradeoff this accepts: a page
 * boundary can shift if resources are inserted between two calls (same
 * class of limitation `list()`'s `offset` param already has).
 */
function encodeCursor(offset: number): string {
  return Buffer.from(`${CURSOR_PREFIX}${offset}`, "utf8").toString("base64url");
}

/**
 * Decodes a cursor token produced by `encodeCursor`. A missing, malformed,
 * or tampered-with cursor is treated leniently as "start from the
 * beginning" (offset `0`) rather than rejected.
 */
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    if (!decoded.startsWith(CURSOR_PREFIX)) return 0;
    const offset = Number(decoded.slice(CURSOR_PREFIX.length));
    return Number.isInteger(offset) && offset >= 0 ? offset : 0;
  } catch {
    return 0;
  }
}

function buildWhereClause(
  filters: Pick<ListFilters, "type" | "payTo" | "scheme" | "network" | "extensions">,
): { where: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];

  if (filters.type) {
    params.push(filters.type);
    clauses.push(`type = $${params.length}`);
  }
  if (filters.payTo) {
    params.push(filters.payTo);
    clauses.push(`pay_to = $${params.length}`);
  }
  if (filters.scheme) {
    params.push(filters.scheme);
    clauses.push(`scheme = $${params.length}`);
  }
  if (filters.network) {
    params.push(filters.network);
    clauses.push(`network = $${params.length}`);
  }
  if (filters.extensions) {
    params.push(`%${EXTENSION_KEY_DELIMITER}${filters.extensions}${EXTENSION_KEY_DELIMITER}%`);
    clauses.push(`extension_keys LIKE $${params.length}`);
  }

  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

/**
 * Converts a free-text query into a Postgres `to_tsquery` expression: each
 * word becomes a prefix term (`word:*`) ANDed together, so "weather san"
 * matches documents containing both a word starting with "weather" and one
 * starting with "san" — the same AND-of-prefix-terms semantics the prior
 * SQLite FTS5 implementation used.
 */
function toTsQuery(query: string): string | null {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(term => `${term}:*`);
  return terms.length ? terms.join(" & ") : null;
}
