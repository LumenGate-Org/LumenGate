import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { embed, EMBEDDING_DIMENSIONS } from "./embeddings.js";
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
// A provisional (verify-time, not-yet-settled) catalog entry is evicted if
// never confirmed within this window. Generous relative to a typical
// verify->settle round trip (seconds) to tolerate real-world latency and
// retries, but still bounds a spammed/never-settled entry's visibility to
// a fixed window rather than forever — see "Automatic cataloging" below.
export const DEFAULT_PROVISIONAL_TTL_MS = 15 * 60 * 1000;

/**
 * Computes the catalog's unique resource id: `resourceUrl` for HTTP resources,
 * `resourceUrl#toolName` for MCP (per the bazaar spec's note that MCP
 * multiplexes multiple tools over one endpoint, so `resourceUrl` alone isn't
 * a unique key).
 */
function resourceId(input: Pick<DiscoveredResourceInput, "resourceUrl" | "type" | "toolName">): string {
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

  private async getById(id: string): Promise<CatalogResource | undefined> {
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
   * @param filters - Query text plus Bazaar's standard filters
   * @param options - `channels` restricts retrieval to a subset of the two
   *   channels (default both) — not used by the HTTP endpoint, only by
   *   `eval/evaluate.ts` to report a lexical-only baseline alongside the
   *   real hybrid result.
   */
  async search(
    filters: SearchFilters,
    options: { channels?: ("lexical" | "vector")[] } = {},
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
    await this.db.exec(`TRUNCATE resources, pending_catalog;`);
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
