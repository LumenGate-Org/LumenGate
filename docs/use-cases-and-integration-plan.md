# Use Cases And Stellar Integration Notes

This document summarizes the strongest use cases for the repository and the
technical shape of the Stellar integration. The default `upto` implementation
is the escrow-and-refund design in
`contracts/upto-settlement-escrow`; the allowance-based design in
`contracts/upto-settlement` remains implemented and selectable through
`UPTO_DESIGN=allowance`.

---

## 1. Best use cases, ranked

Ranked by how directly the shipped prototype already substantiates them — not by which
sounds most ambitious.

### 1. Agentic API/service marketplace (MCP-native discovery + pay) — the flagship fit

An LLM agent, using only its MCP tool access, searches Bazaar for a capability
(`search_resources`), inspects price and schema (`get_resource`), and completes payment
autonomously (`call_resource`) — no human in the loop, no pre-negotiated API key, no
account creation with the seller. This is the single use case the whole stack was built
to serve end to end: Bazaar cataloging, hybrid search, and the MCP server all exist
specifically to make this possible, and it is the only use case with a full,
live-tested round trip (discovery → payment → response) already proven on testnet.
It is also the use case the protocol requirements themselves names directly ("agent-driven service
discovery"), not one inferred after the fact.

### 2. Metered AI/LLM inference — the reason `upto` exists at all

An API generating text, images, or embeddings charges per output token instead of a
flat per-call fee: the client authorizes a ceiling once, the actual charge is set after
generation completes. This is the use case the `upto` scheme (and the on-chain,
atomic-fee-split `managed upto` variant) was designed around from the start, and it is
directly proven live — the flagship conformance transaction settles a signed 1.0-unit
ceiling for a genuinely different 0.4-unit actual amount, with the facilitator's fee
split executed atomically in the same transaction. Stellar's sub-cent settlement cost
is what makes per-request settlement viable here at all; the same pattern on an L1 with
meaningful gas cost would force batching and lose the "pay for exactly what you used"
property.

### 3. Facilitator-as-a-service for indie developers and small data providers

Any team can self-host this facilitator and get a monetizable payment gateway —
free-tier-then-per-transaction billing, Bazaar listing, sponsored network fees — without
building settlement infrastructure themselves. This is the use case the three-tier
billing model (Section 3 below) was designed to make viable as a standalone product,
not just a feature: `declareStellarResource` turns "charge for this endpoint and make
it discoverable" into a few lines of configuration.

### 4. Pay-per-query data and dataset access

Market-data feeds, geospatial datasets, or research corpora charging per query or per
row returned, discoverable by any agent searching Bazaar. Directly represented in the
project's own search-quality evaluation fixtures (seed resources modeling exactly this
category) and provable today with the shipped `exact` scheme; becomes usage-proportional
once `upto` is used for variable-size results.

### 5. Pay-per-compute jobs

Rendering, batch processing, or ML inference jobs where cost genuinely varies by job
size. Mechanically identical to use case 2 (authorize-a-ceiling, settle-the-actual), but
ranked below it because there is no dedicated conformance evidence for a compute-style
workload specifically — it inherits the mechanism's proof, not its own.

The ranking is deliberately conservative: 1 and 2 are backed by reproducible, live
testnet transaction hashes (`e2e/conformance/CONFORMANCE_REPORT.md`); 3 is backed by a
complete, tested billing implementation but no live external operator yet; 4 and 5 are
architecturally sound but represented only by the discovery layer's eval fixtures, not
their own end-to-end proof.

---

## 2. Stellar integration plan

### 2.1 Broad outline of the implementation, and the Stellar stack it's built on

