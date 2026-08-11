# x402 Stellar Facilitator

An x402 facilitator and discovery stack for Stellar. The repository includes
Stellar settlement support for `exact` and `upto` payments, a Bazaar-compatible
discovery catalog, an MCP discovery server for agents, runnable seller/buyer
examples, Soroban settlement contracts, and conformance scripts for live
testnet checks.

## What It Does

- Settles fixed-price x402 requests on Stellar through the existing `exact`
  scheme.
- Adds a Stellar-native `upto` scheme for usage-based pricing, backed by a
  Soroban settlement contract.
- Supports managed `upto` payments where the facilitator fee is split
  on-chain in the same settlement transaction.
- Catalogs paid resources through Bazaar-compatible discovery endpoints.
- Exposes MCP tools so agents can search, inspect, and call paid resources.
- Tracks off-chain facilitator billing for `exact` and standard `upto` tiers.

## Repository Layout

```text
contracts/
  upto-settlement-escrow/   Default Soroban escrow-and-refund settlement contract
  upto-settlement/          Allowance-based Soroban settlement variant
docs/
  architecture.md           System design and security model
  developer-guide.md        Seller, buyer, and operator integration guide
  runbook.md                Deployment, operations, monitoring, and maintenance
  use-cases-and-integration-plan.md
                            Product use cases and Stellar integration notes
e2e/conformance/            Live testnet/pubnet conformance scripts and report
examples/
  buyer-agent/              Paying client example
  seller-http/              Paid HTTP resource server example
packages/
  discovery/                Bazaar catalog, hybrid search, HTTP discovery API
  facilitator/              x402 facilitator HTTP service and billing ledger
  mcp-discovery-server/     MCP tools over discovery and paid resource calls
  sdk/                      Buyer/agent and seller helper APIs
  stellar-upto/             `upto` client, server, and facilitator scheme code
specs/schemes/upto/         Protocol specification for Stellar `upto`
```

## Prerequisites

- Node.js 22 or newer
- pnpm 10
- Rust and the Stellar CLI for Soroban contract work
- A Stellar testnet account and SEP-41 token for live settlement tests

## Install

```bash
pnpm install
```

## Build And Test

```bash
pnpm build
pnpm test
pnpm typecheck
```

Package-level commands are available inside each workspace package, for
example:

```bash
cd packages/facilitator
pnpm dev
```

## Running The Facilitator

```bash
cd packages/facilitator
cp .env.example .env
pnpm dev
```

Important endpoints:

- `GET /supported`
- `POST /verify`
- `POST /settle`
- `GET /discovery/resources`
- `GET /discovery/search`
- `GET /billing/usage?payTo=<stellar-address>`
- `GET /metrics`
- `GET /health`

See [docs/developer-guide.md](./docs/developer-guide.md) for integration
examples and [docs/runbook.md](./docs/runbook.md) for operator guidance.

## Settlement Contracts

The default `upto` implementation is
[`contracts/upto-settlement-escrow`](./contracts/upto-settlement-escrow). It
uses escrow-and-refund settlement, requires no prior token allowance from the
buyer, and keeps no persistent contract state.

[`contracts/upto-settlement`](./contracts/upto-settlement) remains available
as an allowance-based variant for deployments that need `cancel` and
`is_settled` contract capabilities.

## Discovery And Agent Access

`packages/discovery` provides the Bazaar-compatible catalog and hybrid search
using PostgreSQL/pgvector via PGlite. `packages/mcp-discovery-server` exposes
the catalog and paid-call flow as MCP tools:

- `search_resources`
- `list_resources`
- `get_resource`
- `call_resource`

## Documentation

- [Architecture](./docs/architecture.md)
- [Developer Guide](./docs/developer-guide.md)
- [Operational Runbook](./docs/runbook.md)
- [Use Cases And Integration Notes](./docs/use-cases-and-integration-plan.md)
- [Stellar `upto` Scheme Spec](./specs/schemes/upto/scheme_upto_stellar.md)
- [Conformance Report](./e2e/conformance/CONFORMANCE_REPORT.md)

## License

Apache-2.0. See [LICENSE](./LICENSE).
