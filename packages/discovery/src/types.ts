/**
 * Input to `BazaarCatalog.upsert`, derived from `@x402/extensions/bazaar`'s
 * `extractDiscoveryInfo(...)` result plus the `PaymentRequirements` that were
 * just verified/settled for this resource.
 */
export interface DiscoveredResourceInput {
  resourceUrl: string;
  type: "http" | "mcp";
  method?: string;
  toolName?: string;
  x402Version: number;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
  payTo: string;
  scheme: string;
  network: string;
  /** The full `PaymentRequirements` accepted for this resource (stored as-is). */
  requirements: unknown;
  extensions?: Record<string, unknown>;
}

/** A cataloged resource as stored and returned by the discovery endpoints. */
export interface CatalogResource {
  id: string;
  resourceUrl: string;
  type: "http" | "mcp";
  method?: string;
  toolName?: string;
  x402Version: number;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
  payTo: string;
  scheme: string;
  network: string;
  accepts: unknown[];
  extensions?: Record<string, unknown>;
  lastUpdated: string;
  /**
   * `"provisional"`: cataloged on a validated `PaymentPayload` receipt
   * (verify-time), per protocol cataloging trigger (Section 3.2:
   * "when the facilitator receives a PaymentPayload... it validates info
   * against the supplied schema and catalogs the resource"), before any
   * settlement has happened. Bounded-lifetime (see `provisionalExpiresAt`)
   * and evicted if never confirmed. `"confirmed"`: promoted at settle-time
   * once a real settlement succeeded — permanent, no expiry. See "Automatic
   * cataloging: provisional at receipt, confirmed at settlement" in
   * docs/architecture.md for the full rationale.
   */
  status: "provisional" | "confirmed";
  /** ISO timestamp after which a `"provisional"` entry is evicted if never confirmed. `undefined` for `"confirmed"` entries. */
  provisionalExpiresAt?: string;
}

/** Options controlling how `BazaarCatalog.upsert` records a resource. */
export interface UpsertOptions {
  status: "provisional" | "confirmed";
  /** Required when `status` is `"provisional"`; ignored for `"confirmed"`. */
  provisionalExpiresAt?: string;
}

export interface ListFilters {
  type?: string;
  payTo?: string;
  scheme?: string;
  network?: string;
  extensions?: string;
  limit?: number;
  offset?: number;
}

export interface SearchFilters extends Omit<ListFilters, "offset"> {
  query: string;
  cursor?: string;
}

export interface ListResult {
  x402Version: number;
  resources: CatalogResource[];
  pagination: { limit: number; offset: number; total: number };
}

export interface SearchResult {
  x402Version: number;
  resources: CatalogResource[];
  partialResults: boolean;
  pagination: { limit: number; cursor: string | null } | null;
}
