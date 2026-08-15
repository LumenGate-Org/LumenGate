# Changelog

All notable changes to this project are documented here. Every workspace
package is still pre-1.0 (`0.1.0`), so this file is organized by date and
commit rather than tagged releases — see `git log` for the exact diffs
behind each entry.

## Unreleased

### 2026-08-15 — Fix stale search-quality figures and a lint gap

- Corrected `docs/architecture.md`, which cited the hybrid search benchmark's
  NDCG@5 as both 0.993 and 0.996 in different places; re-ran the evaluation
  harness live and confirmed 0.996 is current.
- Fixed a lint gap in the new license-check script: plain `.js`/`.mjs` files
  had no Node.js globals configured for ESLint, so `console`/`process`
  flagged as undefined.

### 2026-08-15 — Add automated license compliance checks and document decentralization/privacy

- Added automated dependency license-compliance checks for both the
  npm/pnpm workspace and each Soroban contract's Cargo dependency tree,
  flagging strong-copyleft licenses (GPL family, SSPL, BUSL). Wired into CI
  as real jobs. Confirmed clean across both trees.
- Documented the project's decentralization properties (non-custodial
  settlement enforced by the network itself, not operator trust) and data
  handling/privacy posture in `docs/architecture.md`.

### 2026-08-15 — Harden repository maintenance

- Wired up ESLint across the workspace (previously a no-op script) and run
  it as its own CI job.
- Added the third Soroban contract (`custom-account-demo`) to CI's test
  matrix.
- Pinned GitHub Actions in CI to commit SHAs instead of movable tags.
- Added Dependabot configuration for npm, each Soroban contract, and
  GitHub Actions.
- Added `CODEOWNERS`.
- Gave `SECURITY.md` an actual private vulnerability reporting channel.
- Marked every workspace package `private: true` to prevent an accidental
  publish.

### 2026-08-15 — Add L2 semantic reranking, usage-ranking eval harness, and expand architecture docs

- Added L2 semantic reranking for Bazaar search: a real cross-encoder
  second-stage reranker over the top 50 first-stage candidates, off by
  default given its measured per-query latency cost.
- Added a harness-level evaluation scenario for usage-based search ranking
  using synthetic usage data — caught and fixed a real ranking regression
  before it shipped.
- Changed the usage-ranking channel's default from enabled to disabled,
  given the measured relevance-quality tradeoff and since it isn't an
  RFP-required feature.
- Expanded `docs/architecture.md` with an overview, a request-flow
  walkthrough, a table of contents, and a single-page evidence index.

### 2026-08-15 — Add agent-safety hardening, custom-account proof, and usage-based ranking

- Added MCP prompt-injection fencing: seller-supplied catalog text and paid
  resource responses are wrapped in a nonce-fenced boundary before reaching
  an agent's context.
- Added resource-ownership verification: before cataloging a new resource
  or changing an existing one's `payTo`, the facilitator re-fetches the
  resource's own live 402 challenge to confirm it, closing a
  URL-squatting/catalog-hijack vector.
- Added a minimal custom `__check_auth` Soroban account, deployed and
  settled against the unmodified facilitator on testnet — proving
  composability with Stellar smart-account spending policies.
- Added Bazaar usage-based ranking: per-resource daily usage tracking with
  a Sybil-resistance threshold, derived signals, retention, and a second
  Reciprocal Rank Fusion pass folding usage into search ranking.

### 2026-08-12 — Initial LumenGate repository

- x402 facilitator for Stellar (`exact` scheme, reused unmodified from
  `@x402/stellar`).
- `upto` scheme: two settlement contract designs (allowance-based and
  escrow-and-refund), the latter promoted to primary/default after a
  quantified, benchmarked comparison.
- Managed `upto`: an atomic, on-chain facilitator fee split in the same
  settlement transaction.
- Bazaar discovery layer: hybrid (lexical + semantic) search over
  PostgreSQL/pgvector, fused by Reciprocal Rank Fusion, with automatic
  cataloging and catalog-integrity protections.
- MCP discovery server for agents (`search_resources`, `list_resources`,
  `call_resource`).
- Off-chain billing ledger with a configurable fixed/percentage/combined
  fee model.
- `specs/schemes/upto/scheme_upto_stellar.md`, written for upstream
  contribution.
- Seller and buyer/agent example integrations, live testnet conformance
  scripts, and the initial test suite.
