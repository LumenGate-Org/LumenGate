# Operational Runbook

Operational guidance for running this facilitator. Written for the current
prototype scope (testnet, single-instance) with explicit notes on what changes for
a production/mainnet deployment.

## Deploying the settlement contract

```bash
cd contracts/upto-settlement-escrow
stellar contract build
stellar contract deploy \
  --wasm target/wasm32v1-none/release/x402_upto_settlement_escrow.wasm \
  --source <deployer-identity> \
  --network testnet \
  --alias x402-upto-settlement-escrow
```

Record the resulting contract address — it's a permanent, immutable
deployment (this contract has no upgrade mechanism by design: an
opaque, mutable settlement contract holding a fee-taking role is a worse
security posture than a fixed one that gets redeployed-and-migrated-to on
changes). Set it as `UPTO_ESCROW_SETTLEMENT_CONTRACT_TESTNET`/`_PUBNET` on
the facilitator (`UPTO_DESIGN` defaults to `escrow`). One deployment serves
every seller/buyer using that facilitator; see "No canonical shared
contract" in `docs/architecture.md` for why each facilitator operator
deploys their own instance rather than sharing one.

Verify a deployment is live before pointing traffic at it:

```bash
stellar contract invoke --id <address> --source <any-identity> --network testnet -- max_fee_bps
# should print 2000
```

**Deploying the allowance-based alternative instead** (`UPTO_DESIGN=allowance`):
same steps, against `contracts/upto-settlement` (`x402_upto_settlement.wasm`,
alias `x402-upto-settlement`), setting
`UPTO_SETTLEMENT_CONTRACT_TESTNET`/`_PUBNET` instead — see "The `upto`
settlement design" in `docs/architecture.md` for why a deployment might
specifically choose this over the default.

### Redeploying (e.g. after a bug fix)