The project is a payment facilitator and discovery layer that sits between an x402
resource server (the seller) and a paying client (a human-driven app or an autonomous
agent), settling payment on Stellar on the seller's behalf, and it is built directly on
Stellar's own primitives rather than a generic abstraction layer over them. Three
request flows are implemented end to end. `exact` is a fixed-price request: the client
signs a Soroban authorization for a concrete `(from, to, amount)` SEP-41 token transfer,
the facilitator verifies it against the seller's stated price, submits it, and confirms
settlement — this reuses `@x402/stellar`'s `ExactStellarScheme` unmodified, as the protocol requirements
requires, and needs no dedicated contract since it's a direct SEP-41 transfer. `upto`
(standard) is a usage-based request whose final price isn't known until after the
resource is consumed: the client signs one witness authorizing a *ceiling*, using
Soroban's `Address::require_auth_for_args` to sign a synthetic args tuple that
deliberately excludes the final amount — this is what makes usage-based settlement
possible at all, since Soroban has no Permit2-style canonical proxy contract to copy from
EVM — and the facilitator later settles the real, lower, post-usage amount against that
same witness, via a purpose-built Soroban contract (`contracts/upto-settlement-escrow`,
`soroban-sdk`, Rust — the project's default; see §2.2 below for the fully-implemented
allowance-based alternative, `contracts/upto-settlement`) that has no equivalent on
Stellar before this implementation. Fund movement is **escrow-and-refund**: `settle` itself
pulls the buyer's full ceiling into the contract, nested as a Soroban sub-invocation of
the same witness, then atomically pays the seller, pays the facilitator's cut if any, and
refunds the unused remainder — no prior `approve()` step, ever. Replay protection is the
Soroban host's own automatic per-authorization-entry nonce (CAP-0046-11) alone; the
contract owns zero persistent storage, matching the protocol requirements "no persistent onchain state"
wording literally. The real tradeoff for that: no buyer-initiated cancellation and no
on-chain "already settled?" query — the allowance-based alternative (§2.2) offers both,
at the cost of the persistent state this default design avoids. `managed upto` is the same usage-based flow, except
the facilitator's own fee is computed and paid on-chain, atomically, inside the same
settlement transaction as the seller's payment, instead of being billed off-chain
afterward. Around those three flows: a Bazaar discovery catalog (Postgres/pgvector,
hybrid lexical+semantic search, running on PGlite — a WASM build of real Postgres, not
Stellar-specific infrastructure but what the discovery layer runs on) that automatically
lists any resource a client has paid for, first provisionally on payment receipt and
then permanently on confirmed settlement; an MCP server exposing that catalog and the
payment flow as agent tools (`search_resources`, `list_resources`, `get_resource`,
`call_resource`); and an off-chain billing ledger (SQLite) metering `exact`/standard-`upto`
usage against a free monthly quota, then a small per-settlement fee, mirroring how
established facilitators like Coinbase's price this today. On the Stellar-infrastructure
side, transaction assembly, XDR encoding, and Soroban RPC submission/simulation all go
through `@stellar/stellar-sdk` (JS/TS) — the same `simulateTransaction` call is used both
for real settlement and for the resource-cost benchmark comparing settlement designs —
while account and balance queries (trustlines, the `/metrics` endpoint's live balance
read) go through Horizon. The facilitator, not the buyer, pays the Stellar network fee:
the buyer only ever signs an authorization entry, never a full transaction, and at
settlement time a configurable pool of channel accounts supplies the transaction's
source account and sequence number so concurrent settlements don't collide on a single
account, falling back to the settlement signer itself when none are configured. All of
this runs live today on `stellar:testnet`, funded via Friendbot and exercised end to end
in this implementation's conformance evidence; `stellar:pubnet` RPC connectivity is wired and
verified reachable, but no funded operational account or live mainnet settlement exists
yet (Phase 2 below).

### 2.2 Design B, as a variant of the same stack

> **Update: this section's analysis was carried out and then executed.** What follows
> was originally written as "what would need to change if Design B became primary" — the
> scenario the validator raised. It has since been done: `packages/stellar-upto` gained
> `UptoStellarEscrowScheme`, `packages/facilitator` defaults to it
> (`UPTO_DESIGN=escrow`), and `specs/schemes/upto/scheme_upto_stellar.md` documents it
> as canonical. The analysis below is left in its original form because it's the actual
> reasoning that was followed, not rewritten after the fact — "Concrete phases this would
> require" now reads as a completed checklist, annotated with what actually happened at
> each step, including one real bug the live-verification step caught.

This section describes what changed when Design B
(escrow-and-refund, `contracts/upto-settlement-escrow`) became the primary, shipped
`upto` contract instead of Design A — the scenario the validator raised. Today,
`packages/stellar-upto` and `packages/facilitator` default to Design B; Design A remains
fully implemented and selectable (`UPTO_DESIGN=allowance`), not retired — see
`docs/architecture.md`, "The `upto` settlement design," for the full comparison table.

#### What changes technically if Design B becomes primary

