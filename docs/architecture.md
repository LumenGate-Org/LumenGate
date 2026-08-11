# Architecture

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
| 2 | `upto`, `feeBps: 0` | Same off-chain metering as tier 1 | Off-chain |
| 3 | `upto`, `feeBps > 0` (**managed upto**) | A percentage the client's signature commits to | **On-chain, atomically, in the same settlement transaction** |

Tier 3 exists because Stellar's `upto` implementation required a new
settlement contract anyway (see below) — once fund movement goes through
that contract, having it also compute and pay the facilitator's cut in the
same call is a small addition with a real benefit: no off-chain invoicing
system, no trust required that the facilitator counted correctly, and a
publicly-verifiable on-chain fee. It is opt-in per route (`UptoStellarScheme`
in `packages/stellar-upto/src/server`, `feeBps` option) — a seller who wants
the simpler off-chain billing model for their `upto` routes just leaves it at
the `0` default.

Tiers 1 and 2's off-chain fee is one general, configurable shape
(`BillingFeeConfig` in `packages/facilitator/src/billing.ts`), not a
hardwired flat rate: a fixed per-settlement charge, a percentage of the
settled amount, or a **combination of both**, where the applied fee is
`min(fixed, percentage × settled amount)` or `max(...)`, per the seller's
own `combineRule` — e.g. "0.0001 USDC or 1% of the settled amount, whichever
is smaller" protects small settlements from a disproportionate fixed charge
while still scaling with volume on larger ones. Percentage/combined mode is
computed against the settlement asset's own atomic units (`assetDecimals`,
default 7 for SEP-41 USDC) rather than a hardcoded USD conversion, since the
protocol requirements require supporting any SEP-41 token, not only USDC — an operator
metering a different-decimals token sets `assetDecimals` accordingly. This
satisfies the protocol requirements requirement (Section 3.1: "any fee must be
configurable rather than hard wired").

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

**This configurable fixed/percentage/combined model applies to the two
off-chain tiers only — not to managed `upto`'s on-chain fee.** The
contract's `fee_bps` (tier 3) is deliberately percentage-only, computed and
paid in whatever asset was actually settled, with a hard on-chain ceiling
(`MAX_FEE_BPS`). A *fixed*-USD-denominated component isn't something a
Soroban contract can compute for an arbitrary settlement asset without a
price oracle it doesn't have — "0.0001 USDC flat" only means something
directly on-chain when the settlement asset already *is* that exact USDC
token; for any other SEP-41 asset, a flat-fee-in-USDC component would need
either a second, separate token transfer (the buyer holding and approving a
distinct fee asset) or an on-chain price conversion, both real added
complexity this design deliberately doesn't take on. This is a genuine
architectural boundary, not an oversight — see "Technical assessment: can
the off-chain fixed/percentage/combined model extend on-chain?" below for
the full reasoning.

**Who authorizes the fee.** Only the buyer signs anything in this design —
there is no seller-side signature at all (see the seller-authorization row
below). That makes the buyer's witness the *only* cryptographic commitment
to `fee_bps` that exists anywhere in the system today, which is why
`fee_bps` is currently part of the synthetic args tuple the buyer
authorizes (`contracts/upto-settlement-escrow/src/lib.rs`): removing it without
replacing it with anything would mean no party commits to the fee split at
all, and a compromised facilitator could then always take the contract's
`MAX_FEE_BPS` ceiling regardless of what it advertised at signing time. The
buyer's total exposure doesn't actually change either way — `fee_bps` only
splits `actual_amount` between `pay_to` and the facilitator, it doesn't add
to what the buyer can be charged, which is still capped by `max_amount` —
so external feedback that a buyer "shouldn't have to authorize facilitator
fees," since the fee split is a facilitator/seller commercial matter, is
right in principle. But binding it to the buyer's signature today isn't
solving a problem the buyer actually has; it's compensating for the absence
of a seller-side signature. Properly moving that commitment to the seller
is the same redesign already flagged as a deliberate gap, not a new,
separate one — see "Seller-side authorization of the settled amount" below.

### Technical assessment: can the off-chain fixed/percentage/combined model extend on-chain?

Raised directly by external validation: the off-chain pricing model (fixed,
percentage, or a min/max combination of both, plus a configurable free
allowance) is deliberately general, and the natural question is whether
managed `upto`'s on-chain `fee_bps` could be extended to the same shape,
for a single, consistent business model across all three tiers. The honest
answer is **partially, and the boundary is a real architectural one, not a
missing feature**:

- **Percentage-only is what's cheap and safe on-chain today.** `fee =
  actual_amount * fee_bps / BPS_DENOMINATOR` is a single multiply-and-divide
  against the exact asset already being settled — no conversion, no
  external price data, no added trust assumption. It composes with the
  atomic escrow-and-refund (or allowance) settlement with zero extra moving
  parts.
- **A flat, USD-denominated component doesn't have a cheap on-chain
  equivalent for an arbitrary SEP-41 asset.** "0.0001 USDC flat" is only
  directly meaningful on-chain when the settlement asset already *is* that
  USDC token — the contract can just move a fixed atomic amount of the same
  asset it's already handling. The moment a seller settles in a different
  SEP-41 asset (which this project explicitly supports, not just USDC), a
  flat USDC-denominated fee requires either (a) a **second**, separate
  token transfer in USDC specifically — meaning the buyer would need to
  hold *and* pre-authorize a second asset just to pay a flat fee component,
  a real new prerequisite this design was built specifically to avoid — or
  (b) an **on-chain price conversion** from the settlement asset to USDC,
  which needs a price oracle Soroban doesn't provide natively and this
  project has not integrated. Either path is a materially bigger, riskier
  contract than the one that exists and is proven live today.
- **A `min`/`max` combined rule is mechanically easy on-chain in isolation**
  (it's one more comparison), **but it inherits the flat-component problem
  above** — combining "fixed" with "percentage" on-chain only avoids the
  oracle/second-transfer problem if the flat component is waived down to
  zero for non-USDC assets, which isn't really "the same model," just a
  percentage-only model with an inert extra field.
- **What would make full parity possible**: either (a) restricting managed
  `upto`'s on-chain fee to only the case where the settlement asset is
  already USDC (a real, shippable restriction, not a redesign — the
  contract already receives `token` as an argument and could branch on it),
  or (b) integrating a Soroban price-oracle dependency, a materially larger
  scope addition with its own trust/liveness considerations (oracle
  staleness, oracle compromise) that this implementation has not taken on.

**Recommendation**: keep managed `upto`'s on-chain fee percentage-only, as
shipped — it is the correct, minimal design for "compute a fee the contract
can trust without external input." If full fixed/percentage/combined parity
on-chain is a real product requirement, option (a) above (USDC-only flat/
combined fee, percentage-only for every other asset) is the concrete,
scoped next step — not a redesign of the settlement contract, an additive
branch on an argument it already has.

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
- **Composition with Stellar smart account spending policies.** This project
  doesn't currently integrate with Stellar's smart-account (`__check_auth`)
  spending-policy contracts, but the design composes with them by
  construction rather than by accident: `require_auth`/
  `require_auth_for_args` are the same primitive a smart-account policy
  contract intercepts, so an agent operating from a smart account with a
  spending-policy `__check_auth` implementation would have both `exact`'s
  transfer and `upto`'s witness pass through that policy check exactly as
  any other authorized invocation would — a policy that caps daily spend or
  restricts recipients applies to this facilitator's calls with no
  facilitator-side changes needed. What isn't built: this project doesn't
  ship or test against a specific spending-policy contract itself (e.g. a
  reference "max N per day" policy), so this composition is a design
  property that follows from using standard Soroban authorization rather
  than something exercised live in `e2e/conformance`. Classic keypairs and
  custom `__check_auth` accounts are both already supported (Section 3.1) —
  the facilitator never assumes `from` is a keypair-controlled address.
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
| Hybrid (lexical + semantic, RRF-fused) — shipped default | 1.000 | 0.993 |
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

## Automatic cataloging: provisional at receipt, confirmed at settlement

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

An earlier version of this project gated cataloging entirely on settlement
success instead, for a real reason, found empirically: `verify()` moves no
funds and submits nothing on-chain, so cataloging unconditionally at
verify-time once let anyone with a validly-signed-but-never-settled payment
authorization — costless against a self-controlled, self-minted token —
inject arbitrary resource metadata into the search index for free,
repeatedly. That reasoning wasn't wrong, but it also wasn't what the protocol requirements
text describes, and it was never disclosed as a deviation from the protocol requirements
literal trigger — a real gap in its own right, caught in a later validation
pass.

**The fix reconciles both:** a resource is cataloged with `status:
"provisional"` immediately, at `verify()` time, matching the protocol requirements literal
trigger (`createBazaarVerifyPreviewHook`) — visible in `list()`/`search()`
right away, no separate registration step. If the same request later
settles successfully, `createBazaarCatalogingHook` promotes the entry to
`status: "confirmed"`, permanent, no expiry. If it never settles, the
provisional entry is evicted once `provisionalExpiresAt` passes (15 minutes
by default, `DEFAULT_PROVISIONAL_TTL_MS`) — swept by
`packages/facilitator/src/indexer.ts`'s reconciliation loop, the same
genuinely-separate process that already reconciles the settlement-cataloging
outbox (see below). This bounds, rather than eliminates, the free-spam
window a settlement-blind trigger has no defense against — a deliberate,
disclosed tradeoff, not a claim that provisional cataloging is costless.
`GET /discovery/resources`/`/search` expose `status` on every returned
resource, so a consumer (including an agent deciding whether to trust a
listing) can see which stage a resource is at.

**Catalog integrity for the data that matters — `payTo`, price, network —
is unaffected by which stage cataloged the entry.** Both hooks build the
catalog payload from `paymentPayload.accepted` (the client-echoed
*advertised* requirements, never the settle-phase metered-actual-charge
override), and for `upto`, `accepted` is cross-checked against the buyer's
witness commitment in `UptoStellarScheme._verify` — so publishing a listing
under someone else's `payTo`, or at a price never actually authorized,
isn't possible at either stage without breaking the witness check. See
`packages/facilitator/src/discovery-hooks.ts` for the full incident trail
this protection was built through (a one-off metered charge published as
the advertised price; an unvalidated `accepted` on direct `/settle` calls;
an idempotency-cache replay that skipped the cross-check; a `BillingLedger`
migration gap) — all fixed, all documented at the point they were found,
not smoothed over in hindsight.

**Crash-safe settlement confirmation.** "Indexer" isn't protocol requirements terminology (it
doesn't appear in the protocol requirements text) but was a real operational question
raised in a separate round of external validation: cataloging normally runs
inline inside the same `onAfterSettle` hook that reports settlement success
back to the caller — fast, and correct in the overwhelmingly common case,
but originally not crash-safe. A process crash between the transaction
confirming and the catalog write completing would leave that resource
permanently un-confirmed, since the metadata a catalog entry needs (service
name, description, tags, route template) only ever exists off-chain, in the
`PaymentPayload` a resource server sent over HTTP — no amount of
chain-watching alone could reconstruct it after the fact. Closed via a
transactional-outbox pattern: the settle-time hook durably writes the full
catalog payload to a `pending_catalog` table
(`packages/discovery/src/catalog.ts`), keyed by the settlement's
transaction hash, *before* attempting the `upsert`, and deletes it only
once the `upsert` actually succeeds. If the process dies in that narrow
window, the row survives on the next startup pointed at the same data
directory — standard Postgres commit durability, though this project has
verified the *application-level* outbox logic directly (the crash-safety
test below forces `upsert` to throw and confirms the row survives and is
later resolved), not stress-tested PGlite's own on-disk durability under a
hard process kill specifically — and
`packages/facilitator/src/indexer.ts`, a genuinely separate process (`pnpm
indexer` for a continuous loop, `pnpm indexer:once` for a cron-triggered
deployment), finds and retries any pending entry independently of the
original request/response cycle that created it, and also sweeps expired
provisional entries in the same pass. Verified two ways: a unit test that
makes `upsert` throw mid-write and confirms the pending row survives and is
later resolved by a second pass (`packages/facilitator/test/discovery-hooks.test.ts`,
"crash-safety"), and a real run of the `indexer.ts` binary itself against a
live database with a manually-enqueued pending entry, confirming it
actually reconciles end to end, not just in a mock. The settlement itself
was always correct and final on-chain regardless of any of this — only
discoverability was ever at risk, never funds.

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

- **Testnet is this prototype's real target; mainnet is wired and verified
  reachable, not funded.** `stellar:pubnet` is a genuinely separate,
  independently-registered configuration
  (`STELLAR_PUBNET_RPC_URL`/`UPTO_SETTLEMENT_CONTRACT_PUBNET`, see
  `packages/facilitator/src/server.ts`) rather than a same-instance
  same-config assumption — `/supported` only advertises pubnet once an RPC
  URL is actually set, rather than advertising a network that would fail
  at first real use. Verified live and read-only (`pnpm pubnet:rpc-connectivity`
  in `e2e/conformance`, plus starting the facilitator itself against
  `https://mainnet.sorobanrpc.com`): real mainnet RPC connectivity, correct
  network passphrase, and (via `GET /metrics`) a real Horizon balance
  lookup against a live mainnet account. Not exercised: an actual
  settlement transaction on pubnet, which needs a funded mainnet account
  and asset-custody decisions beyond this prototype's scope — see
  `e2e/conformance/CONFORMANCE_REPORT.md`, "requirements gap analysis
  and closure," for the full reasoning and evidence.
- **No formal, third-party security assessment.** `contracts/upto-settlement-escrow`
  and the facilitator/SDK/MCP layers around it have unit test coverage, live
  testnet conformance runs, and nine rounds of adversarial validation — one
  internal (found and fixed a missing `facilitator.require_auth()`) and
  eight external, each against the fixes from the prior pass. This isn't
  a token pass: real, distinct issues were found and fixed in most rounds
  (an on-chain settlement-finality gap, an idempotency cache that could be
  replayed past validation, a spending-cap guardrail with a TOCTOU bypass,
  catalog-poisoning vectors through under-checked fields, among others), a
  couple of claimed findings were investigated and did *not* hold up, and
  low-risk residuals that weren't fixed (public `/settle` trusting
  caller-supplied settlement amount; the MCP SSRF guard's DNS check being
  TOCTOU/fail-open) are named explicitly rather than left implicit. See
  `e2e/conformance/CONFORMANCE_REPORT.md` — every round has its own section
  with the full before/after. Treat this as a rigorously self-validated
  proof of concept, not production-hardened infrastructure.
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
- **Discovery cataloging and search.** Moved out of this list into their own
  top-level sections, given how much protocol requirements text and external validation is
  directly about them: see "Automatic cataloging: provisional at receipt,
  confirmed at settlement" (the cataloging trigger, catalog-integrity
  protections, and crash-safe settlement confirmation) and "Hybrid search
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