Since neither contract has an upgrade mechanism, fixing a bug or adding a
function means deploying a new instance and cutting over, not patching one
in place — this project's earlier allowance-based design has done exactly
that twice: v1→v2 for the `facilitator.require_auth()` fix (see "Security
validation and fix" in `e2e/conformance/CONFORMANCE_REPORT.md`), and v2→v3 to
add the `cancel` entry point. What redeploying involves:

1. Build and deploy the new wasm (steps above); you'll get a new contract address.
2. Update the relevant contract-address env var on the facilitator and restart it.
3. **If redeploying the allowance-based design**: existing SEP-41 allowances
   do not carry over — they were approved to the old contract address as
   spender. Buyers need to `approve` the new address before their next
   `upto` payment (`ensureUptoAllowance` from `@x402-stellar/sdk` handles
   this automatically on their next request; it just costs one extra
   on-chain transaction the first time). **The default escrow-based design
   has nothing equivalent to worry about** — it holds no allowance, so a
   redeployment only ever affects in-flight, not-yet-settled witnesses
   signed against the old address.
4. Treat the old address as permanently retired — don't reuse it, and update
   any documentation/config that hardcoded it (this repo's own history of
   doing exactly that is visible in `e2e/conformance/CONFORMANCE_REPORT.md`
   and `contracts/upto-settlement/README.md`).

## Running the facilitator

```bash
cd packages/facilitator
pnpm build && pnpm start   # or `pnpm dev` for tsx (no build step) during iteration
```

**Key management.** `STELLAR_FACILITATOR_SECRET` is a hot signing key — it
signs and submits every settlement transaction. For this prototype it's a plain
environment variable; a production deployment should pull it from a secrets
manager (not commit it, not log it) and consider `STELLAR_FACILITATOR_SECRETS`
(plural, comma-separated) for round-robin key rotation / reduced
per-key throughput pressure — the facilitator already supports multiple
signers out of the box (`selectSigner` option on both scheme classes).

**Channel accounts (`upto`/managed `upto` only).** Set
`STELLAR_CHANNEL_ACCOUNT_SECRETS` (comma-separated) to configure a pool of
dedicated channel accounts for settlement transaction submission — see
"Sequence-number bottlenecks" in `docs/architecture.md` for the mechanism,
and "Channel accounts for settlement submission" in
`e2e/conformance/CONFORMANCE_REPORT.md` for a live proof it works.
Create one the same way as any other testnet identity:

```bash
stellar keys generate channel-account-1 --network testnet --fund
```

Channel accounts need **only XLM** — enough to cover network fees, no more
(no SEP-41 trustline, no minimum balance beyond the standard account
reserve; they never receive or hold settlement funds). Unlike facilitator
signers, they hold no protocol-level identity: they never appear in
`getSigners()` or as an `extra.facilitatorAddress` a client could sign a
witness against, so rotating, adding, or retiring one has no effect on any
in-flight or previously-signed witness. Not required — omitting the env var
falls back to the pre-channel-account behavior (the facilitator signer
itself pays fees and holds the sequence number), unchanged.

**Billing endpoint.** `GET /billing/usage` is open by default (matching this
prototype's zero-config posture) — set `BILLING_ADMIN_TOKEN` before deploying
anywhere shared, since it exposes per-seller settlement volume. Unlike
`/verify`/`/settle`, this endpoint isn't part of x402's public protocol
surface, so gating it costs nothing functionally.

**Data.** `BILLING_DB_PATH` is a local SQLite file; `DISCOVERY_DB_PATH` is a
local PostgreSQL (PGlite) data directory — see "Hybrid search architecture"
in `docs/architecture.md`. Back both up like any stateful data store — the
billing ledger in particular is the source of truth for off-chain invoicing
(tiers 1 and 2 in `architecture.md`). Losing either doesn't lose funds
(settlements are still correct on-chain) but does lose the facilitator's
own revenue records or discovery catalog, respectively.

**Outbound network dependency during settlement.** Cataloging a brand-new
resource, or one whose `payTo` is changing, now makes a live outbound HTTP
request back to that resource's own URL to confirm ownership before
publishing it — see "resource-ownership verification" in
`docs/architecture.md`. Worth being precise about the cost: `onAfterSettle`
hooks run synchronously before `settle()`'s HTTP response returns
(`@x402/core`'s `x402Facilitator` awaits each hook in registration order),
so this check adds up to its 5s timeout to the *caller-visible* `/settle`
latency for that minority of requests — not a background/async check. The
on-chain settlement itself is already final by the time this hook runs
(funds have moved regardless of what this check finds), and it's fails
closed and gated (skipped whenever an existing resource's `payTo` isn't
changing — the common case), but a resource server that's slow or
unreachable at exactly the moment of its own first-time or payTo-changing
settlement will make that specific `/settle` call visibly slower for the
buyer. Accepted as a proportionate cost for the integrity guarantee it
buys, not something to silently smooth over.

**L2 semantic reranking latency (`DISCOVERY_L2_RERANK_ENABLED`).** Off by
default, for a latency reason. Enabling it runs a real cross-encoder model
over the top 50 first-stage search candidates on every `GET
/discovery/search` request — measured ~800ms on commodity hardware (see
"Usage-based ranking" in `docs/architecture.md`), a meaningful,
caller-visible per-query latency cost, not a background job.
`DISCOVERY_USAGE_RANKING_ENABLED` is also off by default, for a different
reason — a measured relevance-quality tradeoff, not latency (see the same
section). Consider whether search latency and/or the usage-ranking
tradeoff matter for a given deployment before enabling either; both channels can be toggled
independently at any time with no redeploy.

## Running the indexer (catalog reconciler)

A genuinely separate process from the facilitator's HTTP server, with two
jobs — see "Automatic cataloging: provisional at receipt, confirmed at
settlement" in `docs/architecture.md` for why both exist:

1. Reconciling the settlement-cataloging outbox (`pending_catalog`) after
   the rare event of a crash between a settlement confirming and its
   catalog write completing — cataloging normally happens inline and this
   process has nothing to do here.
2. Evicting `status: "provisional"` catalog entries (cataloged at
   `verify()` time, per the protocol requirements literal cataloging trigger) whose
   `provisionalExpiresAt` has passed without the same request going on to
   settle — bounding how long a validated-but-never-settled entry stays
   visible.

```bash
cd packages/facilitator
pnpm build
pnpm indexer         # runs continuously, reconciling every INDEXER_INTERVAL_MS (default 30s)
# or, for a cron-triggered deployment instead of a long-running process:
pnpm indexer:once    # one reconciliation pass, then exits
```

Point it at the **same** `DISCOVERY_DB_PATH` as the facilitator process —
both are separate PGlite processes pointed at the same on-disk PostgreSQL
data directory. It does not need Soroban RPC access, a Stellar signer, or
any secret — it only ever replays a payload that was already durably
written to disk by the facilitator, and it never talks to the chain. It
does load the same local embedding model the facilitator does (see
"Embedding model" below), since evicting an entry also has to remove it
from the vector index. Safe to run as a single instance alongside a single
facilitator instance for this prototype's embedded-Postgres setup; once discovery
storage moves to a standalone Postgres server for a multi-instance
deployment (see "Scaling path" below), this reconciler moves with it the
same way the facilitator itself would — both would connect to the same
server instead of opening the same local data directory.

**Embedding model.** The facilitator (and the indexer, for the reason
above) load `Xenova/all-MiniLM-L6-v2` in-process on first use, via
`@huggingface/transformers` — see "Hybrid search architecture" in
`docs/architecture.md`. The model (~90MB) downloads from the Hugging Face
Hub on first run and is cached locally afterward (Transformers.js's default
cache directory; no action needed in normal operation). Two operational
consequences: first startup after a fresh install needs outbound network
access to `huggingface.co` (not needed afterward — everything runs
in-process from the local cache); and the model adds a fixed amount to the
process's own memory footprint once loaded, on top of what PGlite itself
uses (PGlite's WASM Postgres engine has a real, non-trivial footprint of
its own — budget for both, not just the embedding model, when sizing a
facilitator deployment). Neither is tunable without changing the model choice
itself, which was picked for being small and fast rather than
maximally accurate — see "Search quality evaluation" in
`docs/architecture.md` for the evaluation harness that would surface if
that tradeoff stopped being good enough.

## Monitoring

`GET /metrics` returns real Prometheus-text-format output — point a
Prometheus scrape config at it directly:

- `facilitator_up` — always `1` while the process is running (liveness, via a metrics scraper rather than a separate check)
- `facilitator_signer_balance_xlm{network,address}` — live Horizon balance per signer per active network (30s cache; see `packages/facilitator/src/server.ts`). **The single most important signal**: settlement transactions are fee-sponsored, so a depleted signer silently stops all settlements on that network. Alert well before zero.
- `facilitator_settlements_total{scheme,network}` — all-time settlement counts, from `BillingLedger.settlementCountsByGroup()`
- `facilitator_discovery_resources_total` — Bazaar catalog size

This is a genuine starting point, not a full observability stack — no
alerting rules, dashboards, or tracing are included; wiring it into an
actual Prometheus/Grafana/Alertmanager deployment is left to the operator.
Two supplementary checks worth scripting separately, since they're not
(and don't need to be) metrics:

- `GET /health` — plain liveness, if you want something even cheaper than a scrape
- `GET /supported` — confirms scheme/network registration and (for `upto`)
  that the settlement contract address is actually configured; an empty
  `upto` entry means the contract env var is missing, and a missing
  `exact/stellar:pubnet`/`upto/stellar:pubnet` entry (when you expect one)
  means `STELLAR_PUBNET_RPC_URL` isn't set — see "Mainnet cutover" below.
- `GET /billing/usage?payTo=<seller>` per known seller, to catch metering
  drift — kept out of `/metrics` deliberately: a per-seller label there
  would give the metric unbounded cardinality as the seller base grows.

## Scaling path (out of scope for this prototype, noted for planning)

- **Billing storage**: SQLite is fine for a single facilitator instance;
  move to Postgres (or similar) before running more than one facilitator
  process against the same ledger, since SQLite doesn't support concurrent
  multi-writer access across processes.
- **Discovery storage**: already real PostgreSQL (via PGlite — see "Real
  PostgreSQL, via PGlite" in `docs/architecture.md`), but still a
  single-process embedded engine, not a server other facilitator instances
  can connect to. Before running more than one facilitator process against
  the same catalog, point `packages/discovery/src/catalog.ts` at a real,
  separately-run Postgres server instead (the SQL is already standard
  Postgres SQL — this needs a different client connection, not different
  queries) — a real infrastructure step, not a code migration.
- **Search quality at larger catalog scale**: hybrid (lexical + semantic,
  RRF-fused) search is already built and evaluated, not a future upgrade
  — see "Hybrid search architecture" in `architecture.md`. What's still a
  real scaling question: `RRF_CANDIDATE_POOL_SIZE` bounds how many
  candidates each channel contributes to fusion (200 by default), fine at
  prototype scale but not something that's been load-tested against a catalog
  with thousands of resources; and this project's vector search does not
  build an approximate-nearest-neighbor index (`ivfflat`/`hnsw`) on the
  `embedding` column, so it degrades to an exact scan as the catalog grows.
  Confirmed directly (`CREATE INDEX ON resources USING hnsw (embedding
  vector_cosine_ops)` against a live PGlite instance) that HNSW indexing
  works with this project's exact PGlite + `pgvector` setup, not just
  `pgvector` in general — so adding one is a config change to `catalog.ts`'s
  schema migration when it's needed, not a new dependency or an unverified
  assumption.
- **Mainnet cutover**: set `STELLAR_PUBNET_RPC_URL` (required — mainnet has
  no free public RPC default the way testnet does; see
  `packages/facilitator/.env.example` for a provider suggestion) and
  `UPTO_ESCROW_SETTLEMENT_CONTRACT_PUBNET` (or `UPTO_SETTLEMENT_CONTRACT_PUBNET`
  if running `UPTO_DESIGN=allowance`) to a *separately* deployed and verified
  mainnet contract instance (never reuse a testnet address/deployment for
  mainnet); fund the facilitator's mainnet signer account; confirm
  `getUsdcAddress`/asset addresses used by sellers are the real mainnet
  SEP-41 contracts, not testnet ones. Before funding anything, confirm RPC
  connectivity itself with `pnpm pubnet:rpc-connectivity` in
  `e2e/conformance` (read-only, no funded account needed) — see
  `e2e/conformance/CONFORMANCE_REPORT.md`, "requirements gap analysis
  and closure," for what this project's own pubnet posture is (wired and
  verified reachable, not exercised with real settlement funds) and why.

## Uptime target and degraded-service story

The protocol requirements ask for "99 percent or better uptime" for public endpoints with a
documented story for degraded settlement or indexing (Section 3.6). For this
prototype's single-instance deployment:

- **`/verify` and `/settle`** (the protocol-critical surface) depend on: the
  facilitator process, its configured Soroban RPC endpoint, and (for `upto`)
  the settlement contract being reachable. The facilitator itself holds no
  state needed for these two calls beyond the request — a restart doesn't
  lose in-flight capability, only in-flight requests. The single biggest
  real-world failure mode isn't the process crashing, it's a **depleted
  signer balance** (settlements are fee-sponsored, so a signer at zero XLM
  silently fails every settlement on that network) — this is why
  `facilitator_signer_balance_xlm` in `GET /metrics` is called out as the
  most important signal to alert on, not an optional one.
- **Discovery (`/discovery/resources`, `/discovery/search`)** depends on the
  local PostgreSQL (PGlite) discovery data directory. It degrades
  independently of settlement: a corrupted or locked data directory fails
  discovery but not `/verify`/`/settle` (they don't share a database), and
  conversely a settlement can succeed while cataloging fails silently in
  the background (`onAfterSettle` is best-effort — see "Automatic
  cataloging: provisional at receipt, confirmed at settlement" in
  `docs/architecture.md`; this is the accepted single-point-of-failure this
  prototype ships with, not a hidden one).
- **Single-instance ceiling.** With one process and an embedded PGlite
  instance, 99% is achievable for a lightly-loaded testnet deployment but
  has no failover: a process crash or host failure is full downtime until
  restarted. Getting genuinely production-grade uptime needs the
  multi-instance path in "Scaling path" below (a standalone Postgres
  server, so more than one facilitator process can run behind a load
  balancer) — not built here, named as the concrete next step rather than
  assumed away.
- **What to actually monitor**: `GET /health` (liveness), `GET /metrics`'
  `facilitator_signer_balance_xlm` (the actual settlement-continuity signal),
  and `GET /supported` (catches misconfiguration — see "Monitoring" above)
  — wiring these into real alerting is an operator task this prototype doesn't
  presume to do for them.

## Maintenance and support plan

This project needs a clear maintenance commitment and handoff path:

- **Upstream contribution path.** `specs/schemes/upto/scheme_upto_stellar.md`
  is written in the shape expected by `x402-foundation/x402`, coordinated
  through the x402 Technical Steering Committee — once merged, the spec itself is
  maintained by the Foundation's normal process, not tied to this repo's
  own lifecycle. `docs/developer-guide.md` is similarly written in the
  role-based structure (seller / buyer-agent / operator paths, each with a
  runnable example) the Stellar Developer Docs expect, with the intent of
  contributing it there once this project reaches a stability point worth
  publishing externally — not yet submitted, stated as a planned next step
  rather than a completed one.
- **Spec-evolution tracking, as a real mechanism, not just a promise.** The
  Bazaar discovery layer's behavior (cataloging rules,
  `EXTENSION-RESPONSES` semantics, soft-drop validation) is implemented
  almost entirely by calling into `@x402/extensions/bazaar` rather than
  reimplementing it — see "What's reused vs. original" in
  `docs/architecture.md`. That's a deliberate maintenance decision as much
  as an engineering one: as the Foundation evolves discovery conventions,
  bumping the `@x402/extensions` dependency carries most of that evolution
  forward automatically, rather than this project's own code drifting out
  of sync with the spec. This is now a closed loop, not a one-time
  intention: Dependabot (`.github/dependabot.yml`) opens a weekly PR the
  moment `@x402/core`, `@x402/stellar`, or `@x402/extensions` publish a new
  version, and that PR only merges once the full CI suite — lint,
  typecheck, the complete test suite, both license-compliance checks, and
  all three contracts' own test suites — passes against it. A silent
  upstream spec change either shows up as a passing dependency bump (no
  action needed) or a failing one (surfaced automatically, not discovered
  later by a user). This is the concrete answer to "track the spec as it
  changes... commit to conformance updates through the grant period" —
  a standing pipeline, not a one-time report.
- **Code maintenance.** This repository is intended to remain actively
  maintained past the initial maintenance window; issues and pull requests are the primary
  channel. If maintenance capacity changes, the plan is a clean handoff
  (transferring the repository and the deployed contract's operational
  documentation — not the contract's on-chain authority, which no key
  controls by design; see "no upgrade mechanism" above) rather than letting
  the project go stale silently.

## Incident basics

- **Settlement failing with `invalid_upto_stellar_insufficient_balance`**
  (default escrow design): the buyer's token balance is below the
  settlement amount. Not a facilitator-side problem — direct the buyer to
  fund their account with the settlement asset.
- **Settlement failing with `invalid_upto_stellar_insufficient_allowance`**
  (only possible when the facilitator is running `UPTO_DESIGN=allowance`):
  the buyer hasn't approved (or has exhausted) their allowance to the
  settlement contract. Not a facilitator-side problem — direct the buyer to
  `ensureUptoAllowance` (`@x402-stellar/sdk`) or the equivalent manual
  `approve` call.
- **Settlement failing with `invalid_upto_stellar_fee_exceeds_maximum`**:
  either a misconfigured `feeBps` above the contract's `max_fee_bps()`
  (seller-side config error), or the simulation-derived Stellar network fee
  exceeded `maxTransactionFeeStroops` — see the note in
  `specs/schemes/upto/scheme_upto_stellar.md` ("Transaction Fees") about why
  `upto`'s default ceiling is higher than `exact`'s.
- **Facilitator signer out of XLM**: settlements will fail at the
  `sendTransaction` step. Top up the account; this is why balance monitoring
  above is listed as a minimum signal, not optional.
