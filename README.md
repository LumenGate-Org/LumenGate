# LumenGate

LumenGate provides x402 infrastructure for Stellar: facilitator services,
Bazaar discovery, MCP integration for agents, SDK helpers, examples, and
Soroban settlement contracts. It is built for the **x402 Facilitator with
Bazaar Discovery Support** RFP and focuses on non-custodial, fee-sponsored
payments for autonomous paid resources.

## Project Overview

The facilitator handles both `exact` and `upto` payment schemes, sponsors
Stellar network fees, and never takes custody of buyer or seller funds.
LumenGate distinguishes three settlement architectures:

- `exact`: fixed-price payments through `@x402/stellar` and direct SEP-41
  transfers, with facilitator fees managed off-chain.
- Standard `upto`: usage-based payments through a Stellar settlement contract,
  with facilitator fees managed off-chain.
- Managed `upto`: usage-based payments where the facilitator fee is integrated
  into the atomic settlement transaction.

The off-chain business model supports renewable free settlement quotas and
configurable fixed, percentage-based, or min/max combined fees. Managed `upto`
adds an on-chain percentage fee split paid atomically with the seller payment.

## Bazaar Discovery And MCP

LumenGate combines automatic Bazaar cataloging with hybrid search. The
facilitator validates discovery metadata before cataloging so malformed or
misleading payment metadata cannot poison the catalog.

Search applies Bazaar hard filters first, then combines PostgreSQL full-text
search and vector search with Reciprocal Rank Fusion. Quality is measured with
Recall@k and NDCG@k on manually labeled queries, so the search set can be
maintained and expanded over time. The MCP server lets agents discover,
inspect, and access x402 services through tool calls.

## Current Traction

LumenGate is implemented as a working Stellar testnet prototype. The repository
contains 234 automated tests: 203 TypeScript tests and 31 Rust contract tests.
Core flows, including the atomic on-chain facilitator fee split, are validated
through verifiable testnet transactions recorded in the conformance report.

The configurable business model is implemented across fixed, percentage-based,
and min/max combined off-chain pricing. Two `upto` architectures were built,
validated, and benchmarked on testnet: an allowance-based design and an Atomic
Swap-inspired escrow-and-refund design. The escrow-and-refund design is the
default because it has lower measured resource cost and introduces no
persistent contract state.

The team brings Web3 engineering experience, including hands-on work on the
MetaMask project at ConsenSys, plus DeFi and SDK development experience in the
Stellar ecosystem.

## Planned Stellar Integration

The technical architecture relies on three core components:

1. `x402UptoStellarEscrowSettlement`, a custom Soroban settlement contract for
   usage-based `upto` payments. The buyer signs one authorization with
   `require_auth_for_args` for a maximum amount. The contract escrows that cap,
   pays the seller the actual amount, refunds the difference in the same
   transaction, and relies on Soroban's per-authorization-entry nonce
   (CAP-0046-11) for replay protection. It requires no prior approval step and
   stores no persistent contract state.
2. Fixed-price payments reuse `@x402/stellar`'s `exact` scheme unmodified
   through direct SEP-41 transfers.
3. The facilitator sponsors network fees and supports a channel-account pool
   to avoid sequence-number contention under concurrent settlements.

`@stellar/stellar-sdk` handles transaction assembly, XDR, simulation, and RPC
submission. Horizon is used for balance checks and operational metrics.

## Use Cases

1. Agentic API and service marketplace: agents can search Bazaar, inspect a
   resource's price/schema, and call paid endpoints through MCP without a
   seller-specific account or API key.
2. Metered inference and generation APIs: clients authorize a maximum payment
   before a request, then `upto` settlement charges the actual post-usage
   amount.
3. Facilitator-as-a-service: operators can run a payment gateway for resource
   servers, sponsor Stellar network fees, expose discovery, and meter
   off-chain billing.
4. Pay-per-query data access: market data, geospatial data, research corpora,
   and similar resources can charge per query or per returned result.
5. Pay-per-compute jobs: rendering, batch processing, or compute APIs can price
   requests by actual work performed.

## Repository Layout

```text
contracts/
  upto-settlement-escrow/   Default Soroban escrow-and-refund settlement contract
  upto-settlement/          Allowance-based Soroban settlement variant
docs/
  architecture.md           System design and security model
  developer-guide.md        Seller, buyer, and operator integration guide
  runbook.md                Deployment, operations, monitoring, and maintenance
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

For contract tests:

```bash
cd contracts/upto-settlement-escrow
cargo test

cd ../upto-settlement
cargo test
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

## Documentation

- [Architecture](./docs/architecture.md)
- [Developer Guide](./docs/developer-guide.md)
- [Operational Runbook](./docs/runbook.md)
- [Stellar `upto` Scheme Spec](./specs/schemes/upto/scheme_upto_stellar.md)
- [Conformance Report](./e2e/conformance/CONFORMANCE_REPORT.md)

## License

Apache-2.0. See [LICENSE](./LICENSE).