Design B's settlement flow is mechanically close to Design A's at the protocol level —
the client still signs one `require_auth_for_args` witness over a synthetic args tuple
that deliberately excludes the actual settlement amount, so the outer client-facing
contract (build witness → send payment header → facilitator settles) does not need to
be redesigned from scratch. What changes is what happens *inside* the contract and what
disappears from the surface:

- **No `approve()` step.** Design A requires a one-time SEP-41 allowance before the
  first request; Design B needs nothing from the buyer beyond the per-request signature.
  Turned out to require *zero* client-side code changes at all, not even a deletion: the
  client scheme (`packages/stellar-upto/src/client/scheme.ts`) was already
  contract-agnostic — it simulates whatever contract `extra.settlementContract` names via
  `contract.AssembledTransaction.build`, with no allowance-management logic of its own to
  remove. The allowance *check* lived entirely server-side, in the facilitator's
  `verify()` — that's what actually changed (see item 6, "balance pre-flight," below).
- **The escrow pull is a sub-invocation of the same witness**, not a separate
  authorization — the fund movement (`token.transfer(buyer, contract, max_amount)`) is
  bound into the same signed authorization tree as the `settle` call itself, per
  CAP-0046-11. This is the actual fix over the validator's original naive sketch (a
  standalone `require_auth()` transfer, which is a reusable bearer credential) and is
  the part with a live proof: reusing a real signed witness to invoke the transfer
  directly, outside `settle`, was rejected by the network at the protocol level
  (`Error(Auth, InvalidAction)`).
