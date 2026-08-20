import { lookup as dnsLookup } from "node:dns/promises";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * The catalog is keyed by `resourceUrl` (see `resourceId` in
 * `@x402-stellar/discovery`), so `BazaarCatalog.upsert` for a resource that's
 * already cataloged **overwrites** its `payTo`, `description`, `serviceName`,
 * and `tags` — see the `ON CONFLICT (id) DO UPDATE SET` in
 * `packages/discovery/src/catalog.ts`. `resourceUrl`, `payTo`, and every
 * other catalog field ultimately come from `PaymentPayload.accepted`, which
 * is *client*-supplied (see `extractCatalogInput` in `discovery-hooks.ts`) —
 * nothing before this module confirmed the client claiming a given
 * `resourceUrl` has anything to do with whoever actually runs it.
 *
 * Concretely: anyone can settle a real (even self-dealt, trivial-amount)
 * payment against this facilitator's public routes while claiming
 * `resourceUrl: "https://someone-elses-real-api.example.com/paid"` with
 * `payTo` set to their own address and an enticing `description`/`tags` —
 * and, since `upsert` overwrites by URL, silently take over that resource's
 * real catalog entry. A live call still pays whoever the resource's *actual*
 * 402 challenge names (this doesn't redirect funds), but the catalog itself
 * — search results, a browsing agent's view of "who gets paid for this" —
 * would be lying until the next legitimate settlement corrects it, and if
 * the real seller is inactive that could persist indefinitely.
 *
 * This module closes that: before an HTTP resource's catalog entry is
 * allowed to change `payTo` under an existing id, re-fetch the resource's
 * *own*, live 402 challenge directly and confirm it actually names the same
 * `payTo` the settlement is about to catalog. A URL-squatter has no way to
 * make someone else's server answer with their address — only the
 * legitimate operator of `resourceUrl` can pass this check.
 */

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);
const OWNERSHIP_CHECK_TIMEOUT_MS = 5_000;

function bareHostname(url: string): string {
  return new URL(url).hostname.replace(/^\[|\]$/g, "");
}

function isSecureUrl(url: string): boolean {
  return new URL(url).protocol === "https:" || LOOPBACK_HOSTNAMES.has(bareHostname(url));
}

function isPrivateIpAddress(ip: string): boolean {
  const ipv4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  return /^f[cd][0-9a-f]{0,2}:/i.test(ip) || /^fe[89ab][0-9a-f]:/i.test(ip);
}

function isPrivateNetworkHost(url: string): boolean {
  return isPrivateIpAddress(bareHostname(url));
}

async function resolvesToPrivateNetwork(url: string): Promise<boolean> {
  try {
    const addresses = await dnsLookup(bareHostname(url), { all: true, verbatim: true });
    return addresses.some(({ address }) => isPrivateIpAddress(address));
  } catch {
    return false;
  }
}

export type OwnershipCheckResult =
  | { outcome: "verified" }
  | { outcome: "skipped"; reason: string }
  | { outcome: "failed"; reason: string };

/** The subset of `extractCatalogInput`'s output this check needs. */
export interface OwnershipCheckInput {
  resourceUrl: string;
  type: "http" | "mcp";
  method?: string;
  /** Required for `type: "mcp"`; identifies which tool on `resourceUrl`'s MCP server is being catalogued. */
  toolName?: string;
  payTo: string;
  requirements: PaymentRequirements;
}

/**
 * Independently verifies a resource's actual payment information before it
 * is allowed into (or to change an existing entry in) the Bazaar catalog.
 * HTTP and MCP resources follow the same rule — neither is indexed on
 * submitted discovery metadata alone — dispatching to
 * `verifyHttpResourceOwnership`/`verifyMcpResourceOwnership` below for the
 * transport-specific mechanics.
 *
 * @param input - The resourceUrl/payTo/requirements a catalog write is about to record
 * @returns Whether the live resource confirms this `payTo`, or why the check didn't run/pass
 */
export async function verifyResourceOwnership(input: OwnershipCheckInput): Promise<OwnershipCheckResult> {
  if (input.type === "mcp") return verifyMcpResourceOwnership(input);
  return verifyHttpResourceOwnership(input);
}

/**
 * Re-fetches `input.resourceUrl` directly (unauthenticated — the whole point
 * of a 402 challenge is that it's visible without paying) and checks whether
 * the resource's own live `accepts` list contains a requirement matching
 * `requirements`' scheme/network/asset whose `payTo` agrees with `input.payTo`.
 *
 * Deliberately conservative — the same SSRF posture as
 * `packages/mcp-discovery-server/src/guardrails.ts` (HTTPS-only off
 * loopback, private/link-local hosts blocked including via DNS resolution,
 * no redirects followed, bounded timeout) since this is an *outbound*
 * request this server makes on its own initiative, to a URL a client chose.
 * Duplicated rather than imported: that module is a client-side (agent)
 * guard shipped in a different package with a different deployment
 * lifecycle; this is a server-side check with no reason to depend on it.
 *
 * Fails closed: any error, timeout, non-402 response, or missing/mismatched
 * requirement is `"failed"`, never treated as an implicit pass.
 */
