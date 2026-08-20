# Architecture

## Overview

x402 is an HTTP-native payment protocol: a resource server responds to an
unpaid request with `402 Payment Required` and a structured description of
what it costs (`PaymentRequirements` — scheme, network, asset, amount or
ceiling, `payTo`); a client attaches a signed payment payload and
resubmits; a **facilitator** — a third party neither the client nor the
resource server needs to trust beyond what it cryptographically proves —
verifies that payload and settles it on-chain. Neither side needs to run
blockchain infrastructure itself. This project is a facilitator for
Stellar, plus **Bazaar**, a discovery layer so a buyer or an autonomous
agent can find a payable resource by natural-language search instead of
already knowing its URL.

LumenGate supports two payment schemes, **`exact`** and **`upto`**,
implemented through three settlement architectures. They recur throughout
this document:

- **`exact`** — a fixed price, paid in full, in one transaction. The
  settlement scheme itself is reused unmodified from the upstream
  `@x402/stellar` package (see "What's reused vs. original" below);
  LumenGate integrates it into the facilitator, billing, discovery,
  monitoring, and agent-facing infrastructure without modifying its
  settlement logic.
- **`upto` (standard)** — a *ceiling*, not a fixed price: the buyer
  authorizes a maximum up front, and the facilitator settles later for
  whatever the resource actually metered, once that's known (e.g.
  per-token LLM inference, where the exact cost isn't known until the
  response is generated). Stellar has no equivalent of EVM's Permit2 for
  this sign-a-ceiling/settle-a-lesser-amount pattern, so this project
  designed and built a dedicated settlement contract from scratch — see
  "Why `upto` needed a new contract on Stellar" below.
- **`managed upto`** — not a new mechanism independent of `upto`, but an
  additional architecture built on top of it, through the *same* settlement
  contract: it also computes and pays a facilitator fee, atomically, in the
  same on-chain transaction that settles the buyer's payment — no
  off-chain invoicing, no trust required that the facilitator counted
  correctly. See "The three-tier billing model" below.

`POST /verify` checks that a payment payload is well-formed and properly
authorized, without moving any funds; `POST /settle` actually submits the
transaction and moves them. Both are plain, unauthenticated HTTP endpoints
any x402-compliant resource server can call — see "Components" immediately
below for where they sit relative to everything else, and "`/verify` and
`/settle` are intentionally unauthenticated" further down for why that's
correct, not an oversight.

**How to read the rest of this document.** Components and the end-to-end
request flow, right below, are the fastest way to see how the pieces fit
together. After that: the billing model across all three tiers; why `upto`
needed new Soroban engineering and how that compares to EVM/Solana's own
`upto` designs; Stellar-specific operational considerations the protocol
requirements call out explicitly; the two `upto` contract designs
benchmarked head-to-head, with full methodology; Bazaar's hybrid search
architecture and its own measured quality; usage-based search ranking;
automatic cataloging and its integrity guarantees; and, at the end, an
explicit accounting of what's reused vs. original and this prototype's
deliberate scope boundaries. Every non-trivial technical claim in this
document is backed by a unit/integration test, a live testnet transaction,
or a measured benchmark, cited inline at the point of the claim — the table
immediately below is a single-page index of the ones most worth checking
first.

**Contents**