- **No contract-level storage at all.** Design A's `DataKey::Nonce(buyer,
  request_nonce)` persistent entry and its TTL bookkeeping disappear entirely; replay
  protection becomes the Soroban host's own per-authorization-entry nonce. This is the
  literal protocol requirements-alignment point the validator raised: the protocol requirements text says the per-request
  schemes hold no persistent onchain state, and Design A's allowance-plus-nonce storage
  is exactly the kind of state that violates that sentence read literally. Design B does
  not.
- **Two capabilities are lost, not hidden**: `cancel(from, request_nonce)` and
  `is_settled(from, request_nonce)` have nothing to operate on once there is no
  contract storage — Design B's only expiry path is the witness's own
  `deadline`/`signatureExpirationLedger`, and there is no on-chain way to query
  settlement status.

#### Technical walkthrough: how a settlement runs end to end, on Design B

This is the same request lifecycle `packages/stellar-upto` already implements for
Design A, traced through Design B's actual contract code
(`contracts/upto-settlement-escrow/src/lib.rs`) instead — not a re-derivation from
scratch, because most of the client-side machinery is provably reusable as-is.

**1. The client builds and signs a witness — unchanged code.** When a resource replies
402 with an `upto` ceiling, the client assembles a commitment — `from`, `payTo`,
`facilitator`, `token`, `maxAmount`, `requestNonce`, `deadline`, `feeBps` — and encodes it
via `buildWitnessScArgs()` in `packages/stellar-upto/src/witness.ts`. That function's own
doc comment pins its output order to Design A's Rust source; the same eight-field tuple,
in the same order, is what Design B's `settle()` builds internally as `witness_args`
(`contracts/upto-settlement-escrow/src/lib.rs:176-186`) before calling
`from.require_auth_for_args(witness_args)`. Because the two contracts were deliberately
written to share this shape, retargeting the client to Design B is a matter of pointing
`buildSettleScArgs()` at the escrow contract's ID — the encoding function itself does not
change.

**2. The facilitator submits `settle(...)` with the real usage figure.** Design B's
`settle` takes the identical nine positional arguments in the identical order as Design
A's — `(from, pay_to, facilitator, token, max_amount, actual_amount, request_nonce,
deadline, fee_bps)` — confirmed directly against both `lib.rs` files, not assumed from
the shared witness shape alone. `buildSettleScArgs()` already produces exactly this
9-tuple (inserting `actual_amount` after `max_amount`), so the facilitator's call-assembly
code needs no reordering either.

**3. Inside the contract, in the order the code actually runs:** facilitator-safety
checks first (`facilitator == from` and `facilitator == pay_to` both panic — identical to
Design A); then bounds checks (`deadline` not yet passed, `actual_amount`/`max_amount`
non-negative, `actual_amount <= max_amount`, `fee_bps <= MAX_FEE_BPS` where
`MAX_FEE_BPS = 2_000`, i.e. a hard 20% ceiling — the same constant Design A enforces, by
deliberate design so the comparison stays fair); then the witness check,
`from.require_auth_for_args(witness_args)`, which is where the client's pre-signed entry
is matched against what the contract just reconstructed; then `facilitator.require_auth()`,
satisfied automatically by the facilitator's own transaction/operation-source signature —
this is the same mechanism channel accounts already compose with under Design A, so
`packages/stellar-upto`'s channel-account rotation logic needs no changes to keep working.

**4. Only then does money move — and this is the step Design A doesn't have at all.**
`token_client.transfer(&from, &this_contract, &max_amount)` pulls the full ceiling into
the contract. It runs *after* `from.require_auth_for_args` has already established the
authorized invocation tree for this specific `settle` call, so Soroban's own
authorization-tree matching (CAP-0046-11) scopes this transfer as a sub-invocation of that
one call — it has no standalone existence outside it. That is the exact mechanism the live
testnet proof validated: replaying the same signed witness to invoke `token.transfer`
directly, outside `settle`, was rejected by the network itself
(`Error(Auth, InvalidAction)`).

**5. The payout, still in the same atomic call.** `fee = actual_amount * fee_bps /
10_000`, `seller_amount = actual_amount - fee`, `refund = max_amount - actual_amount`;
three outbound transfers (to `pay_to`, to `facilitator`, back to `from`) all self-authorize
because the contract itself is the source — identical self-authorization rationale to
Design A's `transfer_from(spender = this_contract, ...)`. A `UptoSettleEvent` is published
with `from`/`request_nonce` as indexed topics and the three amounts as fields; the function
returns `(seller_amount, facilitator_fee, refund)`.

**6. What the facilitator's TypeScript actually had to change, concretely.** Confirmed
by building it: `verify()`'s SEP-41 allowance check (`getAllowance`, reading
`token.allowance(from, settlementContract)`) has nothing to run against under Design
B — replaced with a balance pre-flight (`getBalance`, reading `token.balance(from)`)
in the new `UptoStellarEscrowScheme` class, not stubbed out. `settle()` does return a
third value (`refund`, alongside `seller_amount`/`fee`) that Design A's two-tuple
doesn't have — but neither design's TypeScript layer actually parses the settle
transaction's return value today (`pollForTransaction` only checks
`SUCCESS`/`FAILED` status), so this wasn't a required change, just an available one for
a future settlement-receipt enhancement. Everything else in the verify/settle scheme
class — requirements matching, deadline handling, polling for confirmation,
fee-sponsorship, channel-account selection, the idempotency cache — carries over from
`UptoStellarScheme`'s existing implementation unchanged in shape; `UptoStellarEscrowScheme`
(`packages/stellar-upto/src/facilitator/scheme-escrow.ts`) reuses `buildSettleOperation`
and the witness-encoding helpers directly rather than reimplementing them.

**7. What has no on-chain equivalent to call.** `max_fee_bps()` is Design B's only other
public function — a view mirroring Design A's constant, for a client or facilitator to
read the ceiling without hardcoding it. There is no `cancel` and no `is_settled`: Design A
exposes both because it owns a `DataKey::Nonce(from, request_nonce)` entry to write to and
query; Design B owns no contract storage at all, so there is nothing for either function to
operate on. Any facilitator-side code path that currently calls Design A's `cancel` or
`is_settled` (buyer-initiated cancellation UI, settlement-status lookups) has no Design B
counterpart to call and would need to be removed or re-routed to rely on the facilitator's
own off-chain records instead.

#### Phases — completed, per the checklist originally planned

**Phase A — Decide the tradeoff, explicitly, before writing code. ✅ Done.**
Whether Design B is actually the better primary design depends on whether a real
deployment needs buyer-initiated cancellation and an on-chain settlement-status query.
Decision made explicitly and recorded, not discovered as a regression after the swap:
promote Design B to default, keep Design A fully available for deployments that need
those two capabilities — `docs/architecture.md`'s comparison table is what the decision
was made on.

**Phase B — Client-side witness signing. ✅ Done — turned out to need no code changes.**
The existing witness-construction code in `packages/stellar-upto` (`client/scheme.ts`,
`witness.ts`) was already contract-agnostic — no allowance-management code path existed
there to delete, and no retargeting was needed beyond pointing `extra.settlementContract`
at the escrow contract's address, which is a facilitator config change, not a client code
change.

**Phase C — Facilitator-side scheme class. ✅ Done.** `UptoStellarEscrowScheme`
(`packages/stellar-upto/src/facilitator/scheme-escrow.ts`) mirrors `UptoStellarScheme`'s
shape, replacing the allowance pre-flight with a balance pre-flight. One real bug was
found and fixed while wiring it: the shared witness decoder (`decodeWitnessEntry`)
rejected any witness carrying sub-invocations, correct for Design A but wrong for Design
B's legitimate one-sub-invocation witness — fixed with a dedicated
`decodeEscrowWitnessEntry` that validates the sub-invocation's exact shape rather than
merely forbidding or permitting it blindly. 17 dedicated tests added
(`test/facilitator-verify-escrow.test.ts`), including 5 specifically targeting this
sub-invocation validation.

**Phase D — Facilitator wiring and a real decision on Design A's fate. ✅ Done —
selector, not outright replacement.** `packages/facilitator` selects the active design
via `UPTO_DESIGN` (`escrow`, the default, or `allowance`) — only one is ever live per
network at a time (not both simultaneously; a single `upto` scheme/network pair needs one
canonical `settlementContract` a client can build a witness against), but Design A is not
retired — it stays a first-class, fully tested, one-environment-variable-away option.

**Phase E — Spec rewrite. ✅ Done.** `specs/schemes/upto/scheme_upto_stellar.md` now
documents the escrow-pull sub-invocation mechanism as canonical, with Design A moved into
a self-contained "Appendix B: Alternative Design" section covering everything that
differs (fund movement, persistent state, cancellation, the inverted sub-invocation
validation rule, error codes, resource cost).

**Phase F — Re-run the adversarial validation process against the new primary path. ⏳
Partially done.** A live, on-chain security proof exists for the one attack this design
was specifically built to close (the bearer-credential replay), reused against a real
deployed contract with a genuine rejected transaction as evidence. What has **not**
happened yet: the nine-round depth of internal/external adversarial validation Design A
accumulated before this implementation. That validation debt is real and explicitly not claimed
as paid — see `docs/architecture.md`'s Security Considerations and the honest boundary in
§3 below.

**Unaffected by this choice, and unchanged**: mainnet activation (funded account, custody
decisions) and production-hardening (standalone Postgres, observability, eval-benchmark
growth) are independent of which `upto` contract is primary and remain on their own
timeline either way — see §2.3 below.

### 2.3 The integration plan, now that Design B is implemented

Everything in §2.2 above (Phases A–F) is the work of getting here — done, per the
checklist above. This section picks up from that point forward: Design B is the primary,
wired `upto`/`managed upto` contract, `packages/stellar-upto` and `packages/facilitator`
speak its witness format, and `specs/schemes/upto/scheme_upto_stellar.md` documents its
escrow-pull mechanism as canonical. From here, the plan is structured the same way the
original, Design-A-based Stellar Integration Plan is
, because most of it doesn't
actually depend on which contract is primary.

**Phase 1 — Complete.** Testnet-first implementation of the escrow-and-refund contract,
full automated test coverage, live conformance validation, the client/facilitator swap,
and the spec rewrite. At this point the protocol requirements "no persistent onchain state" wording
is met without qualification, not by argument — there is no allowance and no contract
storage left to explain away. What the swap does not automatically inherit: the live
security proof rejecting the bearer-credential replay is real evidence, but it is one
targeted proof against one specific attack, not the nine-round validation depth Design A
accumulated before this implementation. That depth still has to be earned on the new primary
path, not assumed to carry over because the contract passed one test.

**Phase 2 — Mainnet activation.** Unchanged from the original plan: `stellar:pubnet` RPC
connectivity is wired and verified reachable; activating real settlement requires a
funded operational account and explicit asset-custody decisions. This phase was never
contract-specific, so being on Design B changes nothing about it.

**Phase 3 — adversarial validation, brought up to the same bar Design A had.** Every future
change to the escrow contract or the facilitator's new verification logic goes through
the same standard Design A's nine rounds were held to. Two angles are worth deliberately
targeting here precisely because they're new to Design B, not inherited from Design A's
already-validated surface: whether the escrow-pull sub-invocation scoping holds under
every authorization-tree shape a malicious or malformed client could construct, not only
the one attack already proven rejected live; and the operational consequence of having
no `cancel()` — an unsettled witness can now only expire on its own deadline, so validation
should specifically check that default `deadline`/`signatureExpirationLedger` windows
are short enough that a buyer isn't left exposed longer than they would have been able
to self-cancel under Design A.

**Phase 4 — Upstream spec contribution.** Open the pull request to
`x402-foundation/x402` with `scheme_upto_stellar.md` describing the escrow-pull mechanism
as canonical, coordinated through the x402 Technical Steering Committee as required by the protocol.
Worth surfacing explicitly in that PR's own discussion, not left for a validator to
notice: this spec now documents a design with no on-chain cancellation and no
settlement-status query — a real behavioral difference from Design A that a validator
comparing it to EVM's Permit2-based `upto` (which also carries no persistent state, for
the same underlying reason) might not expect by analogy alone.

**Phase 5 — Production hardening.** Unchanged from the original plan: move the discovery
catalog's embedded PostgreSQL instance to a standalone, shared Postgres server for
multi-instance deployments, build the existing `/metrics` endpoint into a full
observability stack, and grow the search-quality evaluation benchmark from its current
seed set. None of this depends on which `upto` contract is primary.

One honest structural caveat: this five-phase plan assumes Design A has been fully
retired, not run in parallel. If Phase D chose the "run both behind a selector" path
instead, Phase 3's validation burden and Phase 5's maintenance surface both roughly double
until Design A is actually sunset — a parallel-path plan is a different, heavier plan
than the one above, not a free variant of it.

---

## 3. Justifying the current traction, using the prototype and the original business models

"Traction" here is deliberately not a claim about external users — the project has
none yet, and every document in this implementation says so plainly rather than rounding
up. What is being justified is narrower and more verifiable: that the engineering
effort actually validated the *original* idea this implementation was built around, not a
simplified substitute for it.

### The original model being tested

The model was never just "build an `upto` facilitator." It was a specific,
three-tier business-model framing, inspired by Coinbase's own facilitator pricing (free
under a monthly quota, then a small per-settlement fee): `exact` and standard `upto`
billed off-chain under that quota-plus-fee model, and a third, original tier —
`managed upto` — where the facilitator's fee is computed and paid **on-chain, atomically,
in the same settlement transaction** as the buyer's payment. That third tier has no
precedent in the existing EVM/SVM x402 implementations (confirmed by direct source
inspection of `x402-foundation/x402` before this project began) — it is this
implementation's original contribution, not the facilitator or discovery layer in
isolation.

### Why the prototype is the justification, not a separate claim

Three pieces of live, reproducible evidence tie directly back to that original model,
not to generic "the code runs" completeness:

- **The managed-upto flagship transaction** (`d70e0224bda3bd84aa3880c5847c52232cf07bef5032f81a1ae3bbd2ea7ba367`)
  is the on-chain proof that the original idea — authorize a ceiling, settle a
  different actual amount, split the facilitator's fee atomically in the same
  transaction — is not a paper design. It is a real Soroban transaction, independently
  verifiable on Stellar Expert, doing exactly what the original three-tier model
  said it would do.
- **The billing implementation** (`packages/facilitator/src/billing.ts`) is a faithful,
  tested implementation of the free-quota-then-per-settlement model — evolved, on further
  validator input, into a fixed/percentage/combined (`min`/`max`) pricing rule with a
  per-seller, configurable allowance period (day/month/year), not just a flat rate. The
  on-chain `fee_bps` ceiling (percentage-only, capped, for managed upto) deliberately
  does **not** extend to the same fixed/combined shape — see
  `docs/architecture.md`'s "Technical assessment: can the off-chain fixed/percentage/
  combined model extend on-chain?" for exactly why (no price oracle for a
  USD-denominated flat component against an arbitrary settlement asset) — a real
  architectural boundary between the off-chain and on-chain tiers, not an inconsistency.
  Both are covered by the automated test suite cited in the engineering-traction evidence.
- **The resource-benchmark, comparison, and eventual promotion of Design B to primary**
  (§2 above) is itself evidence the original model was taken seriously enough to be
  stress-tested against a real external critique and a genuine alternative architecture,
  and then actually changed as a result — not defended unconditionally once shipped.

### The honest boundary

This justification is deliberately narrow. It supports the claim "the original
business model this implementation was built to explore is real, working, and proven live
on testnet" — it does not support "this has external users," "this has run on
mainnet," or "this has had a paid, formal security assessment." Those remain open, and are
tracked as such in `docs/architecture.md`'s scope-boundary section and Phase 2 of the
Stellar Integration Plan . Rounding
any of those up would undercut the same evidence-based credibility the rest of this
implementation is built on.
