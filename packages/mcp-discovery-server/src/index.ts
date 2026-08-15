#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createEd25519Signer, STELLAR_TESTNET_CAIP2 } from "@x402/stellar";
import { x402HTTPClient } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createStellarPaymentClient, ensureUptoAllowance } from "@x402-stellar/sdk";
import { buildQuery } from "./query.js";
import {
  checkPaymentRequiredResponse,
  isHostAllowed,
  isSecureUrl,
  resolvesToPrivateNetwork,
} from "./guardrails.js";
import {
  FENCE_CONVENTION_NOTICE,
  fenceCatalogResource,
  fenceUntrusted,
  makeFenceNonce,
  type FenceableResource,
} from "./fence.js";

const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "http://localhost:4021";
const AGENT_SECRET = process.env.AGENT_SECRET;

// Optional spending guardrails for `call_resource`, since it's the one tool
// here that moves real funds from AGENT_SECRET autonomously. Unset by
// default (matching the rest of this prototype's opt-in-hardening pattern — see
// docs/architecture.md "Scope boundaries") so the local demo flow keeps
// working with zero configuration; an operator running this for an agent
// with real funds should set both.
const AGENT_ALLOWED_HOSTS = (process.env.AGENT_ALLOWED_HOSTS ?? "")
  .split(",")
  .map(h => h.trim())
  .filter(Boolean);
const AGENT_MAX_PAYMENT_AMOUNT = process.env.AGENT_MAX_PAYMENT_AMOUNT
  ? BigInt(process.env.AGENT_MAX_PAYMENT_AMOUNT)
  : undefined;

const server = new McpServer({
  name: "x402-stellar-discovery",
  version: "0.1.0",
});

const filterShape = {
  type: z.enum(["http", "mcp"]).optional().describe("Filter by resource type"),
  payTo: z.string().optional().describe("Filter by payment recipient address"),
  scheme: z.enum(["exact", "upto"]).optional().describe("Filter by payment scheme"),
  network: z.string().optional().describe("Filter by CAIP-2 network, e.g. stellar:testnet"),
  extensions: z.string().optional().describe("Filter by extension key present on the resource"),
};

async function fetchJson(path: string): Promise<unknown> {
  const response = await fetch(`${FACILITATOR_URL}${path}`);
  if (!response.ok) {
    throw new Error(`Facilitator request failed (${response.status}): ${await response.text()}`);
  }
  return response.json();
}