async function verifyHttpResourceOwnership(input: OwnershipCheckInput): Promise<OwnershipCheckResult> {
  let url: URL;
  try {
    url = new URL(input.resourceUrl);
  } catch {
    return { outcome: "failed", reason: "resourceUrl is not a valid URL" };
  }

  if (!isSecureUrl(input.resourceUrl)) {
    return { outcome: "failed", reason: "refusing plain HTTP to a non-loopback host" };
  }
  if (isPrivateNetworkHost(input.resourceUrl) || (await resolvesToPrivateNetwork(input.resourceUrl))) {
    return { outcome: "failed", reason: "resourceUrl resolves to a private/link-local address" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OWNERSHIP_CHECK_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: input.method ?? "GET",
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (error) {
    return { outcome: "failed", reason: `resourceUrl unreachable: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timeout);
  }

  if (response.status !== 402) {
    // Includes redirects (3xx, since redirect: "manual" surfaces those as
    // opaqueredirect/3xx rather than following them): a resource that
    // redirects elsewhere before challenging isn't confirmed to be the same
    // origin this check just resolved and connected to.
    return { outcome: "failed", reason: `resourceUrl did not return 402 directly (got ${response.status})` };
  }

  const header = response.headers.get("PAYMENT-REQUIRED");
  if (!header) {
    return { outcome: "failed", reason: "402 response has no PAYMENT-REQUIRED header" };
  }

  let accepts: PaymentRequirements[];
  try {
    accepts = decodePaymentRequiredHeader(header).accepts;
  } catch {
    return { outcome: "failed", reason: "PAYMENT-REQUIRED header failed to decode" };
  }

  const live = accepts.find(
    r =>
      r.scheme === input.requirements.scheme &&
      r.network === input.requirements.network &&
      r.asset === input.requirements.asset,
  );
  if (!live) {
    return { outcome: "failed", reason: "resource's live 402 has no matching scheme/network/asset requirement" };
  }
  if (live.payTo !== input.payTo) {
    return {
      outcome: "failed",
      reason: `resource's live payTo (${live.payTo}) does not match the catalog submission (${input.payTo})`,
    };
  }

  return { outcome: "verified" };
}

/**
 * MCP counterpart to `verifyHttpResourceOwnership`, applying the same
 * catalog-integrity rule to MCP resources: nothing is indexed on submitted
 * discovery metadata alone. Connects to `input.resourceUrl` as a real MCP
 * client (Streamable HTTP transport — the only network-reachable one; a
 * stdio-transport resource has no remote endpoint this facilitator could
 * dial into at all, so it's `"skipped"`, not silently passed) and lists
 * that server's tools, confirming `input.toolName` genuinely exists there.
 *
 * **A narrower guarantee than the HTTP check, stated precisely rather than
 * oversold.** Unlike an HTTP 402 challenge, an MCP `tools/list` response
 * carries no `PaymentRequirements`/`payTo` of its own to cross-check against
 * — payment terms for an x402-over-MCP tool call are negotiated inside the
 * tool-call flow itself, not declared in the tool listing, and no published
 * `@x402` package installed in this project exposes a resource-server-side
 * MCP payment-declaration convention this check could verify against
 * independently. So this closes the "resourceUrl/toolName is entirely
 * fabricated, no such server or tool exists" gap — the same class of attack
 * `verifyHttpResourceOwnership` closes for a squatted URL — but does not
 * (yet) cross-check `payTo` for MCP the way the HTTP path does. Disclosed
 * here, not left implicit; closing that residual gap needs a real
 * x402-over-MCP payment-declaration convention to verify against, which is
 * a protocol-level gap, not something this check alone can resolve.
 *
 * Same conservative posture as the HTTP path: any error, timeout, or
 * missing tool is `"failed"`, never treated as an implicit pass.
 */
async function verifyMcpResourceOwnership(input: OwnershipCheckInput): Promise<OwnershipCheckResult> {
  if (!input.toolName) {
    return { outcome: "failed", reason: "mcp resource submission is missing toolName" };
  }

  let url: URL;
  try {
    url = new URL(input.resourceUrl);
  } catch {
    return { outcome: "failed", reason: "resourceUrl is not a valid URL" };
  }

  if (!isSecureUrl(input.resourceUrl)) {
    return { outcome: "failed", reason: "refusing plain HTTP to a non-loopback host" };
  }
  if (isPrivateNetworkHost(input.resourceUrl) || (await resolvesToPrivateNetwork(input.resourceUrl))) {
    return { outcome: "failed", reason: "resourceUrl resolves to a private/link-local address" };
  }

  const client = new McpClient({ name: "lumengate-resource-ownership-check", version: "1.0.0" });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OWNERSHIP_CHECK_TIMEOUT_MS);
  try {
    const transport = new StreamableHTTPClientTransport(url);
    await client.connect(transport, { signal: controller.signal });
    const { tools } = await client.listTools(undefined, { signal: controller.signal });
    const found = tools.some(tool => tool.name === input.toolName);
    if (!found) {
      return { outcome: "failed", reason: `resource's live MCP server has no tool named ${input.toolName}` };
    }
    return { outcome: "verified" };
  } catch (error) {
    return {
      outcome: "failed",
      reason: `mcp resourceUrl unreachable or invalid: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timeout);
    await client.close().catch(() => {});
  }
}
