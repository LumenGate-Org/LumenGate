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
   * ISO timestamp of the last time this resource's actual payment
   * information (payTo/pricing) was independently verified against its
   * live source — the resource's own 402 response for HTTP, the identified
   * MCP resource/tool's payment metadata for MCP — rather than merely
   * accepted from a submitted discovery payload. Every insert or update
   * sets this at write time (cataloging is gated on that verification
   * succeeding — see "Automatic cataloging" in docs/architecture.md); it is
   * also refreshed by periodic re-verification
   * (`listStaleForReverification`) so pricing/payTo drift is caught even
   * for a resource nobody has resubmitted discovery metadata for recently.
   */
  lastVerifiedAt: string;
}

/** Options controlling how `BazaarCatalog.upsert` records a resource. */
export interface UpsertOptions {
  /** ISO timestamp this upsert's independent verification completed at. */
  lastVerifiedAt: string;
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