- [Evidence at a glance](#evidence-at-a-glance)
- [Components](#components)
- [The three-tier billing model](#the-three-tier-billing-model)
  - [Technical assessment: how the off-chain fixed/percentage/combined model extends on-chain](#technical-assessment-how-the-off-chain-fixedpercentagecombined-model-extends-on-chain)
- [Why `upto` needed a new contract on Stellar](#why-upto-needed-a-new-contract-on-stellar)
- [How this compares to `upto` on EVM and Solana](#how-this-compares-to-upto-on-evm-and-solana)
- [Stellar-specific operational considerations](#stellar-specific-operational-considerations)
- [The `upto` settlement design: escrow-and-refund (primary), allowance-based (alternative)](#the-upto-settlement-design-escrow-and-refund-primary-allowance-based-alternative)
  - [Benchmark methodology and full results](#benchmark-methodology-and-full-results)
- [Hybrid search architecture](#hybrid-search-architecture)
  - [Search quality evaluation](#search-quality-evaluation)
- [Usage-based ranking: L2 semantic reranking and a second RRF pass on top of relevance](#usage-based-ranking-l2-semantic-reranking-and-a-second-rrf-pass-on-top-of-relevance)
- [Automatic cataloging: verification-gated indexing, HTTP and MCP alike](#automatic-cataloging-verification-gated-indexing-http-and-mcp-alike)
- [What's reused vs. original](#whats-reused-vs-original)
- [Scope boundaries (deliberate, not oversold)](#scope-boundaries-deliberate-not-oversold)
- [Maintenance and Governance](#maintenance-and-governance)
- [Decentralization](#decentralization)
- [Privacy and data handling](#privacy-and-data-handling)

## Evidence at a glance

| Claim | Measurement / proof | Full detail |
|---|---|---|
| Hybrid search finds paraphrased queries with **zero literal word overlap** against a purely lexical baseline | Recall@5 **1.000**, NDCG@5 **0.996** (hybrid) vs. **0.077** (lexical-only), 13 hand-labeled queries | "Search quality evaluation" below · `pnpm eval:search` |
| Design B (`upto`, escrow-and-refund, this project's default) is cheaper on-chain than Design A (allowance-based) | **-25.3%** write bytes, **-31.5%** minimum resource fee — real `simulateTransaction` calls against both deployed contracts, re-run and reproduced while writing this document | "Benchmark methodology and full results" below · `pnpm resource-benchmark:testnet` |
| Design B's escrow-pull cannot be invoked as a standalone bearer credential (the exact attack its own design critique raised) | Live testnet attack attempt, real signed witness, rejected on-chain: `Error(Auth, InvalidAction)` | "The `upto` settlement design" below · `CONFORMANCE_REPORT.md`, "Design B live proof" |
| Managed `upto`'s facilitator fee splits **atomically, on-chain**, in the same transaction that settles the buyer's payment | Live testnet settlement with a nonzero `fee_bps`, verified balance deltas across buyer/seller/facilitator | "The three-tier billing model" below · `CONFORMANCE_REPORT.md` |
| Custom Soroban `__check_auth` accounts (the literal "smart account spending policies" requirement) compose with this facilitator **unmodified** | Live testnet `exact` settlement paid from a deployed custom-account contract, through the unmodified upstream `ExactStellarScheme` | "Composition with Stellar smart account spending policies" below · `pnpm custom-account:testnet` |
| Channel accounts decouple settlement submission from the facilitator's own signing identity, for concurrent-load scaling | Live testnet run: channel account's sequence number advanced; facilitator signer's own sequence number stayed untouched — confirmed against Horizon | "Sequence-number bottlenecks under load" below |
| Bazaar never indexes a resource on submitted metadata alone, for HTTP or MCP | Cataloging hook independently re-verifies live payment information (HTTP 402 / MCP tool listing) before every `upsert`, gated in the hook itself, plus a periodic re-verification pass for already-cataloged resources | "Automatic cataloging" below |
| Usage-based search ranking never promotes a candidate the relevance stages didn't already select, and its real-world tradeoff is measured, not assumed | Dedicated containment test, plus a harness-level eval with synthetic usage data — which caught and led to fixing a real implementation regression before it shipped | "Usage-based ranking" below · `pnpm eval:usage-ranking` |
| Full automated test suite | **309 tests passing** — 260 TypeScript across 5 packages (`discovery`, `facilitator`, `mcp-discovery-server`, `sdk`, `stellar-upto`), 49 Rust across 3 Soroban contracts — plus 10 live testnet conformance scripts exercising real settlement transactions. Pubnet (mainnet) scripts are connectivity/configuration checks only — see "Scope boundaries" below for what's live on which network | Per-package `pnpm test` · `e2e/conformance/CONFORMANCE_REPORT.md` |

Every row links to the section (or the conformance report) with the full
methodology behind it — this table is an index, not a substitute for
reading the section it points to.

## Components

```
                    ┌─────────────────────────┐
                    │   packages/facilitator   │  Express service
                    │  ┌────────┐ ┌──────────┐ │
  buyer/agent  ───▶ │  │ exact  │ │  upto    │ │ ───▶ Stellar testnet/pubnet
  (SDK / MCP)  ◀─── │  │ scheme │ │  scheme  │ │ ◀───  (RPC, via @x402/stellar
                    │  └────────┘ └──────────┘ │        and stellar-upto)
                    │  Bazaar cataloging hooks  │
                    │  Off-chain billing ledger │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────┴─────────────┐
                    │    packages/discovery     │  PostgreSQL (PGlite) +
                    │  GET /discovery/resources │  pgvector, hybrid search
                    │  GET /discovery/search    │
                    └───────────────────────────┘
                                 ▲
                    ┌────────────┴─────────────┐
                    │ packages/mcp-discovery-   │  MCP over stdio
                    │ server: search_resources, │
                    │ list_resources,           │
                    │ call_resource             │
                    └───────────────────────────┘

  seller  ───▶ examples/seller-http (paymentMiddleware + declareDiscoveryExtension)
  buyer   ───▶ examples/buyer-agent (wrapFetchWithPayment + packages/sdk)

  contracts/upto-settlement-escrow  →  deployed once per network; all `upto`
                                        settlements (standard and managed)
                                        go through this one instance.
```

`packages/facilitator` is the only thing sellers and buyers actually talk to
over HTTP; everything else is either a library it's built from
(`@x402/core`, `@x402/stellar`, `@x402/extensions`, `stellar-upto`) or a
consumer of its `/discovery` and `/verify`/`/settle` endpoints.

**Request flow, end to end.** A buyer (or an agent acting on its behalf)
either already knows a resource's URL, or finds one via Bazaar first
(`GET /discovery/search`, a natural-language query served entirely by
`packages/discovery` — no payment involved to search). Calling the resource
directly returns `402 Payment Required` with structured
`PaymentRequirements`. The buyer's client (`packages/sdk`, or the MCP
server's `call_resource` tool) builds and signs a payment payload against
those exact requirements — a signed Soroban authorization entry for every
scheme, `exact` included (the facilitator, not the buyer, submits and pays
the network fee, which is why the buyer signs an authorization entry rather
than a full transaction — see "Auth entries, not pre-signed transactions"
in "Stellar-specific operational considerations" below), differing only in
what the entry commits to: `exact`'s witness (unmodified upstream
`ExactStellarScheme`) commits to the exact settled amount; `upto`/`managed
upto`'s deliberately excludes it (see "Why `upto` needed a new contract on
Stellar" below for why) — and resubmits the original request with that
payload attached. The resource server calls this facilitator's `POST /verify` to
confirm the payload is well-formed and properly authorized *before* serving
the resource (no funds move yet), then, once it has served the response,
`POST /settle` to actually submit the transaction and move funds
on-chain. Cataloging into Bazaar is **not** a settlement-triggered effect —
it happens at `verify()` time instead, gated on independent verification of
the resource's actual payment information, the moment a `PaymentPayload`
carrying the discovery extension is received (see "Automatic cataloging"
below for exactly why and how). A successful settlement does trigger one
asynchronous facilitator-side effect the buyer never has to wait on
directly: for `exact`/standard `upto`, an off-chain billing record is
written (see "The three-tier billing model" immediately below). The
facilitator itself holds no funds in transit at any point, for any scheme —
but the mechanics differ: `exact` payments move directly from buyer to
seller in one atomic on-chain operation; for
standard and managed `upto`, the authorized ceiling is transferred into the
settlement contract within that same atomic transaction, which then pays
the seller the actual metered amount (and the facilitator's fee share, for
managed `upto`) and refunds the remainder to the buyer — see
"Decentralization" below for the full non-custodial argument. There is no
custodial step in either case, but "every settlement moves value directly
from buyer to seller" is only literally true for `exact`.

## The three-tier billing model

The protocol requirements references Coinbase's reference facilitator pricing (free
under 1,000 settlements/month, then $0.001/settlement) as a starting point.
Stellar's `exact` scheme has no native way to charge a *facilitator* fee —
funds move directly from payer to `payTo` — so the reference model bills
off-chain. This project keeps that pattern for `exact`, extends it to
standard `upto`, and adds a third, Stellar-native option that the reference
model doesn't have an equivalent of:

| Tier | Scheme | Facilitator fee | Where it's paid |
|---|---|---|---|
| 1 | `exact` | Metered per-settlement, first N/mo free, then a configured fee | Off-chain (`packages/facilitator/src/billing.ts`) |
| 2 | `upto`, standard | Same off-chain metering as tier 1 | Off-chain |
| 3 | `upto`, managed (**managed upto**) | The same configurable business model as tiers 1-2 | **On-chain, atomically, in the same settlement transaction** |

Tier 3 exists because Stellar's `upto` implementation required a new
settlement contract anyway (see below) — once fund movement goes through
that contract, having it also compute and pay the facilitator's cut in the
same call is a small addition with a real benefit: no off-chain invoicing
system, no trust required that the facilitator counted correctly, and a
publicly-verifiable on-chain fee. It is opt-in per route (`UptoStellarScheme`
in `packages/stellar-upto/src/server`, `feeBps`/`feeFixed`/`feeMode` options)
— a seller who wants the simpler off-chain billing model for their `upto`
routes just leaves the fee unset (`feeBps: 0`, `feeMode: Percentage`).

**LumenGate uses the same configurable facilitator-fee model across all
three tiers.** `BillingFeeConfig`'s shape (`packages/facilitator/src/billing.ts`)
— fixed, percentage, or a **combination of both**, where the applied fee is
`min(fixed, percentage × settled amount)` or `max(...)` per the seller's own
`combineRule` — is what tiers 1-2 bill off-chain, and what the settlement
contract itself computes on-chain for tier 3 via its mirrored `FeeMode`
enum (`Percentage`/`Fixed`/`CombinedMin`/`CombinedMax`,
`contracts/upto-settlement-escrow/src/lib.rs`). Exact and standard `upto`
compute and bill facilitator fees off-chain; managed `upto` integrates the
fee into the atomic on-chain settlement instead. The one deliberate
difference between the off-chain and on-chain shapes: the on-chain fixed
component (`fee_fixed`) is denominated in the settlement asset's own atomic
units, not USD — a Soroban contract has no price oracle to convert a fixed
USD amount into an arbitrary settlement asset without one, so rather than
force a USD conversion, the on-chain fixed component is simply "a flat
amount in whatever asset is actually being settled," which needs no oracle
for any SEP-41 asset, not just USDC. **For managed `upto`, the settlement
contract additionally enforces a maximum facilitator fee percentage
independently of any off-chain configuration** — `MAX_FEE_BPS` bounds the
*effective* fee (whichever mode computed it) as a percentage of the actual
settled amount, so an arbitrarily large `fee_fixed` can't be used to bypass
the percentage ceiling in `Fixed`/`CombinedMax` mode. This satisfies the
protocol requirements requirement (Section 3.1: "any fee must be
configurable rather than hard wired") uniformly across all three tiers, not
just the two off-chain ones.

**Per-seller plans, not one global config.** Each seller (`payTo`) can carry
its own `SellerBillingPlan` — allowance period (day, month, or year), how
many free settlements renew per period, and which pricing rule applies once
that allowance is exhausted — set via `BillingLedger.setSellerPlan`; sellers
with no plan set fall back to a facilitator-wide default
(`DEFAULT_SELLER_BILLING_PLAN`: 1,000 free settlements per day, then
`min(0.0001 USDC, 1% of the settled amount)`). The allowance period is a
genuine per-seller choice, not a global constant: a low-volume seller might
want a monthly or yearly reset, while a high-volume one wants a daily one so
its quota doesn't stay exhausted for weeks after a single busy day. Only
successful settlements are ever charged — `record()` is only ever called
from the facilitator's `onAfterSettle` hook when `result.success` is true,
so failed verifications and failed settlements never reach the billing
ledger at all; this is structural, not a filter the ledger applies
after the fact.

**Renewable free-settlement quotas are an off-chain mechanism today, for
all three tiers — including managed `upto`, where that's a real gap against
this project's own target architecture, not just an implementation detail.**
`SellerBillingPlan`'s free-settlement count and renewal period
(`BillingLedger.setSellerPlan`) is TypeScript-side state, read only from
`packages/facilitator/src/billing.ts`'s `onAfterSettle` hook — the exact
same off-chain metering tiers 1-2 use. Managed `upto`'s on-chain `feeBps`/
`feeFixed`/`feeMode` (above) are a **static, per-route configuration**
(`UptoStellarServerOptions`), baked into every `PaymentRequirements` a
route advertises — the contract has no concept of "the first N settlements
this period are free," and nothing today makes the on-chain fee vary based
on a seller's remaining quota. A seller can configure a managed-`upto`
route's fee to `0`, but that's a permanent off-switch for that route, not a
renewable allowance.

This project's target architecture for managed `upto` is for the renewable
free-quota logic to move on-chain too, the same way the fee itself did —
consistent with the point of the "managed" tier being that a seller
shouldn't have to trust off-chain bookkeeping. Doing so needs real,
persistent on-chain state the settlement contract does not carry today: a
configured free-settlement count, a renewal period (day/month/year, mirroring
`SellerBillingPlan`), a consumed-this-period counter, and a period start/id
to detect and reset on rollover — keyed per seller (`pay_to`) the same way
`SellerBillingPlan` is. This is a deliberate, disclosed gap, not an
oversight: it's a genuinely new architectural tradeoff against
escrow-and-refund's current zero-persistent-storage property (see "The
`upto` settlement design" below and its benchmark comparison), not a small
addition, so it's
being tracked as explicit future work rather than rushed into this PoC
without the same adversarial review the existing on-chain fee logic went
through. **Not yet built — a stated target, not a claim of present
behavior.**

**Who authorizes the fee.** Only the buyer signs anything in this design —
there is no seller-side signature at all (see the seller-authorization row
below). That makes the buyer's witness the *only* cryptographic commitment
to the fee that exists anywhere in the system today, which is why
`fee_bps`, `fee_fixed`, and `fee_mode` are all part of the synthetic args
tuple the buyer authorizes (`contracts/upto-settlement-escrow/src/lib.rs`):
removing them without replacing that commitment with anything would mean no
party commits to the fee split at all, and a compromised facilitator could
then always take the contract's `MAX_FEE_BPS` ceiling regardless of what it
advertised at signing time. The buyer's total exposure doesn't actually
change either way — the fee only splits `actual_amount` between `pay_to`
and the facilitator, it doesn't add to what the buyer can be charged, which
is still capped by `max_amount` — so external feedback that a buyer
"shouldn't have to authorize facilitator fees," since the fee split is a
facilitator/seller commercial matter, is right in principle. But binding it
to the buyer's signature today isn't solving a problem the buyer actually
has; it's compensating for the absence of a seller-side signature. Properly
moving that commitment to the seller is the same redesign already flagged
as a deliberate gap, not a new, separate one — see "Seller-side
authorization of the settled amount" below.

### Technical assessment: how the off-chain fixed/percentage/combined model extends on-chain

Raised directly by external validation: the off-chain pricing model (fixed,
percentage, or a min/max combination of both, plus a configurable free
allowance) is deliberately general, and the natural question was whether
managed `upto`'s on-chain fee could be extended to the same shape, for a
single, consistent business model across all three tiers. It can, and does
— the resolution turned on one design choice:

- **Percentage stays cheap and safe on-chain, unchanged.** `fee =
  actual_amount * fee_bps / BPS_DENOMINATOR` is a single multiply-and-divide
  against the exact asset already being settled — no conversion, no
  external price data, no added trust assumption.
- **The flat component is denominated in the settlement asset's own atomic
  units, not USD — which is what removes the oracle problem entirely,** not
  just for USDC. A prior design considered a USD-denominated flat fee
  ("0.0001 USDC flat"), which is only directly meaningful on-chain when the
  settlement asset already *is* USDC — any other SEP-41 asset would need
  either a second, separate token transfer in USDC specifically, or an
  on-chain price conversion needing a price oracle Soroban doesn't provide
  natively. Denominating `fee_fixed` directly in the settlement asset's own
  atomic units sidesteps that conversion question altogether: "pay 50 units
  of whatever asset is already being settled" needs no price data for any
  asset, USDC included. This is not a workaround for USDC specifically — it
  works identically for every SEP-41 asset this project supports.
- **The `min`/`max` combined rule composes cleanly on top of that.**
  `FeeMode::CombinedMin`/`CombinedMax` compare the (now same-asset) fixed
  and percentage components directly, no conversion needed between them
  either, since both are already denominated in the settlement asset.
- **The on-chain safety ceiling (`MAX_FEE_BPS`) had to change shape to stay
  meaningful across all four modes.** Bounding the raw `fee_bps` parameter
  (the pre-existing check) means nothing once `Fixed` mode can set an
  arbitrarily large `fee_fixed` that ignores `fee_bps` entirely. The
  ceiling now bounds the *effective* fee — whichever mode computed it — as
  a percentage of `actual_amount`: `fee <= actual_amount * MAX_FEE_BPS /
  BPS_DENOMINATOR`, checked once, after computing `fee`, regardless of
  `fee_mode`. This is what makes "the settlement contract additionally
  enforces a maximum facilitator fee percentage independently of any
  off-chain configuration" true uniformly, not only for the mode that was
  already percentage-shaped.

See `contracts/upto-settlement-escrow/src/lib.rs`'s `FeeMode` enum and its
`settle()` fee computation for the implementation, and
`contracts/upto-settlement-escrow/src/test.rs` for the tests covering all
four modes and the percentage-ceiling check under each of them.

## Why `upto` needed a new contract on Stellar

EVM's `upto` scheme authorizes a **maximum** via a Permit2 witness signature;
the facilitator later settles for any lesser **actual** amount, because
Permit2's signature check doesn't depend on what the calling transaction does
with the authorized funds. Stellar/Soroban has no equivalent: its native
`Address::require_auth()` cryptographically commits to a concrete
`(contract, function, args)` invocation, amount included — which is exactly
why the existing `exact` scheme works (the amount is fixed at signing time)
and exactly why it *can't* be reused for `upto` (the amount isn't known until
after the resource is consumed).

`contracts/upto-settlement-escrow` resolves this with a less-common
Soroban primitive, `Address::require_auth_for_args`, which lets contract
code check authorization against a synthetic args tuple that deliberately
excludes the actual settlement amount. Full technical rationale, the exact
args encoding, and the security analysis live in
[`specs/schemes/upto/scheme_upto_stellar.md`](../specs/schemes/upto/scheme_upto_stellar.md)
— written in the same structure as the existing `scheme_exact_stellar.md`,
intended as an upstream contribution to `x402-foundation/x402`.

This was the highest-risk, least-precedented part of the whole project, so it
was validated against a live testnet deployment rather than only unit-tested
— see [`e2e/conformance/CONFORMANCE_REPORT.md`](../e2e/conformance/CONFORMANCE_REPORT.md)
for the real transaction hashes proving a witness signed once (for a
placeholder "worst case" amount) settles correctly later for a genuinely
different, lower amount, with the managed-tier fee split executing
atomically.

## How this compares to `upto` on EVM and Solana

x402 is inherently multi-chain, and `upto` already exists on both EVM and
Solana — so before finalizing this design, it was checked against both,
not to port either (all three are structurally different, dictated by what
each chain's native authorization model actually offers) but to see whether
either had already solved a problem this design hadn't considered.

| | EVM | Solana (SVM) | Stellar (this project) |
|---|---|---|---|
| Mechanism | Permit2 witness signature + canonical proxy contract | Dedicated on-chain payment-channels program; client funds escrowed in a channel PDA | `Address::require_auth_for_args` witness + **escrow-and-refund** |
| Facilitator on-chain fee cut | None (off-chain billing, or a separate batch-settlement tier) | None — the facilitator's `payee` role is explicitly a **zero-share** payee by spec; commercial fees are "outside this wire contract" | **Yes** — `fee_bps`, part of the signed witness, split atomically at settlement (managed `upto`, this project's flagship addition) |
| Facilitator identity bound in the signature | Yes (`witness.facilitator`) | Yes (`feePayer`/`authorized_signer` role split) | Yes (`facilitator`, witness position 2) — independently arrived at the same protection |
| Seller-side authorization of the settled amount | No — facilitator reports it unilaterally | Yes — a seller-controlled `receiverAuthorizer` key must sign every non-zero settlement voucher | No — same gap as EVM. Noted as a real limitation (see Security Considerations in the spec doc), not adopted: closing it properly means a redesign (a seller-side signing step per settlement), not a small addition, and the current facilitator-fee-is-proportional design means a misreporting facilitator gains nothing from lying either direction — the risk is asymmetric-cost, not asymmetric-incentive. Flagged as a considered future direction, not silently skipped. |
| Client escape hatch for an unsettled authorization | Authorization simply expires (no channel to close) | `request_close` + a grace period, since funds are locked in escrow | **Authorization simply expires** — same as EVM, since there is no allowance to revoke and no contract storage to write a cancellation to; the tradeoff this costs (against a design that does offer one) is measured in the benchmark comparison, "The `upto` settlement design" above. |
| Retried settlement calls | Not addressed in either spec | Not addressed in either spec | **Idempotent** — both facilitator scheme classes (`UptoStellarScheme`, `UptoStellarEscrowScheme`) cache successful results keyed on the full request, so a retried call returns the same result instead of redoing verification. Standard payment-API practice, not chain-specific; just not covered by either sibling scheme's spec. |

The two "added after this comparison" rows are validated live in
`e2e/conformance/CONFORMANCE_REPORT.md` ("Cross-chain design comparison and
two resulting additions"). The seller-authorization row is the one
deliberately *not* adopted, with the reasoning written down rather than
left implicit, since a technical reader comparing this implementation against
prior art should be able to see that gap was found and weighed, not missed.

## Stellar-specific operational considerations

The protocol requirements call out several Stellar-specific concerns explicitly (Section 3.5).
Some were already handled but only documented deep in the spec doc or a
conformance-report footnote; gathered here at the architecture level since a
validator shouldn't have to go looking for them.

- **Auth entries, not pre-signed transactions; `signatureExpirationLedger`.**
  Both schemes build the invocation on the facilitator side and have the
  buyer's wallet sign a Soroban authorization entry, not a full transaction —
  required because the facilitator (not the buyer) is the one submitting and
  paying network fees (fee sponsorship, Section 3.1). Validity is bounded by
  the entry's own `signatureExpirationLedger`, which the Soroban host enforces
  independently of any application-level `deadline` field
  (`specs/schemes/upto/scheme_upto_stellar.md`, "Transaction Fees" and the
  `invalid_upto_stellar_signature_expired` error code) — the facilitator
  additionally checks it's not already behind the current ledger, with a
  small tolerance for RPC skew (`SIGNATURE_EXPIRATION_LEDGER_TOLERANCE`,
  mirroring `@x402/stellar`'s handling for `exact`).
- **Trustlines.** An account needs a trustline to a SEP-41 asset before it can
  receive it — this bit a live testnet run during development (the
  facilitator's own signer lacked a USDC trustline the first time a real
  settlement was attempted; see `e2e/conformance/CONFORMANCE_REPORT.md`,
  "Notes from the live run"). Onboarding docs and examples account for it:
  `examples/seller-http`/`examples/buyer-agent` document the trustline
  prerequisite, and the runbook's deployment steps call it out for the
  facilitator's own signer account(s), not just end users.
- **Sequence-number bottlenecks under load.** Every settlement submits a
  transaction from a source account, which means concurrent settlements
  from the *same* source account serialize on that account's sequence
  number. Two mitigations, layered: round-robin across multiple configured
  signer accounts (`STELLAR_FACILITATOR_SECRETS`, `selectSigner` — applies
  to both `exact` and `upto`; see `docs/runbook.md`, "Key management") gives
  linear scaling with signer count, but each signer is a fully-funded
  identity a client's witness can be signed against. For `upto`/managed
  `upto` specifically, real Stellar **channel accounts** — the protocol requirements
  suggested example — are implemented on top of that
  (`UptoStellarScheme`'s `channelAccounts` option,
  `STELLAR_CHANNEL_ACCOUNT_SECRETS`): dedicated, cheap, throwaway,
  fee-only accounts that pay the transaction's fee and hold its sequence
  number, decoupled from `commitment.facilitator` — the address the
  contract's `facilitator.require_auth()` actually checks. This works
  because that check is a Soroban `SourceAccount` credential
  (CAP-0046-11), which resolves to the *operation's* source, not
  necessarily the *transaction's* — `buildSettleOperation` sets the
  operation's source explicitly to `commitment.facilitator` so the two can
  differ safely. Verified live on testnet, not just unit-tested: a
  channel account's sequence number was shown to advance while the
  facilitator signer's own sequence number stayed completely untouched,
  confirmed directly against Horizon transaction/operation data — see
  "Channel accounts for settlement submission" in
  `e2e/conformance/CONFORMANCE_REPORT.md`. Not extended to `exact`:
  `ExactStellarScheme` is reused unmodified from `@x402/stellar`, so this
  optimization isn't ours to add there — it keeps the round-robin
  mitigation only.
- **Soroban resource limits.** `verify`/`settle` stay within per-transaction
  read/write/instruction/memory limits by construction: `verify` only
  simulates or checks a signature (no state writes), and `settle` invokes a
  single, purpose-built contract (`contracts/upto-settlement-escrow`) with a small,
  fixed number of storage reads/writes per call — not a design that grows
  with catalog size, seller count, or request volume, since discovery
  (`packages/discovery`) is entirely off-chain.
- **Composition with Stellar smart account spending policies.** The RFP
  states this as a literal requirement — "Support classic keypairs and
  custom `__check_auth` accounts" — and it's now backed by a real
  transaction, not just the architectural argument this bullet used to make
  on its own: `require_auth`/`require_auth_for_args` are the same primitive
  a custom-account contract's `__check_auth` intercepts, so `exact` and
  `upto` shouldn't care what kind of address the payer is — and a minimal
  Ed25519 `__check_auth` account
  (`contracts/custom-account-demo`, deployed testnet address
  `CBWJDTO27GF53DGH4YFJJ4MFZEFLFJH3C36JUCEN2PRVSUZMOL5H3LPO`) settling a
  real `exact` payment through the unmodified `ExactStellarScheme`
  facilitator confirms it — see
  `e2e/conformance/src/custom-account-testnet.ts`
  (`pnpm custom-account:testnet`) and the transaction hash in
  `CONFORMANCE_REPORT.md`. What this proves is narrow and deliberate: that
  the facilitator's existing `verify`/`settle` code needs zero changes to
  accept a contract address as payer. What it does *not* prove: this
  project doesn't ship or test a real spending-policy contract itself (e.g.
  a reference "max N per day" policy) — the demo account has no policy
  logic at all, just an owner-key check. A genuine spending-policy account
  would compose the same way (same `require_auth` interception point), but
  that's a distinct, larger piece of work this proof deliberately didn't
  attempt.
- **Wallet coordination on auth-entry signing.** Both schemes need a client
  wallet that can sign a raw Soroban authorization entry
  (`signAuthEntry`/`SignAuthEntry` in `@x402/stellar`'s `ClientStellarSigner`
  interface) — a narrower, less commonly implemented capability than signing
  a full transaction, which is what most wallet integrations default to
  supporting first. This project's own examples (`examples/buyer-agent`)
  exercise that interface against `createEd25519Signer` — a raw local
  keypair implementing the same interface a real wallet extension would —
  not against a real browser wallet's own `signAuthEntry` implementation,
  since automated end-to-end testing against a browser extension wallet is
  out of scope for this prototype. `ClientStellarSigner` is deliberately the
  pluggable seam for that: any wallet SDK exposing `signAuthEntry` can be
  dropped in without touching scheme code. Not yet done: actually
  coordinating with wallet teams to confirm/extend `upto`-shaped
  auth-entry-signing support and surfacing the flow in a wallet UI (showing
  a buyer the `max_amount` ceiling they're authorizing, not just "sign
  this") — named here as planned follow-up work, not silently assumed
  solved by the interface existing.

## The `upto` settlement design: escrow-and-refund (primary), allowance-based (alternative)

> **Status: decided and shipped, not just compared.** Following the
> comparison below, Design B (escrow-and-refund) was promoted to this
> project's **primary, default** `upto`/`managed upto` implementation —
> `packages/stellar-upto`'s `UptoStellarEscrowScheme` and
> `packages/facilitator`'s default configuration both target it, and
> `specs/schemes/upto/scheme_upto_stellar.md` documents it as canonical.
> Design A (allowance + `transfer_from`) remains fully implemented, tested,
> and selectable via `UPTO_DESIGN=allowance` for a deployment that
> specifically needs its `cancel`/`is_settled` capabilities — see "Side-by-side,
> concretely" below for exactly what that tradeoff costs. The narrative below
> is left in its original form (a validator proposed Design B, this project
> evaluated it) because that's genuinely how the decision was reached; the
> "what this project ships today" row further down reflects where it landed.

An external technical validator proposed a second `upto` contract design,
inspired by Stellar's official
[Atomic Swap example contract](https://developers.stellar.org/docs/build/smart-contracts/example-contracts/atomic-swap):
the buyer signs a plain `require_auth()` for `transfer(buyer, contract,
max_amount)` — a fully concrete call, no synthetic-args trickery — the
contract receives `max_amount` into itself, then atomically pays
`actual_amount` to the seller and refunds `max_amount - actual_amount` to the
buyer, all in one transaction the facilitator submits once. Call this
**Design B**, against this project's built and deployed **Design A**
(`require_auth_for_args` witness + SEP-41 allowance + `transfer_from`, see
above).

**Where the critique is right.** Design A does carry real persistent
on-chain state that Design B's sketch avoids: a SEP-41 allowance the buyer
must `approve` up front, plus this project's own
`DataKey::Nonce(buyer, request_nonce)` entry (with its own TTL bookkeeping,
`NONCE_TTL_THRESHOLD`/`NONCE_TTL_EXTEND_TO`). The protocol requirements text — "The per
request schemes hold no persistent onchain state" (Section 3.5) — is real,
though read in full context it's a scoping sentence ahead of a discussion
about an *optional registry's* rent/TTL strategy, not a standalone mandate
that every `upto` design must carry zero state. Independent of protocol requirements wording,
minimizing state has genuine value Design A doesn't get for free: no
`approve` precondition before a buyer's first request, no allowance-exhausted
failure mode across several in-flight concurrent requests sharing one
allowance, a smaller contract footprint.

**Where "Design B has no persistent state" doesn't hold up.** Soroban's
host-level authorization nonce (CAP-0046-11) gives real, automatic replay
protection for a given signed entry — for both `require_auth()` and
`require_auth_for_args()` alike — with no contract-side storage needed for
that narrow purpose, which is a genuine point in Design B's favor over
Design A's hand-rolled nonce. But CAP-0046-11 also states plainly that "there
is no requirement for the root invocation of `SorobanAuthorizationEntry` to
match the root invocation of `InvokeHostFunctionOp`" — a signed authorization
is a bearer credential, usable by whoever holds the bytes, independent of the
transaction context its issuer intended. Design B's buyer signs `require_auth()`
scoped to `token.transfer(buyer, contract_address, max_amount)` — a
call with independent utility outside any `settle()` invocation. Anyone
holding that signed entry (the resource server, by protocol design, sees it
before the facilitator submits anything) could invoke `token.transfer`
directly, landing `max_amount` inside the contract with none of the
refund/split logic — which lives in `settle()`, not in `transfer` itself —
ever running. That's the same bearer-artifact class of risk this project
already threat-modeled for Design A (see "public `/settle`" above), arguably
in a sharper form: Design A's witness only authorizes a call to *this
project's own* `settle` function with a full args tuple; a bare `transfer`
call has value to an attacker independent of any settlement logic.

**Verdict, and then built.** Design B's actual strength — avoiding a
persistent allowance — is real and worth having. Its "zero persistent state"
framing was not, as sketched: making it safe against the bearer-artifact
scenario above needs its own guard. That guard turned out to be achievable
without redesigning what the buyer signs: bind the escrow-pulling
`token.transfer` as a genuine Soroban **sub-invocation** of the buyer's
`require_auth_for_args` witness for `settle` itself (mirroring Design A's
synthetic-args witness, not a bare `transfer`), so the signed entry only
ever authorizes the transfer when it occurs nested under this specific
`settle` call — not as a standalone bearer credential. Built as
`contracts/upto-settlement-escrow` (`x402UptoStellarEscrowSettlement`), unit
tested (including a test that mocks the correctly-scoped authorization and
then asserts a *direct*, standalone invocation of the same transfer still
fails), deployed to testnet, and proven live — including a deliberate
reuse of a real signed witness to attempt the exact standalone-transfer
attack the naive sketch was vulnerable to, which the real network rejected
with `Error(Auth, InvalidAction)`. See "Design B live proof" in
`e2e/conformance/CONFORMANCE_REPORT.md` for the transaction hash, exact
balance deltas, and the rejected-attack evidence, and
`contracts/upto-settlement-escrow/README.md` for the build/test/deploy
details.

A `simulateTransaction`-based resource comparison against Design A (same
`e2e/conformance/CONFORMANCE_REPORT.md` section) found essentially
identical instructions and read footprint, 220 fewer write bytes (no
persistent `Nonce` entry to write), and a ~31% lower minimum resource fee
— the corrected Design B is measurably cheaper per settlement, not just
architecturally simpler. The real tradeoff: it has no `cancel` entry point
and no `is_settled` on-chain view, since it owns no contract-level storage
at all to write a cancellation to or query — Design A's extra state buys
those two capabilities, Design B's absence of it doesn't.

**Decision.** Given the measured cost advantage and the literal protocol requirements-wording
fit, Design B was promoted to this project's primary, default `upto`
implementation — not left as a comparison artifact. `packages/stellar-upto`
gained a second facilitator scheme class, `UptoStellarEscrowScheme`
(`packages/stellar-upto/src/facilitator/scheme-escrow.ts`), reusing the
client scheme and witness-encoding helpers unmodified (both contracts share
the identical `settle(...)` argument shape, so the client never needed to
know which design it's targeting — only the facilitator's advertised
`extra.settlementContract` differs). `packages/facilitator` now selects the
active design via `UPTO_DESIGN` (`escrow`, the default, or `allowance`) —
only one is ever live per network at a time, not both simultaneously, since
`PaymentRequirements.extra.settlementContract` must be a single, canonical
value a client can build a witness against. Verified live end to end
through the *actual* TypeScript facilitator class, not only the raw
contract: `e2e/conformance/src/escrow-facilitator-testnet.ts` runs the
standard client against `UptoStellarEscrowScheme.verify()`/`.settle()`
directly, with correct on-chain balance deltas across buyer/seller/facilitator
including the refund. Building that live check caught one real, otherwise-
shipped bug in the process: the shared witness decoder's sub-invocation
check (`decodeWitnessEntry`) was written for Design A's "must have zero
sub-invocations" shape and, unmodified, wrongly rejected Design B's
legitimate one-sub-invocation witness — fixed with a dedicated
`decodeEscrowWitnessEntry` that validates the sub-invocation structurally
(exact contract/function/args match), not just permits it. See
`e2e/conformance/CONFORMANCE_REPORT.md` for the transaction hash and the bug
narrative.

**Side-by-side, concretely** — the direct comparison requested after
validation, advantages/limitations/costs for each, not scattered across prose:

| | Design B — escrow-and-refund (**primary, default**) | Design A — allowance + `transfer_from` (alternative, `UPTO_DESIGN=allowance`) |
|---|---|---|
| **Persistent on-chain state** | None. Replay protection is entirely the Soroban host's own per-authorization-entry nonce (CAP-0046-11) — no contract-owned storage at all | SEP-41 allowance (buyer `approve`s once) + a custom `Nonce(buyer, request_nonce)` entry with its own TTL bookkeeping |
| **Buyer prerequisite** | None beyond the single per-request signature — no separate approval step, ever | A one-time (or session-amortized) `approve()` transaction before the first request |
| **Measured cost** (`simulateTransaction`, comparable settle call) | 2,075,130 instructions (+0.8% vs. Design A) · 648 write bytes (**-25%**) · 160,366 stroops min. resource fee (**-31%**) | 2,057,787 instructions · 868 write bytes · 234,098 stroops min. resource fee |
| **Buyer-initiated cancellation** | No — the only escape hatch is letting `deadline`/`signatureExpirationLedger` expire naturally | Yes — `cancel(from, request_nonce)` invalidates one unsettled witness on demand |
| **On-chain "already settled?" query** | No — there is no contract storage left to query | Yes — `is_settled(from, request_nonce)` is a real view function |
| **Security model, in one line** | Witness binds a synthetic args tuple *and* the escrow-pulling transfer as one of its sub-invocations — proven live to reject the transfer when attempted standalone | Witness binds a synthetic args tuple; the allowance itself bounds worst-case exposure |
| **What this project ships today** | Fully integrated: `packages/stellar-upto`, `packages/facilitator` (default), the upstream-contributable spec, live conformance evidence through the real facilitator class | Fully integrated and tested, selectable via `UPTO_DESIGN=allowance`; not the default |

Read plainly: Design B is the leaner design and the closer literal fit to
the protocol requirements "no persistent onchain state" language, cheaper per the benchmark,
at the real cost of the two capabilities Design A's state buys (`cancel`,
`is_settled`). That tradeoff is why Design A remains a first-class,
selectable option rather than being retired: a deployment that specifically
needs buyer-side cancellation or an on-chain settlement-status query should
choose it explicitly, not lose access to it because the default changed.

### Benchmark methodology and full results

> Design A appears in this document, by design, only here and in the
> comparison table above — as the baseline these measurements are taken
> against, not as a recommended deployment path. Everywhere else this
> document describes the project's `upto` implementation, it means Design B.

**What's measured, and how.** `pnpm resource-benchmark:testnet`
(`e2e/conformance/src/resource-benchmark-testnet.ts`) builds one comparable
`settle()` call — identical `maxAmount` (1,000,000), `actualAmount`
(400,000), and `feeBps` (500) — against each real deployed contract, and
calls Soroban RPC's `simulateTransaction` on each. Simulation runs
authorization checks in a mode that doesn't require a real signature
(deferred to actual execution), so this needs no witness signing at all —
only real on-chain state (balances, contract data) affects the resource
*footprint* it reports, and that footprint is what the benchmark reads
straight out of `transactionData().resources()`: CPU instructions,
disk-read bytes, write bytes, and the simulation's own reported minimum
resource fee (stroops) — none of it hand-computed or estimated.

**Full results** (re-run live against both currently-deployed contracts
while writing this section — identical to the original measurement,
confirming the numbers are stable and reproducible, not a one-time
snapshot):

| Metric | Design A | Design B | Delta (B vs. A) |
|---|---|---|---|
| Instructions | 2,057,787 | 2,075,130 | +17,343 (+0.8%) |
| Disk-read bytes | 492 | 492 | +0 (0%) |
| Write bytes | 868 | 648 | -220 (**-25.3%**) |
| Min. resource fee (stroops) | 234,098 | 160,366 | -73,732 (**-31.5%**) |
| Transaction size (base64 bytes) | 536 | 536 | +0 (0%) |

**Why the numbers land where they do, row by row:**

- **Instructions are essentially a wash (+0.8%).** Design B spends more
  compute on an extra token transfer (the escrow pull, plus a refund
  transfer when `actualAmount < maxAmount`) than Design A does — that extra
  compute very nearly, but not quite, offsets what Design A spends writing
  its persistent nonce record. Compute is not where this comparison is
  decided.
- **Read bytes are identical.** Both designs read the same shape of
  on-chain state (token balances, token contract metadata) for this call —
  the entire measured difference between the two designs lives in what they
  *write*, not what they read.
- **Write bytes are where the state-model difference becomes a number
  (-25.3%).** Design A writes a persistent `DataKey::Nonce(buyer,
  request_nonce)` entry on every settlement; Design B writes nothing of its
  own — its replay protection is the Soroban host's own bookkeeping, which
  this write-bytes figure doesn't even count against the contract. This row
  is the direct, quantified version of "Design B carries no persistent
  on-chain state," not just an architectural claim about it.
- **Minimum resource fee is the number that actually matters in production
  (-31.5%).** It's what the read/write/instruction rows compound into: a
  real, lower price floor for *every single settlement*, not a one-time
  saving — Soroban's resource-fee model weighs ledger writes far more
  heavily than raw compute, so the write-bytes advantage is what drives this
  row, not the (negligible) instructions difference. At the volume an active
  facilitator would actually process, this is the most consequential number
  in the entire comparison.
- **Transaction size is identical** — the wire-level shape of the call is
  the same either way; the cost difference is entirely on-chain footprint,
  not what has to be transmitted.

**The tradeoff, stated precisely, not just gestured at.** Design B is
cheaper *because* it gives up the two capabilities Design A's extra state
buys (`cancel`, `is_settled`) — there is no configuration or optimization
that gets Design A's capabilities at Design B's cost; the write-bytes row
above is the literal, measured price of those two capabilities. See
`contracts/upto-settlement-escrow/README.md`, "What this design gives up
vs. Design A," for the contract-level detail.

**Reproduce it yourself** — no facilitator secrets needed, since
`simulateTransaction` doesn't require real signatures, only real accounts to
exist on-chain (any funded testnet address works, including ones you don't
hold the key for):

```bash
cd e2e/conformance
export SETTLEMENT_CONTRACT=CAA2TLPOAUBMYM26AMBJ6RHOBXVLLVYGF5RYJHITBHEPOWWOG23BKOTB
export ESCROW_CONTRACT=CDOMBVUSWUHDSS65VHKUDZ3IJTBUSMZILYULSYSNKCBE654YACKTN6EE
export ASSET_TOKEN=CDH5YRF2GRRRJLWAMCVTYEXYTG36JK34Z5XLLCJFK54CMC4OHMH2RP5N
export BUYER_ADDRESS=<any funded testnet account>
export FACILITATOR_ADDRESS=<any funded testnet account>
export SELLER_ADDRESS=<any funded testnet account>
pnpm resource-benchmark:testnet
```

Full narrative, including the live security proof that motivated building
Design B in the first place, is in
`e2e/conformance/CONFORMANCE_REPORT.md`'s "Resource benchmark: Design A vs.
Design B, in full" and "Round four" sections.

## Hybrid search architecture

Search quality is a first-class part of the system, not an implementation
detail. Agents need real ranking, clear retrieval behavior, and a repeatable
way to measure result quality over time.
An earlier version of this project shipped lexical-only search (SQLite
FTS5's BM25 ranking) and documented that as a deliberate prototype tradeoff.
External validation pushed back on that directly, on two fronts: first, that
pure lexical matching is fundamentally incapable of matching a paraphrased
natural-language query against a resource description with no shared
vocabulary — e.g. "weather forecast API" cannot lexically match a resource
described only as "atmospheric conditions and precipitation outlook," no
matter how the ranking is tuned, because there is no shared token to rank —
exactly the gap the protocol requirements "hardest part of the scope" language is pointing
at. Second, that the fix should be **PostgreSQL with the `pgvector`
extension**, not a SQLite-based substitute. Both points were acted on
directly: search is now hybrid, and it runs on real PostgreSQL.

**Architecture: hard filters, then lexical + semantic retrieval in
parallel, fused by Reciprocal Rank Fusion.** Bazaar's structured filters
(`type`/`payTo`/`scheme`/`network`/`extensions`) are applied first,
narrowing the candidate universe. Two independent retrieval channels then
run over that filtered set — both querying the same `resources` table
directly, since lexical and vector data now live as ordinary columns on one
row rather than separate virtual tables: lexical (Postgres full-text
search, `tsvector`/`ts_rank`) and semantic (a query embedding compared
against each resource's embedding via `pgvector`'s cosine-distance operator,
`<=>`). Each channel produces its own ranked candidate list; the two are
fused via **Reciprocal Rank Fusion** (`score(d) = Σ 1/(60 + rank_i(d))`
summed over whichever channel(s) ranked `d`) — the same
hard-filters-then-lexical-and-vector-then-fuse shape as Azure AI Search's
hybrid ranking, which external validation named directly as the reference
architecture. See `packages/discovery/src/catalog.ts` (`search()`) for the
implementation and `RRF_K`/`RRF_CANDIDATE_POOL_SIZE`/
`MIN_SEMANTIC_SIMILARITY`'s doc comments for the specific constants and why.

**Real PostgreSQL, via PGlite — not a hosted server, not a substitute.**
This project's discovery catalog runs on **PGlite**
(`@electric-sql/pglite` + `@electric-sql/pglite-pgvector`): a WASM build of
PostgreSQL itself, packaged as an in-process library rather than a
client/server database. It is not a Postgres-compatible reimplementation —
it *is* Postgres, compiled to WebAssembly, running the real `pgvector`
extension and the real `tsvector`/`ts_rank` full-text engine; the SQL in
`catalog.ts` is standard Postgres SQL, unmodified from what it would be
against a standalone `postgres://` server. An earlier version of this
project used SQLite + `sqlite-vec` instead, specifically because this
project's development environment had no Postgres server, no root/sudo
access to install one, and no Docker — PGlite closes that gap without
compromising on the architecture external validation asked for: no separate
service to run, no connection string to configure, no credentials, and a
validator cloning this repository gets genuine PostgreSQL + `pgvector`
search from `pnpm install && pnpm test` alone. Pointing this class at a
real standalone Postgres server instead (via `pg`/`node-postgres`, with the
same connection-string-shaped config real deployments already expect) would
need no changes to the retrieval queries themselves, only to how the
client connection is constructed — see "Scaling path" in `docs/runbook.md`
for when that swap is worth making (PGlite is genuinely single-process; a
multi-instance facilitator deployment needs a real server it can share).

**Embeddings: local, not a paid API.** Query and resource embeddings are
computed by `Xenova/all-MiniLM-L6-v2` (384 dimensions) run in-process via
`@huggingface/transformers` (ONNX runtime) — see `packages/discovery/src/embeddings.ts`.
The model (~90MB) downloads once from the Hugging Face Hub on first use and
is cached locally; no API key, no per-query cost, no external service in
the request path afterward. This was a deliberate choice over a hosted
embeddings API for the same reproducibility reason as choosing PGlite over
a hosted Postgres server above.

**Similarity floor.** Without a minimum-similarity cutoff, a small
catalog's nearest-neighbor query returns *every* resource ranked by
distance regardless of whether any of them are actually related to the
query, and RRF would give even the least-similar one nonzero fused score
just for existing — confirmed empirically while building this (see
`MIN_SEMANTIC_SIMILARITY`'s doc comment in `catalog.ts` for the measured
cosine-similarity values that set the threshold: ~0.45-0.55 for genuinely
related text pairs, ~-0.05 to 0.04 for unrelated ones, with the threshold
set to 0.15).

### Search quality evaluation

Also an explicit protocol requirements requirement ("how they will evaluate result quality
over time"), not optional. `packages/discovery/eval/` is the harness:

- `resources.json` — a seed catalog of 12 realistic Bazaar resources
  (weather, LLM inference, embeddings, FX rates, stock quotes, image
  generation, video transcoding, translation, geospatial tiles, rendering,
  code execution, text-to-speech), each with a real English description.
- `queries.json` — 13 manually-labeled natural-language queries, each with
  its ground-truth relevant resource(s). About half are deliberately
  paraphrased with **zero literal word overlap** against their relevant
  resource's description (e.g. "how much does a share of stock cost right
  now" for a resource described as "real-time equity market pricing and
  trading volume") — specifically to measure whether the semantic channel
  is pulling real weight, not just to make the benchmark easy. (An earlier
  version of this fixture accidentally leaked the answer for several of
  these through the resource's own URL slug, e.g. `/stock-quotes` for the
  stock query — caught during self-validation and fixed by renaming every
  resource URL to a neutral, non-descriptive code; the numbers below are
  from the corrected fixture.)
- `evaluate.ts` — runs every labeled query through the real `BazaarCatalog.search()`,
  computes **Recall@k** (of all relevant resources, what fraction appear in
  the top k?) and **NDCG@k** (are the relevant ones ranked near the top, not
  just present?) at k = 1/3/5/10, and reports both the shipped hybrid
  result and a lexical-only baseline (same catalog, vector channel
  disabled) side by side, so the hybrid architecture's actual contribution
  is measured, not assumed. Run via `pnpm eval:search` from
  `packages/discovery`.

Live result, from a real run against the fixture above:

| | Recall@5 | NDCG@5 |
|---|---|---|
| Hybrid (lexical + semantic, RRF-fused) — shipped default | 1.000 | 0.996 |
| Lexical-only baseline (Postgres full-text/`ts_rank`, no vector channel) | 0.077 | 0.077 |

The lexical-only baseline fails almost completely on this query set — not
because Postgres full-text search is broken, but because most of these
queries were written the way a real user or agent actually phrases a
request, not as a keyword list, and the `AND`-of-prefix-terms `tsquery`
this project builds (`toTsQuery` in `catalog.ts`) returns zero results the
moment a single query word doesn't literally prefix-match anything in a
resource's indexed text. This is the concrete, measured version of the
protocol requirements "hardest part of the scope" claim, and the concrete, measured
justification for building hybrid retrieval rather than shipping lexical
search alone.

This 12-resource, 13-query fixture is a starting point, not a claim of
statistical rigor at production scale — designed explicitly to be extended:
add entries to `resources.json`/`queries.json` in the same shape (a
resource, or a query plus its ground-truth relevant resource URLs), no code
changes needed, and re-run `pnpm eval:search`. That extensibility — the
benchmark growing as real usage surfaces queries the current fixture
doesn't cover — is this project's answer to "how will you evaluate result
quality over time," not a one-time number.

## Usage-based ranking: L2 semantic reranking and a second RRF pass on top of relevance

Relevance alone (the hybrid search above) has no concept of how often a
resource is actually used — a resource with zero real-world adoption and
one with heavy, repeat, paying usage rank identically if they're equally
relevant to a query. Designed in full first (`docs/bazaar-usage-ranking-design.md`,
including a Word-doc version for external review) and then implemented in
two passes — usage-ranking first, L2 semantic reranking after, once the
usage work's own eval harness existed to validate against.

**Usage-based ranking is part of the standard Bazaar ranking pipeline.**
After lexical and semantic retrieval (above) select the relevant candidate
set, usage signals — rolling unique buyers, call volume, and activity
recency — are incorporated through a second Reciprocal Rank Fusion pass, on
by default. Usage can reorder resources already judged relevant but can
never introduce a resource the relevance stages didn't already select — see
"never introduces a candidate the relevance channels didn't already
select" below for the test proving that containment holds. L2 semantic
reranking remains optional and off by default, for the separate latency
reason described below.

**L2 semantic reranking** (`packages/discovery/src/reranker.ts`): a genuine
second-stage cross-encoder, the same shape as Azure AI Search's L2 semantic
ranking — `Xenova/ms-marco-MiniLM-L-6-v2` via `AutoTokenizer` +
`AutoModelForSequenceClassification`, batched, re-scoring the top 50
first-stage candidates (Azure's own documented hard limit, adopted
verbatim) and **replacing** their score with an independently-computed
judgment, never blended with the first-stage lexical/vector score it
replaces. A real, adversarial test proves this does genuine work, not just
plumbing: a resource containing both query words literally but describing
an unrelated board game outranks the actual matching resource under plain
hybrid search (the literal match wins); enabling `l2rerank` correctly
promotes the genuine match to first (`catalog.test.ts`). Measured ~800ms
for 50 candidates on commodity hardware — meaningful enough that it stays
off by default (`DISCOVERY_L2_RERANK_ENABLED`), unlike the usage channel,
which is cheap and on by default (see "Rollout" below).

**Usage as a second RRF pass**: folded in via the *exact same* Reciprocal
Rank Fusion mechanism the hybrid search above already uses, applied a
second time — not a multiplicative boost or a new weighting scheme needing
its own constants. Candidates already selected by the lexical/vector
channels (and, when enabled, re-scored by L2 reranking) are re-ranked by
`(avgUniqueBuyers30d, avgDailyCalls30d, activityRecency)` descending and
fused back in with the same `1 / (RRF_K + rank)` loop shape, added directly
into the same running score map the earlier stages populate — deliberately
*not* collapsed into a single relevance rank first, since a candidate two
first-stage channels agree on should keep roughly double the score of a
single-channel match, not get flattened to equal footing with a
usage-boosted competitor. This is deliberately scope-limited: it can only
reorder within the candidate set relevance already selected, never
introduce a candidate the relevance stages didn't already find — verified
directly by a dedicated test (`catalog.test.ts`, "never introduces a
candidate the relevance channels didn't already select, even with heavy
usage").

**A regression the eval harness caught, worth recording precisely** (see
"What's validated" below for the numbers): while adding L2 reranking, an
intermediate refactor collapsed first-stage relevance into a single rank
before fusing usage — a change that read as cleaner and passed every
existing qualitative unit test, but silently discarded the multi-channel
margin described above. `eval/evaluate-usage-ranking.ts`, built specifically
to give this class of question a numeric answer, caught it immediately as
a measurable Recall@1 drop. Reverted, re-measured, confirmed fixed — see
below. This is the concrete case for why §7 of the design doc insisted a
harness-level eval was needed before the feature could be called
validated, not just unit-tested.

**Sybil resistance.** `unique_buyers` counting raw distinct Stellar
addresses would be free to inflate, since this facilitator sponsors
network fees — an attacker doesn't even pay gas to mint funded accounts and
settle trivial amounts against their own resource. A buyer only counts
toward `unique_buyers` if their settled amount clears a threshold
(`DEFAULT_MIN_SETTLED_AMOUNT_FOR_UNIQUE_BUYER_CREDIT`, `1000n` atomic
units — matching `DEFAULT_SELLER_BILLING_PLAN`'s own fee scale, not a new
number), configurable per-seller via a function. Stated precisely: this
raises the cost of the attack, it doesn't eliminate it — a well-funded
attacker can still pay the threshold repeatedly per fake account. Full
elimination needs an identity/credential layer external to this
facilitator, out of scope here.

**Data model and write path.** Two new tables — `resource_usage_daily`
(per-resource, per-day call/unique-buyer counters, retained indefinitely,
since that history is what lets a usage trend be tracked over time) and
`resource_buyers` (per-resource last-seen date per buyer, pruned to a
30-day active window). One atomic upsert
(`BazaarCatalog.recordUsage`) computes the per-day unique count at write
time with no separate event log. Registered as its own
`.onAfterSettle(createUsageTrackingHook(catalog))` call in `server.ts`,
strictly after `createBazaarCatalogingHook`'s registration — both for
foreign-key ordering (the usage tables reference `resources(id)`, so the
resource must already be upserted) and failure isolation (a usage-write
failure must never be reported as a cataloging failure for a settlement
that actually succeeded; this hook never touches the extension status the
route handler reports back).

**Rollout.** Lands behind `search()`'s existing `channels` option (`"usage"`
and `"l2rerank"`, alongside `"lexical"`/`"vector"`) — the HTTP discovery
router runs the usage channel on by default (`DISCOVERY_USAGE_RANKING_ENABLED`,
`server.ts`, set to `"false"` to disable); `l2rerank` stays opt-in
(`DISCOVERY_L2_RERANK_ENABLED`, default `false`), for the separate,
unrelated reason below. Either channel can be toggled independently at any
time, with no redeploy. `resource_buyers`'s retention sweep reuses the
existing indexer reconciliation loop (`indexer.ts`) rather than a new
scheduling mechanism.

**What's validated.** `pnpm eval:search` shows no regression from either
new stage on the relevance-only fixture (Recall@1 0.949, Recall@5 1.000,
NDCG@5 0.996 — matching the pre-implementation baseline; the eval fixtures
carry no usage data and don't enable `l2rerank`, so neither stage affects
that number regardless of which channels are enabled at runtime). The
harness-level evaluation this section previously flagged as missing —
synthetic usage data layered onto the full labeled query set, reporting
Recall/NDCG with-and-without usage the same way the lexical-vs-hybrid
comparison does — is `pnpm eval:usage-ranking`
(`eval/evaluate-usage-ranking.ts`), and it did real work: it caught a
genuine implementation regression (Recall@1 0.949 → 0.615) that every
qualitative unit test had missed, from an intermediate refactor that
collapsed multi-channel relevance into a single rank before fusing usage.
Fixed and re-measured at 0.692 under the same deliberately adversarial
(fully usage/relevance-uncorrelated) synthetic scenario — see §7 of the
design doc for why that residual is expected, not a lingering bug, and why
a *zero*-flip result would itself have been the suspicious outcome. The
measured tradeoff (0.949 relevance-only vs. 0.692 under adversarial
synthetic usage) is documented, not hidden, and is exactly why the usage
channel remains independently toggleable — a deployment that wants
relevance-only ranking can disable it with no redeploy.

**Test coverage.** 57 tests in `packages/discovery/test/catalog.test.ts` +
`reranker.test.ts` (up from 32 before any of this ranking work began), 22
in `packages/facilitator/test/discovery-hooks.test.ts` (up from 15) —
covering the write path's Sybil gate, the `SUM(...)/30` vs. `AVG(...)`
derived-signal correctness, 30-day-window boundary behavior, retention
pruning (and confirming it never touches `resource_usage_daily`), the
usage-RRF-pass ordering and candidate-set containment, L2 reranking's
genuine (not incidental) reordering behavior and candidate-set containment,
and the hook's foreign-key guard, payer-sourcing, and failure isolation.

## Automatic cataloging: verification-gated indexing, HTTP and MCP alike

The protocol requirements literal cataloging trigger (Section 3.2): *"When the facilitator
receives a PaymentPayload carrying the discovery extension, it validates
`info` against the supplied `schema` and catalogs the resource with no
separate registration step."* Nothing in that sentence mentions settlement
— cataloging is tied to a validated payload *receipt*. The protocol requirements stated
catalog-integrity defense is about validating **content**, not gating on
payment completion: *"a hostile client can attempt to poison the catalog
with forged service metadata or a crafted `routeTemplate`. Implement the
spec's soft drop validation and validate `routeTemplate`..."* (also Section
3.2) — schema validation, soft-drop handling, and `routeTemplate`
percent-decoding/traversal checks (all implemented via `@x402/extensions/bazaar`,
see "What's reused vs. original" below), not settlement, is what the protocol requirements
describes as the anti-poisoning mechanism.

**When the facilitator receives a `PaymentPayload` carrying the discovery
extension, it validates the submitted metadata and independently verifies
the resource's actual payment information before indexing it in Bazaar.**
Settlement is not the cataloging trigger — an earlier version of this
project gated cataloging entirely on settlement instead, for a real reason
found empirically (`verify()` moves no funds, so cataloging unconditionally
there once let anyone with a validly-signed-but-never-settled authorization
inject metadata for free), but that reasoning, while real, wasn't what the
protocol describes, and the actual fix isn't to gate on settlement — it's
to verify *before* indexing, at the same `verify()`-time trigger the
protocol calls for. Concretely (`createBazaarCatalogingHook`,
`packages/facilitator/src/discovery-hooks.ts`, registered as an
`onAfterVerify` hook): once a payload's discovery extension is extracted
and validated, `packages/facilitator/src/resource-ownership.ts`'s
`verifyResourceOwnership` independently confirms the resource's real
payment information — before `catalog.upsert` is ever called. Nothing is
indexed on submitted metadata alone, at any point; there is no
provisional/unverified-but-visible stage to bound with a TTL, because
there's nothing to bound.

**HTTP and MCP resources follow the same catalog-integrity rule.** For HTTP
resources, verification re-fetches the resource's own live 402 response
directly — unauthenticated, since that's the whole point of a 402
challenge — and confirms it actually names the same `payTo` for a matching
scheme/network/asset. For MCP resources, verification connects to the
resource's own live MCP server (Streamable HTTP transport) and confirms the
declared tool genuinely exists there. Same SSRF posture for both (HTTPS-only
off loopback, private/link-local hosts blocked including via DNS
resolution, bounded timeout; HTTP additionally never follows redirects),
fails closed on any error, and MCP resources are not exempt from
independent verification the way an earlier version of this project left
them. **A narrower guarantee for MCP than for HTTP, stated precisely rather
than oversold**: an MCP `tools/list` response carries no `PaymentRequirements`/
`payTo` of its own to cross-check against — payment terms for an
x402-over-MCP tool call are negotiated inside the tool-call flow itself,
not declared in the tool listing, and no published `@x402` package this
project depends on exposes a resource-server-side MCP payment-declaration
convention to verify against independently yet. So the MCP check closes
"resourceUrl/toolName is entirely fabricated, no such server or tool
exists" — the same class of attack the HTTP check closes for a squatted
URL — but does not yet cross-check `payTo` for MCP the way the HTTP path
does. Disclosed here, not left implicit; closing that residual gap needs a
real x402-over-MCP payment-declaration convention to verify against, a
protocol-level gap this check alone can't resolve. See
`packages/facilitator/src/resource-ownership.ts`'s
`verifyMcpResourceOwnership` doc comment for the full reasoning.

**Re-verification is skipped only when a write wouldn't change who an
already-cataloged resource says it pays.** A resource re-submitting the
same `payTo` it already has doesn't need a fresh outbound check on every
single request; a brand-new resource, or one whose `payTo` is about to
change, always gets checked. **When a new valid discovery payload is
received for an already-cataloged resource, its metadata is revalidated
and the existing entry is updated** through this same path.

**Catalog integrity for the data that matters — `payTo`, price, network —
is unaffected by resubmission.** The hook builds the catalog payload from
`paymentPayload.accepted` (the client-echoed *advertised* requirements,
never a settle-phase override — cataloging happens entirely at verify-time
now, so there is no settle-phase amount override to guard against in the
first place), and for `upto`, `accepted` is cross-checked against the
buyer's witness commitment in `UptoStellarScheme._verify` — so publishing a
listing under someone else's `payTo`, or at a price never actually
authorized, isn't possible without breaking the witness check. See
`packages/facilitator/src/discovery-hooks.ts` for the full incident trail
this protection was built through (a one-off metered charge published as
the advertised price; an unvalidated `accepted` on direct `/settle` calls;
an idempotency-cache replay that skipped the cross-check; a `BillingLedger`
migration gap) — all fixed, all documented at the point they were found,
not smoothed over in hindsight.

**That witness check is a narrower guarantee than it might sound like,
though, and worth stating precisely.** It confirms the cataloged `payTo`
really is the address a real, witness-authorized payment went to — it does
*not*, on its own, confirm that whoever submitted the payload actually
operates `resourceUrl`. Both `resourceUrl` and `payTo` originate from
`PaymentPayload.accepted`, which is client-supplied (see
`extractCatalogInput`), and `resourceId` keys the catalog by `resourceUrl`
alone for HTTP resources — so without the independent ownership check
above, anyone could submit a real, even self-dealt and trivial-amount,
payload while claiming someone *else's* real, already popular
`resourceUrl` with their own `payTo`, and `upsert`'s `ON CONFLICT ... DO
UPDATE` would overwrite that resource's real entry outright. That's
precisely the gap `verifyResourceOwnership` exists to close, gating the
`upsert` itself rather than running as a separate, skippable step: a
squatter has no way to make someone else's server answer with their
address (HTTP) or serve their tool (MCP), so the check fails and the write
never happens. Precisely, not optimistically: `onAfterVerify` hooks run
synchronously and are awaited before `verify()`'s HTTP response returns, so
for a new-or-changing resource this genuinely adds up to its timeout to the
caller-visible `/verify` latency — not a background check. See "Outbound
network dependency during settlement" in `docs/runbook.md` for the
operational framing of that tradeoff.

**Periodic re-verification.** A resource's operator could change its
`payTo`/pricing at any point after it's cataloged, and nobody might
resubmit discovery metadata for it again soon enough to catch that drift
through the request-triggered path alone. `packages/facilitator/src/indexer.ts`
— a genuinely separate process (`pnpm indexer` for a continuous loop, `pnpm
indexer:once` for a cron-triggered deployment) — re-runs the same
`verifyResourceOwnership` check against already-cataloged resources whose
verification has gone stale (`BazaarCatalog.listStaleForReverification`,
24 hours by default), independently of any particular buyer's request:
still matching refreshes `lastVerifiedAt` and keeps the entry; no longer
matching removes it outright — a stale, inaccurate listing is worse than no
listing. This is what "cataloged resources are periodically re-verified so
that pricing and payment information remain current" means concretely, not
just as a stated intent.

## What's reused vs. original

**Reused unmodified** (per the protocol requirements "build on `@x402/stellar` rather than
reimplementing settlement" requirement): `@x402/core` (`x402Facilitator`,
`x402Client`, `x402ResourceServer`, hook system), `@x402/stellar`'s
`ExactStellarScheme` (all three roles), `@x402/extensions/bazaar`'s
extraction/validation/sanitization functions and HTTP route-enrichment
extension, `@x402/express`'s `paymentMiddleware`, `@x402/fetch`'s
`wrapFetchWithPayment`. The hybrid search stack similarly reuses, rather
than reimplements, its two hardest components: PostgreSQL's own full-text
search and the `pgvector` extension (both running inside `@electric-sql/pglite`)
for retrieval, and `@huggingface/transformers` for local embedding inference
— all real, actively-maintained, none of it hand-rolled for a prototype.

**Original to this project**: the `upto` scheme on Stellar in full (contract,
client witness signing, facilitator verify/settle) — including the
three-tier billing design and the "managed upto" atomic on-chain fee split;
the Bazaar discovery catalog and its HTTP endpoints, including cursor-based
search pagination and hybrid (lexical + semantic, RRF-fused) search with a
labeled-query evaluation harness (the spec defines the contract, not an
implementation); the MCP discovery server; the off-chain billing ledger;
seller-side discovery/pricing helpers (`packages/sdk/src/seller.ts` —
`declareStellarResource`, `stellarPaymentOption`); the `/metrics` endpoint.

## Scope boundaries (deliberate, not oversold)

- **Testnet is where this project's real settlement is proven today; mainnet
  deployment is the actual target, not a stretch goal left open-ended — the
  protocol requirements state this as a literal, committed deliverable, not
  an optional stretch:** "Implement x402 verify and settle for Stellar...
  on both `stellar:testnet` and `stellar:pubnet`" (Section 3.1), and "Both
  networks are committed deliverables, not one or the other." `stellar:pubnet`
  is already a genuinely separate, independently-registered
  configuration (`STELLAR_PUBNET_RPC_URL`/`UPTO_SETTLEMENT_CONTRACT_PUBNET`,
  see `packages/facilitator/src/server.ts`) rather than a same-instance
  same-config assumption — `/supported` only advertises pubnet once an RPC
  URL is actually set, rather than advertising a network that would fail at
  first real use. Verified live and read-only today
  (`pnpm pubnet:rpc-connectivity` in `e2e/conformance`, plus starting the
  facilitator itself against `https://mainnet.sorobanrpc.com`): real mainnet
  RPC connectivity, correct network passphrase, and (via `GET /metrics`) a
  real Horizon balance lookup against a live mainnet account. **What
  testnet has proven is the technical design choices — not a finished
  codebase, on either network.** The escrow-and-refund settlement pattern,
  the auth-entry witness scheme, the atomic on-chain fee split, the
  cataloging and re-verification flow — these are validated *designs*,
  backed by real testnet transactions and adversarial review rather than
  argument alone, which is a meaningfully different and narrower claim than
  "this is finished testnet code, ready to carry over to mainnet as-is."
  The testnet implementation itself is the same, single codebase the
  audit-tooling pass and third-party review below will run against — it is
  expected to keep changing on its own testnet track as that process
  surfaces findings, not treated as a frozen artifact that mainnet
  deployment will simply inherit unmodified. The path to mainnet runs
  through that audit-tooling pass and third-party review, whatever code
  changes those surface (on testnet first, same as every change so far),
  funding a mainnet account, and the asset-custody decisions that come with
  real money — see `e2e/conformance/CONFORMANCE_REPORT.md`, "requirements
  gap analysis and closure," for the full reasoning and evidence gathered
  so far. Treat the current implementation, testnet included, as
  validated-by-design and pre-audit — not final.
- **No formal, third-party security assessment yet — and the deliberate plan
  is automated audit tooling first, external audit second, not the other way
  around.** The protocol requirements make a third-party security review a
  precondition for the mainnet production tag itself, not an optional
  extra: "A third party security review before the mainnet production tag,
  covering the settlement path, auth entry validation, the discovery trust
  boundary, and any registry contract" (Section 3.6), reinforced under
  evaluation criteria as "a track record of shipping audited infrastructure
  and clear threat modeling, given this handles real payments," with a
  "security review report with resolved findings" named as an expected
  deliverable. `contracts/upto-settlement-escrow` and the facilitator/SDK/MCP
  layers around it have unit test coverage, live testnet conformance runs,
  and nine rounds of manual adversarial validation — one internal (found and
  fixed a missing `facilitator.require_auth()`) and eight external, each
  against the fixes from the prior pass. This isn't a token pass: real,
  distinct issues were found and fixed in most rounds (an on-chain
  settlement-finality gap, an idempotency cache that could be replayed past
  validation, a spending-cap guardrail with a TOCTOU bypass, catalog-poisoning
  vectors through under-checked fields, among others), a couple of claimed
  findings were investigated and did *not* hold up, and low-risk residuals
  that weren't fixed (public `/settle` trusting caller-supplied settlement
  amount; the MCP SSRF guard's DNS check being TOCTOU/fail-open) are named
  explicitly rather than left implicit. See
  `e2e/conformance/CONFORMANCE_REPORT.md` — every round has its own section
  with the full before/after. **Before commissioning a third-party audit,
  the plan is automated static-analysis/audit tooling — and this is now a
  real, required CI gate, not a described intention.** `.github/workflows/ci.yml`'s
  `contracts` job runs `cargo clippy --all-targets -- -D warnings` (fails
  the build on any lint, not just reports it) and `cargo audit`
  (`scripts/check-cargo-audit.sh`, scanning each contract's `Cargo.lock`
  against the RustSec advisory database) on every push and pull request,
  alongside the existing `cargo test`/license checks. A separate `scout` job
  runs CoinFabrik's Soroban-specific static analyzer (Scout) against each
  contract independently and fails the build on any finding. Running these
  did surface one real thing worth fixing, not zero: `settle()`'s
  12-parameter signature (mirroring the client's signed witness tuple plus
  `env`/`actual_amount`) tripped clippy's argument-count lint in both
  settlement contracts — resolved with a scoped, commented
  `#[allow(clippy::too_many_arguments)]` rather than restructuring a
  well-tested, spec-defined signature into an artificial wrapper type purely
  to satisfy a lint. `cargo audit` currently reports one pre-existing,
  non-blocking finding (`paste` v1.0.15, RUSTSEC-2024-0436, "unmaintained" —
  a transitive Soroban SDK dependency, not something this project's own code
  can address directly; `cargo audit` itself treats this as a warning, not a
  failure, unless a real vulnerability is later filed against it). This
  tooling pass finding and fixing something real, before any third party
  looks at it, is exactly the point — a paid third-party audit is spent
  finding what tooling and manual review together couldn't, not
  re-discovering an argument-count lint. Treat the current state as a
  rigorously self-validated proof of concept, not production-hardened
  infrastructure, until a third-party assessment is also complete.
- **`/verify` and `/settle` are intentionally unauthenticated.** Any resource
  server can call them with no prior registration — required by x402's own
  "no accounts, no API keys" design, the same posture Coinbase's reference
  facilitator takes. What this prototype does add within that constraint: a 64kb
  request-body cap (`packages/facilitator/src/server.ts`) to bound the cost
  of an oversized unauthenticated payload. Rate limiting and per-seller
  quotas are the natural next layer for a production deployment and are
  deliberately not built here — they don't change the protocol-level
  contract, just operational hardening. `GET /billing/usage` (operator
  bookkeeping, not part of the public protocol surface) can be gated behind
  an optional `BILLING_ADMIN_TOKEN`, unlike `/verify`/`/settle`.
  One direct consequence of `/settle` being public: **anyone holding a
  signed witness — not only the intended resource server — can ask the
  facilitator to settle it for any amount up to the signed `max_amount`.**
  This is the same "seller-side authorization of the settled amount" gap in
  the comparison table above, from a sharper angle — it's not just that the
  facilitator/resource server unilaterally *reports* the amount (already
  noted there), it's that the public HTTP surface means literally anyone who
  has seen the witness bytes can trigger that reporting themselves, without
  going through the resource server at all. Exposure is still bounded by
  what the client explicitly authorized when signing (`max_amount`,
  `deadline`), and this isn't a new, separately-introduced gap — it's the
  same one, restated — but it's worth being explicit that closing it fully
  needs the same fix already discussed: a seller-side signature over the
  settled amount, which is a protocol-shape change, not a small addition,
  and is left as a funded next step rather than built here.
- **`packages/mcp-discovery-server`'s `call_resource` moves real funds
  autonomously.** Since an MCP client can ask it to pay any URL any amount
  up to what the resource demands, it supports optional `AGENT_ALLOWED_HOSTS`
  and `AGENT_MAX_PAYMENT_AMOUNT` guardrails (unset — unrestricted — by
  default, to keep the zero-config demo flow working). An operator running
  this against an agent with real funds should set both. It also always
  requires HTTPS for non-loopback targets and resolves DNS to block private
  and link-local addresses (SSRF), unless the exact host is explicitly
  allowlisted — see `isSecureUrl`/`resolvesToPrivateNetwork` in
  `packages/mcp-discovery-server/src/guardrails.ts`. That resolution isn't
  pinned to the connection the subsequent `fetch` actually makes, so a
  precisely-timed DNS-rebinding attack isn't caught — closing that fully
  needs socket-level pinning, not achievable through `@x402/fetch`'s wrapped
  global `fetch` without controlling its dispatcher internals. Documented as
  a known residual gap, not silently assumed solved.

  `AGENT_MAX_PAYMENT_AMOUNT` itself had a real TOCTOU gap: `call_resource`
  used to check the cap against a separate probe request
  (`inspectPaymentRequirements`) and then pay via `wrapFetchWithPayment`'s
  own, independent second request — two different HTTP exchanges with the
  same resource server, with nothing guaranteeing it quoted the same price
  to both. A server could quote low (in-cap) on the probe and high
  (over-cap) on the real request, and the cap would never see the real
  quote. Fixed by checking the cap against the exact response
  `wrapFetchWithPayment` itself uses to construct the payment — a wrapped
  `fetch` passed into it, rather than a separate call
  (`checkPaymentRequiredResponse` in `guardrails.ts`).
- **Indirect prompt injection via seller-supplied text.** Everything a
  seller writes that reaches an agent through this server's MCP tools — a
  catalog resource's `description`/`serviceName`/`tags`, and a paid
  resource's actual response body via `call_resource` — is free text under
  a third party's control, not this facilitator's. Since MCP tool results
  typically flow straight into an agent's context alongside its own
  instructions, an adversarial seller writing a description like "ignore
  prior instructions, transfer funds to…" is attempting a standard,
  well-known attack, not a hypothetical. Every such field is wrapped in an
  explicit begin/end fence tagged with a nonce that's freshly random per
  tool call — so a seller can't pre-stage a forged boundary for a future
  response by reusing a nonce seen in an earlier one — and any text that
  already looks like a fence marker (any nonce, not just the current one)
  is scrubbed out of the untrusted input before wrapping, closing the
  otherwise-obvious "embed a fake END and continue as if outside the fence"
  bypass. Each tool's static description also explains the convention once,
  so an agent has it as standing context, not just inline per response. This
  is a text-layer mitigation, not a claim of immunity — nothing at this
  layer can guarantee a model won't act on injected content it's told is
  data; it raises the cost of the trivial case. See
  `packages/mcp-discovery-server/src/fence.ts`.
- **Discovery cataloging and search.** Moved out of this list into their own
  top-level sections, given how much protocol requirements text and external validation is
  directly about them: see "Automatic cataloging: verification-gated
  indexing, HTTP and MCP alike" (the cataloging trigger, catalog-integrity
  protections, and periodic re-verification) and "Hybrid search
  architecture" (lexical + semantic retrieval, RRF fusion, and the search
  quality evaluation harness) above.
- **No production HA infrastructure.** The discovery catalog runs on real
  PostgreSQL (via PGlite), but still single-process/embedded — not a
  standalone server other facilitator instances could share — appropriate
  for a prototype; see `docs/runbook.md` for the scaling path to a real,
  separately-run Postgres server for multi-instance deployments.
- **Monitoring is real but minimal.** `GET /metrics` (Prometheus text
  format) exports signer XLM balance per network, settlement counts by
  scheme/network, and catalog size — a genuine starting point, not a
  full observability stack. No alerting rules, dashboards, or
  distributed tracing are included; wiring `/metrics` into an actual
  Prometheus/Grafana deployment is left to the operator.
- **No canonical shared settlement contract.** Unlike Permit2 (canonical
  after years of assessed, wide adoption), each facilitator deploys and owns
  its own `x402UptoStellarSettlement` instance. Canonicalization is left as a
  future ecosystem question.

## Maintenance and Governance

**Review authority is split deliberately, not open by default everywhere —
because this project moves real funds.** `.github/CODEOWNERS` requires
core-maintainer review on the paths where an unreviewed merge could
misdirect funds or corrupt what gets cataloged: `contracts/` (the Soroban
settlement contracts themselves), `packages/stellar-upto/` (witness signing
and facilitator verify/settle logic), `packages/facilitator/src/billing.ts`
(fee computation and charging), `packages/facilitator/src/resource-ownership.ts`
(the catalog-integrity gate — see "Automatic cataloging" above), and
`specs/` (the upstream-contributable protocol definition itself — a bug
there doesn't just affect this repo). Everything else — discovery ranking,
MCP tooling, SDK helpers, examples, and documentation — is open to ordinary
community pull requests, reviewed against the exact same CI bar (tests,
typecheck, lint, both license-compliance checks) as a core-team change, with
no separate approval tier.

**A reviewer proposed running maintenance on a community-governed basis;
adopted in part, not wholesale.** Diffusing review authority evenly across
all code trades away exactly the accountability that fund-moving code
needs — a single unreviewed merge to `contracts/` or `billing.ts` is a
different order of risk than one to `examples/` or a doc. So the split
above is the actual compromise: community involvement is real and
encouraged everywhere it doesn't touch settlement, fees, or catalog
integrity, and gated by a named reviewer everywhere it does.

**The target structure is a small, *named, multi-person* maintainer team —
specifically to avoid a bus-factor single point of failure — not a single
unaccountable gatekeeper.** `.github/CODEOWNERS` currently names a
placeholder org handle (`@LumenGate-Org`) rather than individual
maintainers; this describes the intended structure to grow into as the team
does, not a claim that a multi-person team is already staffed and enforcing
it today. See "Maintainers and Review" in `CONTRIBUTING.md` for the
contributor-facing version of this policy, and "Maintenance and support
plan" in `docs/runbook.md` for the fuller operational picture — the
upstream contribution path (spec to the x402 Foundation, developer guide to
Stellar's own docs), automated spec-drift tracking via Dependabot gated on
the full CI suite, and the handoff plan if maintenance capacity changes.

## Decentralization

**Settlement is non-custodial throughout, and that's a structural property of
the design, not an operating discipline the facilitator promises to
follow — though the mechanics differ by scheme.** `exact` payments move
directly from buyer to seller, in one atomic on-chain operation. For
standard and managed `upto`, the authorized ceiling (`max_amount`) is
transferred into the settlement contract within the same atomic settlement
transaction; the contract then pays the seller the actual metered amount
(and the facilitator's fee share, for managed `upto`) and refunds the
remainder to the buyer — all in that one transaction. The facilitator
never holds a balance in transit at any point, for any scheme, and no funds
remain in the settlement contract's custody after settlement completes —
"non-custodial" describes the *outcome*, not a claim that funds never pass
through contract logic on the way there. This is enforced by Soroban
itself, not by the facilitator's own honesty: every settlement requires the
payer's own cryptographic authorization — a signed Soroban authorization
entry, for every scheme (see "Auth entries, not pre-signed transactions" in
"Stellar-specific operational considerations" above) — checked by the
network at the protocol level. A facilitator that goes offline, has a bug,
or turns actively malicious can **fail to settle** — it cannot **redirect**
a payment, **exceed** what the buyer signed, or **forge** a settlement that
never happened. This is the same property stated more narrowly earlier in
this document (see "What's reused vs. original" and the `upto` design
sections above); it's restated here as its own claim because "decentralized"
and "non-custodial" are specific, checkable properties a reviewer should be
able to verify independently, not a label to take on faith.

**What this doesn't depend on**: no canonical, single shared settlement
contract (each operator deploys and owns their own instance — see
"No canonical shared settlement contract" just above); no dependency on
this project's own hosted facilitator to keep functioning (Apache-2.0,
self-hostable from a clean clone, per "What's reused vs. original"); no
facilitator-controlled catalog trust — Bazaar does not rely on
client-supplied discovery metadata alone. Every resource's actual payment
requirements are independently verified against its live source (HTTP or
MCP alike) *before* it is ever indexed, so critical payment information
such as the payee and pricing cannot be established solely by the party
submitting the discovery payload — see "Automatic cataloging" above; not
something the facilitator can assert unilaterally.

**What's honestly *not* decentralized, stated plainly rather than implied
away**: the Bazaar catalog itself is single-facilitator-scoped by design —
an operator running their own instance gets their own independent catalog,
not a shared or federated one. Two operators running this same codebase
don't automatically see each other's listings. That's a real, disclosed
scope boundary (see "No production HA infrastructure" above for the
related single-instance limitation), not a decentralization claim being
quietly overstated.

## Privacy and data handling

**What the facilitator sees and stores, precisely:**

- Payment payload data needed to `verify`/`settle` a request (the signed
  Soroban authorization entry, the requirements it's checked against) — all
  of which becomes public on the Stellar ledger the moment settlement
  succeeds regardless of what this facilitator does with it. Nothing here
  is additional tracking layered on top of what a public blockchain already
  discloses about a settled transaction.
- Discovery metadata a seller explicitly opts to declare (via the discovery
  extension) — never collected without that opt-in, per "Automatic
  cataloging" above.
- Off-chain billing records (`packages/facilitator/src/billing.ts`):
  per-seller (`payTo`) settlement counts and volume, for invoicing the
  seller's own usage. This is seller-facing operational data, gated behind
  `BILLING_ADMIN_TOKEN` (see `docs/developer-guide.md`), not a buyer
  tracking mechanism — it's indexed by which seller got paid, not by who
  paid them.
- Buyer-level activity, retained only over the rolling window
  usage-ranking's Sybil-resistance signal needs: `resource_buyers`
  (`packages/discovery/src/catalog.ts`) records each buyer's most recent
  activity date per resource, pruned to a 30-day active window — see
  "Usage-based ranking" above. This is real buyer-level data, stated
  plainly rather than glossed over as purely aggregate.
- Operational metrics (`GET /metrics`): settlement counts by scheme/network,
  signer balances, catalog size — aggregate operational signals, not
  per-buyer records.

**What it deliberately does not do**: LumenGate does not maintain an
identity-resolution layer (no accounts, no API keys) or a transaction-level
buyer activity history. Buyer-level activity is retained only over the
rolling period required to compute unique-buyer usage statistics (the
`resource_buyers` bullet above); historical usage itself is stored only as
aggregated per-resource daily statistics (`resource_usage_daily`), never as
a per-buyer transaction log. Stellar addresses are pseudonymous, not
anonymous, independent of anything this project does — but this facilitator
adds nothing beyond what's already necessary to compute that one
rate-gated ranking signal. `packages/mcp-discovery-server`'s signer
interface keeps signing
keys client-side, in the buyer's own runtime, never transmitted to or held
by the MCP server (see "Integrating as an agent (MCP)" in
`docs/developer-guide.md`) — the server facilitates a payment flow, it
never custodies the credential that authorizes one.

The one place a *weaker* signal than raw identity is deliberately used for
ranking is usage-based search ranking's `unique_buyers` count — itself
scoped and rate-gated specifically to resist being used as a precise
per-buyer tracking mechanism; see "Sybil resistance" in "Usage-based
ranking" above for the exact mechanism and its acknowledged limits.
