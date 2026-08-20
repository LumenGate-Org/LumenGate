# Developer Guide

This guide covers integrating with the x402 Stellar facilitator as a seller
(resource server), a buyer/agent, or an operator running your own
facilitator instance. For the protocol-level details of the `upto` scheme,
see [`specs/schemes/upto/scheme_upto_stellar.md`](../specs/schemes/upto/scheme_upto_stellar.md).
For architecture and design rationale, see [`architecture.md`](./architecture.md).
The sections below are organized by role so the same guide can serve sellers,
buyers, agents, and facilitator operators without requiring repo-specific
background first — deliberately, since the intent is to contribute this
guide to the Stellar Developer Docs once the project reaches a stability
point worth publishing externally (see "Maintenance and support plan" in
`docs/runbook.md`); a guide that only makes sense alongside this
repository's own internal context wouldn't transplant there cleanly.

## Prerequisites

- Node.js ≥ 22, pnpm
- A Stellar account (testnet: create and fund one with
  [`stellar keys generate <name> --network testnet --fund`](https://developers.stellar.org/docs/tools/cli/stellar-cli))
- For `upto`: a deployed `x402UptoStellarEscrowSettlement` contract (see
  `contracts/upto-settlement-escrow/README.md`) and a SEP-41 token

## Running the facilitator

```bash
cd packages/facilitator
cp .env.example .env   # fill in STELLAR_FACILITATOR_SECRET(S), etc.
pnpm dev
```

See [Environment Variables](#environment-variables) below for the full list.
Once running:

- `GET /supported` — advertises which schemes/networks this facilitator handles
- `POST /verify`, `POST /settle` — the facilitator API x402 resource servers call.
  For `upto`, a byte-for-byte-identical retried `/settle` call is idempotent
  — it returns the same result the first successful call produced instead
  of re-attempting, so it's safe for a resource server to retry on a
  timeout without risking a duplicate settlement or a confusing second
  error. (Deliberately strict: a retry carrying the same witness but any
  other field changed is treated as a distinct request, not served from
  cache — see "Idempotency" in the upto spec.)
- `GET /discovery/resources`, `GET /discovery/search` — Bazaar catalog.
  `/discovery/search` supports cursor-based pagination: a non-null
  `pagination.cursor` in the response can be passed back as `?cursor=...`
  to fetch the next page. Search is hybrid (Postgres full-text + semantic
  embedding similarity, fused via Reciprocal Rank Fusion) — see "Hybrid
  search architecture" in `docs/architecture.md`. A resource only ever
  appears once its actual payment information has been independently
  verified against its live source (HTTP 402 or MCP tool listing) — see
  "Automatic cataloging" in `docs/architecture.md` — so there's no
  provisional/unverified state to check for; every returned resource has
  already passed that check.
- `GET /billing/usage?payTo=<address>` — off-chain usage/charge for a seller
- `GET /metrics` — Prometheus-text-format signals (signer XLM balance per
  network, settlement counts by scheme/network, catalog size); `GET /health`
  for a plain liveness check. See "Monitoring" in `docs/runbook.md`.

## Integrating as a seller (resource server)

Use `@x402/express`'s `paymentMiddleware`, registering both Stellar schemes
against your facilitator:

```ts
import { paymentMiddleware } from "@x402/express";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { UptoStellarScheme } from "@x402-stellar/upto/server";
import { STELLAR_TESTNET_CAIP2 } from "@x402/stellar";

const resourceServer = new x402ResourceServer(
  new HTTPFacilitatorClient({ url: process.env.FACILITATOR_URL! }),
)
  .register(STELLAR_TESTNET_CAIP2, new ExactStellarScheme())
  // feeBps: 0 = standard upto (facilitator bills you off-chain, like exact).
  // feeBps > 0 = managed upto: the facilitator's cut is paid on-chain,
  // atomically, out of each settlement — no invoice, no separate billing.
  .register(STELLAR_TESTNET_CAIP2, new UptoStellarScheme({ feeBps: 500 }));
```

For each route, `@x402-stellar/sdk`'s `declareStellarResource` builds the
`RouteConfig` `paymentMiddleware` expects — pricing, network default, and
(optionally) the Bazaar discovery extension in one call, with Stellar
address validation, instead of hand-assembling the `accepts` array and
separately spreading in `declareDiscoveryExtension`:

```ts
import { declareStellarResource } from "@x402-stellar/sdk";

app.use(
  paymentMiddleware(
    {
      "GET /weather/:city": declareStellarResource({
        scheme: "exact",
        payTo: SELLER_ADDRESS,
        asset: ASSET_TOKEN,
        amount: "10000",
        network: STELLAR_TESTNET_CAIP2, // optional — defaults to stellar:testnet
        description: "Current weather for a city",
        mimeType: "application/json",
        // Omit `discovery` to make the resource payable but not cataloged.
        discovery: {
          pathParamsSchema: {
            properties: { city: { type: "string", description: "City name slug" } },
            required: ["city"],
          },
          output: { example: { city: "san-francisco", weather: "foggy", temperature: 60 } },
        },
      }),
    },
    resourceServer,
  ),
);
```

`declareStellarResource`'s `discovery` field is passed straight through to
upstream `@x402/extensions/bazaar`'s `declareDiscoveryExtension` — it isn't
reimplemented, just wired in alongside the Stellar-specific pricing. See
`examples/seller-http/src/index.ts` for both an HTTP GET declaration (with
path params) and a POST/body declaration in full context. If you'd rather
assemble the `accepts` array yourself (e.g. multiple payment options on one
route), `stellarPaymentOption` builds just the validated `PaymentOption`
without the discovery wrapping.

For usage-metered `upto` routes, call `setSettlementOverrides(res, { amount })`
(from `@x402/express`) in your handler once you know actual consumption —
`amount` accepts a percentage (`"40%"`), a dollar string (`"$0.02"`), or raw
atomic units. See `examples/seller-http/src/index.ts`'s `/llm/generate` route.

## Integrating as a buyer/agent

`@x402-stellar/sdk` wraps the boilerplate. For a fixed-price (`exact`)
resource, paying is just a wrapped `fetch`:

```ts
import { createEd25519Signer, STELLAR_TESTNET_CAIP2 } from "@x402/stellar";
import { x402HTTPClient } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createStellarPaymentClient } from "@x402-stellar/sdk";

const signer = createEd25519Signer(SECRET_KEY, STELLAR_TESTNET_CAIP2);
const client = createStellarPaymentClient(signer);       // registers exact + upto
const httpClient = new x402HTTPClient(client);
const fetchWithPayment = wrapFetchWithPayment(fetch, httpClient);

const response = await fetchWithPayment("https://seller.example.com/weather/tokyo");
```

Against the facilitator's default `upto` configuration
(`x402UptoStellarEscrowSettlement`, escrow-and-refund), there is **no
allowance step at all** — the client scheme (`UptoStellarScheme` in
`@x402-stellar/upto/client`) is contract-agnostic and just signs a witness
against whatever contract the resource's `PaymentRequirements.extra.
settlementContract` names; the settlement contract pulls directly from your
balance at settlement time. `fetchWithPayment` alone is enough:

```ts
const response = await fetchWithPayment("https://seller.example.com/llm/generate", { method: "POST", ... });
```

See `examples/buyer-agent/src/index.ts` for the complete, runnable version of
this flow (both an `exact` and an `upto` purchase, back to back).

**If the facilitator you're paying is configured for the allowance-based
alternative design instead** (`UPTO_DESIGN=allowance` — check with the
operator, since `PaymentRequirements` itself doesn't carry a field
distinguishing the two designs), you need one extra, one-time step first: a
SEP-41 allowance to the settlement contract (see "Fund movement" in the upto
spec's Appendix B). `inspectPaymentRequirements` reads a resource's
`PaymentRequirements` — including which token/contract it needs an allowance
for — without paying, so you can size that allowance before the real
request:

```ts
import { ensureUptoAllowance, inspectPaymentRequirements } from "@x402-stellar/sdk";

const requirements = await inspectPaymentRequirements("https://seller.example.com/llm/generate");
const uptoTerms = requirements?.find(r => r.scheme === "upto");
if (uptoTerms) {
  const { settlementContract } = uptoTerms.extra as { settlementContract: string };
  // No-op if the existing allowance already covers minAllowance. Harmless
  // (just an unnecessary transaction) if called against the default
  // escrow-based facilitator, since it never reads or uses any allowance —
  // but only actually needed against the allowance-based alternative.
  // Always pass `network` — it defaults to testnet otherwise, which is easy
  // to miss on a pubnet resource (allowance would be checked/approved on
  // the wrong chain while the real payment goes out on pubnet).
  await ensureUptoAllowance({
    signer,
    token: uptoTerms.asset,
    spender: settlementContract,
    minAllowance: BigInt(uptoTerms.amount),
    network: uptoTerms.network,
  });
}

const response = await fetchWithPayment("https://seller.example.com/llm/generate", { method: "POST", ... });
```

If a signed `upto` witness turns out to be stale or unwanted before it's
settled (changed your mind, the request timed out client-side, etc.) and
you're paying an allowance-based-design facilitator, `cancelUptoPayment`
invalidates that specific request on-chain without touching your allowance
or any other pending request:

```ts
import { cancelUptoPayment } from "@x402-stellar/sdk";

await cancelUptoPayment({
  signer,
  settlementContract,
  requestNonce, // from the payload you want to invalidate
});
```

This needs only your own signature (a normal transaction, not an auth-entry
signing step) — see "Cancellation" in the upto spec's Appendix B for why
this exists and what it doesn't replace (revoking the whole allowance is
still the right tool when you want to block *every* pending request at
once). The default escrow-based design has no equivalent: an unsettled
witness can only expire on its own `deadline` — see "Cancellation (not
available in this design)" in the upto spec.

## Integrating as an agent (MCP)

`packages/mcp-discovery-server` exposes three tools over stdio:
`search_resources`, `list_resources`, `call_resource`. Point an MCP-capable
agent at it:

```jsonc
{
  "mcpServers": {
    "x402-stellar-discovery": {
      "command": "node",
      "args": ["/path/to/packages/mcp-discovery-server/dist/index.js"],
      "env": {
        "FACILITATOR_URL": "https://your-facilitator.example.com",
        "AGENT_SECRET": "S..." // only needed for call_resource
      }
    }
  }
}
```

`call_resource` performs the entire discovery-to-payment flow: fetch, detect
`402`, top up an `upto` allowance if needed, pay, retry, and return the
result — see `packages/mcp-discovery-server/src/index.ts`.

`search_resources` accepts an optional `cursor` (from a previous response's
`pagination.cursor`, when non-null) to page through more results than fit
in one call — the same cursor `GET /discovery/search` itself takes.

## Environment Variables

**`packages/facilitator`**

| Variable | Required | Description |
|---|---|---|
| `STELLAR_FACILITATOR_SECRET` (or `_SECRETS`, comma-separated) | Yes | Signer(s) used for settlement and (for `upto`) receiving on-chain fees |
| `UPTO_DESIGN` | No (`escrow`) | Which `upto` contract design is active: `escrow` (default, no allowance needed) or `allowance` — see "The `upto` settlement design" in `docs/architecture.md` |
| `UPTO_ESCROW_SETTLEMENT_CONTRACT_TESTNET` / `_PUBNET` | For `upto` (when `UPTO_DESIGN=escrow`) | Deployed `x402UptoStellarEscrowSettlement` contract address per network |
| `UPTO_SETTLEMENT_CONTRACT_TESTNET` / `_PUBNET` | For `upto` (when `UPTO_DESIGN=allowance`) | Deployed `x402UptoStellarSettlement` (allowance-based) contract address per network |
| `STELLAR_CHANNEL_ACCOUNT_SECRETS` | No | Optional channel account pool for `upto`/managed-`upto` settlement submission under concurrent load — see "Channel accounts" in `docs/runbook.md`. Fund with XLM only. |
| `STELLAR_PUBNET_RPC_URL` | For `stellar:pubnet` | Mainnet Soroban RPC endpoint. Unlike testnet, mainnet has no free public default — `exact`/`upto` on pubnet stay disabled (and unadvertised in `/supported`) until this is set. See `.env.example` for a public provider suggestion. |
| `PORT` | No (4021) | HTTP port |
| `DISCOVERY_DB_PATH` | No (`./data/discovery.db`) | PostgreSQL (PGlite) data directory for the Bazaar catalog |
| `BILLING_DB_PATH` | No (`./data/billing.db`) | SQLite path for off-chain usage metering |
| `BILLING_ADMIN_TOKEN` | No (open by default) | If set, `GET /billing/usage` requires it via `X-Billing-Admin-Token` |
| `DISCOVERY_USAGE_RANKING_ENABLED` | No (`true`) | Set to `false` to disable the usage-based search-ranking channel. On by default — it's part of the standard ranking pipeline (additive-only, never introduces a candidate relevance didn't already select). `eval/evaluate-usage-ranking.ts` measured a real relevance-quality tradeoff under a deliberately adversarial synthetic scenario (Recall@1 0.949 relevance-only vs. 0.692 with usage), documented rather than hidden; a deployment that wants relevance-only ranking can disable it with no redeploy. See "Usage-based ranking" in `docs/architecture.md` |
| `DISCOVERY_L2_RERANK_ENABLED` | No (`false`) | Set to `true` to enable L2 semantic reranking (a real cross-encoder over the top 50 candidates) — off by default since it measures ~800ms added latency for 50 candidates; see "Usage-based ranking" in `docs/architecture.md` |

**`examples/seller-http`**

| Variable | Required | Description |
|---|---|---|
| `SELLER_ADDRESS` | Yes | Stellar address that receives payment |
| `FACILITATOR_URL` | No (`http://localhost:4021`) | Facilitator to use |
| `ASSET_TOKEN` | No (defaults to testnet USDC) | SEP-41 token to price in |
| `PORT` | No (4022) | HTTP port |

**`examples/buyer-agent`** / **`packages/mcp-discovery-server`**

| Variable | Required | Description |
|---|---|---|
| `BUYER_SECRET` / `AGENT_SECRET` | Yes | Stellar secret key to pay from |
| `RESOURCE_SERVER_URL` / `FACILITATOR_URL` | No | Target service URL |
| `AGENT_ALLOWED_HOSTS` (`mcp-discovery-server` only) | No (unrestricted by default) | Comma-separated hostnames `call_resource` is permitted to pay |
| `AGENT_MAX_PAYMENT_AMOUNT` (`mcp-discovery-server` only) | No (uncapped by default) | Refuses to pay any requirement whose atomic `amount` exceeds this |

`call_resource` also always requires HTTPS for any non-`localhost` target
(plain HTTP is only accepted for `localhost`/`127.0.0.1`/`::1`) and refuses
private/link-local hosts (e.g. `10.x.x.x`, `169.254.169.254`) — including a
domain name that simply *resolves* to one, not just a literal IP — unless
that exact host is listed in `AGENT_ALLOWED_HOSTS`. This SSRF guard applies
regardless of whether `AGENT_ALLOWED_HOSTS` is configured, and the resolved
address isn't pinned to the connection the actual request makes, so it
doesn't stop a precisely-timed DNS-rebinding attack — see
`packages/mcp-discovery-server/src/guardrails.ts`.

The spending cap (`AGENT_MAX_PAYMENT_AMOUNT`) is checked against the exact
`402` response `call_resource` pays from, not a separate lookup — earlier
versions checked a probe request instead, which a resource server could
quote differently than the real payment.

**Prompt-injection fencing.** `search_resources`/`list_resources` results and
`call_resource`'s returned body all carry text a seller wrote, not this
facilitator — a resource description, service name, tags, or the resource's
own response content. Since MCP tool results typically flow straight into an
agent's context, this server wraps every such field in an explicit,
per-response fence (`⟦X402-UNTRUSTED-DATA:<nonce>:BEGIN⟧…⟦…:END⟧`) marking it
as data, not instructions, with a matching notice in each tool's static
description explaining the convention. The nonce is freshly random per tool
call (so a seller can't pre-stage a forged boundary for a future response),
and any text that already looks like a fence marker — for any nonce — is
scrubbed out of untrusted input before wrapping, so a seller can't forge an
early "END" and smuggle attacker-authored text past it. This raises the cost
of indirect prompt injection; it isn't a claim that it's eliminated — see
`packages/mcp-discovery-server/src/fence.ts`.

> **Naming note:** avoid naming an env var `TOKEN` in an `npx`/`npm exec`
> invocation — it's silently stripped from the child process's environment
> (observed while building this project; likely npm guarding against leaking
> what looks like a registry auth token). Use a more specific name like
> `ASSET_TOKEN`, as this project does throughout.

## Testing your integration

`e2e/conformance` contains scripts that exercise a live testnet deployment
end to end (see its `README.md`) — the fastest way to confirm a facilitator
or contract deployment actually works before pointing real sellers/buyers at
it.

To check search *quality* specifically (not just that the endpoints
respond), run `pnpm eval:search` from `packages/discovery` — reports
Recall@k/NDCG@k for hybrid search against a labeled query set, alongside a
lexical-only baseline for comparison. See "Search quality evaluation" in
`docs/architecture.md`. Useful after changing anything in the retrieval
path (`catalog.ts`'s `search()`, the embedding model, RRF constants) to
confirm it didn't regress.