function textResult(value: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/**
 * Fences the untrusted free-text fields of every resource in a discovery
 * response (`search_resources`/`list_resources` both return `{ resources:
 * [...] }`) under one fresh nonce, then serializes exactly like
 * `textResult`. See `fence.ts` for why this exists and what it does and
 * doesn't defend against.
 */
function fencedCatalogResult(value: { resources: unknown[] }): { content: { type: "text"; text: string }[] } {
  const nonce = makeFenceNonce();
  const fenced = {
    ...value,
    resources: value.resources.map(resource => fenceCatalogResource(resource as FenceableResource, nonce)),
  };
  return textResult(fenced);
}

server.registerTool(
  "search_resources",
  {
    title: "Search Bazaar resources",
    description:
      "Natural-language search over the facilitator's Bazaar catalog of x402-payable resources " +
      "(HTTP endpoints and MCP tools). The response's pagination.cursor, when non-null, can be " +
      "passed back as `cursor` to fetch the next page of results. " +
      `Each resource's description/serviceName/tags are seller-authored text. ${FENCE_CONVENTION_NOTICE}`,
    inputSchema: {
      query: z.string().describe("Natural-language search query"),
      limit: z.number().int().positive().max(50).optional(),
      cursor: z.string().optional().describe("Opaque pagination cursor from a previous search_resources response"),
      ...filterShape,
    },
  },
  async ({ query, limit, cursor, ...filters }) => {
    const qs = buildQuery({ query, limit, cursor, ...filters });
    return fencedCatalogResult(
      (await fetchJson(`/discovery/search?${qs}`)) as { resources: unknown[] },
    );
  },
);

server.registerTool(
  "list_resources",
  {
    title: "List Bazaar resources",
    description:
      "Paginated browse of the facilitator's Bazaar catalog, optionally filtered. " +
      `Each resource's description/serviceName/tags are seller-authored text. ${FENCE_CONVENTION_NOTICE}`,
    inputSchema: {
      limit: z.number().int().positive().max(200).optional(),
      offset: z.number().int().nonnegative().optional(),
      ...filterShape,
    },
  },
  async ({ limit, offset, ...filters }) => {
    const qs = buildQuery({ limit, offset, ...filters });
    return fencedCatalogResult(
      (await fetchJson(`/discovery/resources?${qs}`)) as { resources: unknown[] },
    );
  },
);

server.registerTool(
  "call_resource",
  {
    title: "Call a paid x402 resource",
    description:
      "Executes a full x402-paid HTTP call: fetches the resource, pays automatically if it responds 402 " +
      "(exact or upto scheme, sponsoring an upto allowance top-up if needed), and returns the result. " +
      "Requires AGENT_SECRET to be configured on this server (a funded Stellar account the agent pays from). " +
      "If AGENT_ALLOWED_HOSTS and/or AGENT_MAX_PAYMENT_AMOUNT are configured on this server, calls to " +
      "disallowed hosts or requirements exceeding the price cap are refused before any payment is attempted. " +
      `The returned body is the resource server's own response — content the agent paid for, not this ` +
      `tool. ${FENCE_CONVENTION_NOTICE}`,
    inputSchema: {
      url: z.string().url().describe("The resource URL, as returned by search_resources/list_resources"),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional().default("GET"),
      body: z.record(z.string(), z.unknown()).optional().describe("JSON body for POST/PUT/PATCH requests"),
    },
  },
  async ({ url, method, body }) => {
    if (!AGENT_SECRET) {
      return {
        content: [{ type: "text", text: "AGENT_SECRET is not configured on this MCP server; cannot pay." }],
        isError: true,
      };
    }

    if (!isHostAllowed(url, AGENT_ALLOWED_HOSTS)) {
      return {
        content: [
          { type: "text", text: `Refusing to call ${new URL(url).hostname}: not in AGENT_ALLOWED_HOSTS.` },
        ],
        isError: true,
      };
    }

    if (!isSecureUrl(url)) {
      return {
        content: [
          {
            type: "text",
            text: `Refusing to call ${url}: plain HTTP is only allowed for localhost. Use https:// for a real deployment.`,
          },
        ],
        isError: true,
      };
    }

    // A private/link-local host — whether the URL names it literally or a
    // domain name simply resolves to one — is only allowed if the operator
    // explicitly named that exact host in AGENT_ALLOWED_HOSTS. Resolves DNS
    // to catch the common case (a domain pointed at an internal address,
    // e.g. cloud metadata); see `resolvesToPrivateNetwork`'s doc comment for
    // what this still doesn't fully cover (TOCTOU/DNS-rebinding).
    if (!AGENT_ALLOWED_HOSTS.includes(new URL(url).hostname) && (await resolvesToPrivateNetwork(url))) {
      return {
        content: [
          {
            type: "text",
            text: `Refusing to call ${url}: private/internal network host. Add it to AGENT_ALLOWED_HOSTS to permit it explicitly.`,
          },
        ],
        isError: true,
      };
    }

    const signer = createEd25519Signer(AGENT_SECRET, STELLAR_TESTNET_CAIP2);
    const client = createStellarPaymentClient(signer);
    const httpClient = new x402HTTPClient(client);

    const requestInit: RequestInit =
      body !== undefined
        ? { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : { method };

    // Wraps the underlying `fetch` that `wrapFetchWithPayment` itself calls
    // to discover the 402 quote it will pay — NOT a separate probe request.
    // A prior version called `inspectPaymentRequirements` first to check the
    // cap, but that's an independent HTTP exchange from the one
    // `wrapFetchWithPayment` uses internally, and nothing guarantees a
    // resource server quotes the same price on both: it could quote
    // in-cap on the probe and over-cap on the real request, and the cap
    // check would never see the real quote. Checking the response
    // `wrapFetchWithPayment` itself receives closes that gap, and also lets
    // the allowance top-up size itself off the same real quote instead of a
    // possibly-stale one.
    let capError: string | undefined;
    const checkedFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      const { requirements, overCap } = checkPaymentRequiredResponse(response, AGENT_MAX_PAYMENT_AMOUNT);
      if (overCap) {
        capError =
          `Refusing to pay: ${overCap.scheme} requirement of ${overCap.amount} exceeds ` +
          `AGENT_MAX_PAYMENT_AMOUNT (${AGENT_MAX_PAYMENT_AMOUNT}). Raise the cap if this is expected.`;
        // Thrown, not returned: `wrapFetchWithPayment` has no try/catch
        // around this call, so this aborts the whole payment flow before
        // any payment payload is constructed, rather than letting a
        // returned 402 flow into `client.createPaymentPayload`.
        throw new Error(capError);
      }

      const uptoRequirement = requirements?.find(r => r.scheme === "upto");
      if (uptoRequirement) {
        // Called unconditionally because this tool is a generic client that
        // can point at any x402 Stellar facilitator, and PaymentRequirements
        // carries no field distinguishing which upto contract design a given
        // deployment runs. Against the escrow-and-refund default (no
        // allowance concept at all), this is a harmless no-op check — SEP-41
        // `allowance()` against an address that never calls `transfer_from`
        // is simply irrelevant, not wrong. Against the allowance-based
        // alternative design, it's load-bearing. See "Integrating as a
        // buyer/agent" in docs/developer-guide.md.
        const extra = uptoRequirement.extra as { settlementContract: string };
        await ensureUptoAllowance({
          signer,
          token: uptoRequirement.asset,
          spender: extra.settlementContract,
          minAllowance: BigInt(uptoRequirement.amount),
          network: uptoRequirement.network,
        });
      }

      return response;
    };

    const fetchWithPayment = wrapFetchWithPayment(checkedFetch, httpClient);

    try {
      const response = await fetchWithPayment(url, requestInit);
      const result = await httpClient.processResponse(response);
      // `result.body` is whatever the resource server returned — content the
      // agent paid for and is about to read, not something this facilitator
      // controls. Fenced the same way catalog text is (see fence.ts):
      // stringified first since a resource can return a JSON object/array,
      // not just a string, and the fence itself only wraps text.
      const nonce = makeFenceNonce();
      const fencedBody = fenceUntrusted(
        typeof result.body === "string" ? result.body : JSON.stringify(result.body),
        nonce,
      );
      return textResult({ ...result, body: fencedBody });
    } catch (error) {
      if (capError) {
        return { content: [{ type: "text", text: capError }], isError: true };
      }
      throw error;
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`x402 Stellar discovery MCP server running (facilitator: ${FACILITATOR_URL})`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
