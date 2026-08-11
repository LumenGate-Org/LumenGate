# Scheme: `upto` on `Stellar`

> [!NOTE]
> This file is placed at the exact relative path it would occupy in a PR to
> [`x402-foundation/x402`](https://github.com/x402-foundation/x402)
> (`specs/schemes/upto/scheme_upto_stellar.md`), so it is intended to be
> upstream-contributable as-is. Its sibling links (`scheme_upto.md`,
> `scheme_upto_evm.md`, `../exact/scheme_exact_stellar.md`) point to files
> that already exist in that upstream repo but are not vendored into this
> one — they'll resolve once this file lands there.

## Versions supported

- ❌ `v1` - not supported.
- ✅ `v2`

## Supported Networks

This spec uses [CAIP-2](https://namespaces.chainagnostic.org/stellar/caip2) identifiers:
- `stellar:pubnet` — Stellar mainnet
- `stellar:testnet` — Stellar testnet

## Summary

The x402 `upto` scheme on Stellar authorizes a transfer of **up to a maximum
amount**; the actual amount charged is decided by the resource server at
settlement time, based on resource consumption, exactly per the
[base `upto` scheme spec](./scheme_upto.md). Settlement happens through a
purpose-built Soroban contract, `x402UptoStellarEscrowSettlement` (see
`contracts/upto-settlement-escrow`), against which the facilitator verifies
and settles. It uses an **escrow-and-refund** mechanism: the client signs one
witness, no prior `approve` step is required, and the contract owns zero
persistent on-chain state — matching the base spec's own requirement that
"the per request schemes hold no persistent onchain state" literally, not
just in spirit.

> [!NOTE]
> An earlier allowance-and-`transfer_from` contract was built and measured
> as this design's benchmark comparison baseline before being superseded —
> see Appendix B for the resource-cost numbers and what that measurement
> covers. It is not documented here as a parallel protocol.

> [!NOTE]
> **Scope:** This spec covers [SEP-41]-compliant Soroban tokens **only**,
> same as [`exact` on Stellar][scheme-exact-stellar]. Classic Stellar assets
> are not supported.

### Why a dedicated contract, and why Stellar needs one

EVM's `upto` scheme (see [`scheme_upto_evm.md`](./scheme_upto_evm.md))
works by having the client sign a **Permit2 witness** committing to a
**maximum** amount; a canonical `x402UptoPermit2Proxy` contract then lets the
facilitator call `settle(actualAmount)` for any amount `<=` that maximum,
because Permit2's signature check is over the witness data, independent of
what the *calling* transaction later does with it.

Stellar/Soroban has no equivalent off-the-shelf contract, because Soroban
authorization does not work the way EVM signature verification does.
`Address::require_auth()` — the mechanism [`exact` on Stellar][scheme-exact-stellar]
uses — cryptographically commits to a **concrete (contract, function, args)
invocation**. It works for `exact` precisely because every signed argument,
including the transfer amount, is fully known at signing time. For `upto`,
the settlement amount is by definition not known until *after* the resource
has been consumed, so a client cannot pre-sign an authorization containing
the final amount.

This spec resolves that using a different, less commonly used Soroban
primitive: **`Address::require_auth_for_args(args)`**, which lets contract
code check authorization against a *synthetic* args tuple, distinct from the
literal call arguments the function was invoked with. The client signs an
authorization committing to everything **except** the actual settlement
amount; the contract enforces the `<=` bound in ordinary Rust code, the same
way `x402UptoPermit2Proxy` enforces it in Solidity.

Fund movement uses **escrow-and-refund**: `settle` itself pulls the full
`max_amount` from the buyer into the contract via a plain `token.transfer`,
splits `actual_amount` between the seller and (if `fee_bps > 0`) the
facilitator, and refunds the unused remainder (`max_amount - actual_amount`)
to the buyer — all within the same atomic call, with no `approve` step ever
required from the buyer. The subtlety this design depends on: that escrow
pull is bound as a Soroban **sub-invocation** of the same `settle` call the
client's witness authorizes (per CAP-0046-11's authorization-tree matching),
not invoked as a standalone `require_auth()` on a literal transfer. A naive
version — the buyer signs a plain authorization for the literal transfer
itself — would produce a *bearer credential*: since the resource server
receives the signed witness before the facilitator does (see Protocol Flow,
step 6-7), any holder of it could invoke the transfer directly, as a
standalone call, bypassing the refund/fee-split logic entirely. Nesting the
pull as a sub-invocation of `settle` closes that: Soroban's authorization
tree only authorizes the transfer when it occurs nested exactly under this
specific `settle` call, not as a top-level invocation on its own. This was
verified **live**, not just unit-tested: the exact signed witness from a real
settlement was reused to attempt the standalone transfer directly, and the
real network rejected it with `Error(Auth, InvalidAction)` — see "Security
Considerations" below and `e2e/conformance/CONFORMANCE_REPORT.md`.

This is also the mechanism behind this spec's differentiated contribution,
**managed `upto`**: because the contract already controls all fund movement
out of escrow, it can split a single settlement between the seller (`pay_to`)
and the facilitator (`facilitator`) in the same atomic call, paying the
facilitator's fee on-chain rather than requiring a separate off-chain billing
system. See `docs/architecture.md` for the three-tier billing model this
enables (`exact` and standard `upto` bill off-chain, like the reference
Coinbase facilitator's per-transaction pricing; managed `upto` is paid
atomically on-chain).

## Protocol Flow

1. **Client** makes a request to a **Resource Server**.
2. **Resource Server** responds `402 Payment Required` with `PaymentRequirements` for the `upto` scheme: `amount` is the **maximum** the client will be asked to authorize, and `extra` carries `settlementContract`, `facilitatorAddress`, `feeBps`, and `areFeesSponsored` (see below).
3. **Client** needs no prior on-chain step — no allowance to create, nothing to approve. It only needs a sufficient balance of `asset` to cover `amount`, since `settle` will pull that balance directly into escrow at settlement time (see "Fund Movement: Escrow-and-Refund" below).
4. **Client** builds an unsigned invocation of `settle(from, pay_to, facilitator, token, max_amount, actual_amount, request_nonce, deadline, fee_bps)` — with `actual_amount` set to `max_amount` as a placeholder purely to obtain a valid simulation — and simulates it to identify the required authorization entry.
5. **Client** signs that one authorization entry (the "witness") with their wallet, setting its expiration to `currentLedger + ledgerTimeout` (same `ledgerTimeout` derivation as `exact`).
6. **Client** encodes the signed authorization entry as base64 XDR and sends a new request to the resource server with a `PaymentPayload` containing it, plus `requestNonce` and `deadline`.
7. **Resource Server** forwards the `PaymentPayload` and `PaymentRequirements` (with `amount` = the maximum) to the **Facilitator Server's** `/verify` endpoint.
8. **Facilitator** decodes the witness entry, cross-checks it against `PaymentRequirements`, checks the client's on-chain token balance (the escrow-pull pre-flight — see "Fund Movement" below), and simulates a real `settle` call (using `actualAmount = maxAmount`, the worst case) to confirm it would succeed.
9. **Facilitator** returns a `VerifyResponse` to the **Resource Server**.
10. **Resource Server**, after the request completes and actual resource consumption is known, forwards the payload to the facilitator's `/settle` endpoint with `PaymentRequirements.amount` set to the **actual** amount to charge (`<= maxAmount`).
    - NOTE: `/settle` MUST perform full verification independently and MUST NOT assume prior verification, same as `exact`.
11. **Facilitator** builds the real `settle` invocation with the metered `actualAmount`, attaches the client's pre-signed witness entry (unmodified — it was never bound to a specific `actualAmount`), and submits it, sponsoring the Stellar network fee.
12. **Facilitator** polls for transaction confirmation and responds with a `SettlementResponse`.
13. **Resource Server**, upon successful settlement, provides the **Client** access to the resource (in practice, this has usually already happened between steps 10 and 12, since actual consumption must be known before settlement can occur — see "Ordering" below).

### Ordering: consumption happens before settlement, not before verification

Unlike `exact`, where verify and settle both happen before the resource is
served, `upto`'s settlement amount is only known *after* consumption. The
resource server therefore: verifies (step 8) to confirm the client's
authorization is well-formed and funded *before* doing any work, serves the
resource while metering usage, then settles (step 10) for the metered amount
afterward. This mirrors the equivalent ordering note in
[`scheme_upto_evm.md`](./scheme_upto_evm.md).

## Fund Movement: Escrow-and-Refund (no prior approval)

Unlike a Permit2-adjacent allowance model, this design requires **no on-chain
step from the client before their first request** — no `approve`, no budget
to size, no separate transaction to submit or pay for. The client only needs
a sufficient balance of `asset` to cover the ceiling they're about to sign
for.

At settlement time, `settle` itself performs the entire fund movement, atomically:

```rust
// 1. Escrow pull — nested as a sub-invocation of this settle() call's own
//    witness authorization (see "Why a dedicated contract" above and
//    "Security Considerations" below for why this nesting is load-bearing).
token.transfer(from, this_contract, max_amount);

// 2. Fee split + refund, out of the contract's own newly-escrowed balance —
//    self-authorizing, since the contract is its own principal here.
let fee = actual_amount * fee_bps / 10_000;
token.transfer(this_contract, pay_to, actual_amount - fee);
if fee > 0 { token.transfer(this_contract, facilitator, fee); }
if max_amount > actual_amount {
    token.transfer(this_contract, from, max_amount - actual_amount);
}
```

The contract owns **zero persistent storage** — there is no allowance to
exhaust across concurrent in-flight requests (the shared-allowance race that
affects an allowance-based design, see "Appendix B", simply does not exist
here: each `settle` call escrows and fully resolves its own `max_amount`
independently), and no on-chain state left behind after a settlement beyond
the transaction and its emitted event.

Facilitators SHOULD check `token.balance(from) >= requirements.amount`
during `/verify` as a cheap pre-flight — analogous in purpose to an allowance
check, but against balance rather than an approval, since there is no
allowance to read — and return `invalid_upto_stellar_insufficient_balance`
if it is not, so clients learn about insufficient funds before attempting
settlement. This is advisory only: the contract's own `transfer` inside
`settle` is the authoritative enforcement.

## Cancellation (not available in this design)

This design keeps no contract-level storage to write a cancellation to, or
query for one — there is no `cancel` entry point, and no way for a buyer to
invalidate one specific pending witness before it either settles or expires.
The only escape hatch is the witness's own `deadline`/
`signatureExpirationLedger`: once either passes, the authorization simply
stops being usable, the same limitation the base `upto` spec already
documents for EVM/SVM ("authorization simply expires, no channel to close").
This is a deliberate tradeoff against the state this design avoids, measured
directly in Appendix B's benchmark comparison.

## `PaymentRequirements` for `upto`

```json
{
  "scheme": "upto",
  "network": "stellar:testnet",
  "amount": "10000000",
  "asset": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  "payTo": "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO",
  "maxTimeoutSeconds": 120,
  "extra": {
    "settlementContract": "CDOMBVUSWUHDSS65VHKUDZ3IJTBUSMZILYULSYSNKCBE654YACKTN6EE",
    "facilitatorAddress": "GCNGT4YTTVFCE3YFQHP5XAKEF3X3FU3GT7LML7AS7F5MV5JWMWTFXVZA",
    "feeBps": 0,
    "areFeesSponsored": true
  }
}
```

**Field Definitions:**

| Field | Phase-dependent? | Description |
|---|---|---|
| `amount` | Yes | At verification time: the **maximum** amount the client authorizes. At settlement time: the **actual amount to settle**, which MUST be `<=` the previously authorized maximum. Identical semantics to the base `upto` spec's §5. |
| `extra.settlementContract` | No | **Required** (not merely optional metadata — a client cannot build a witness without it; see "Facilitator Verification Rules" §3 for why the facilitator MUST reject a request that omits it, not just one that gets it wrong). The deployed `x402UptoStellarEscrowSettlement` contract address for this network. |
| `extra.facilitatorAddress` | No | **Required**, same reasoning. The facilitator signer address that will call `settle` and, when `feeBps > 0`, receive the fee. The client's witness cryptographically binds this address — a different facilitator cannot settle in its place. |
| `extra.feeBps` | No | Basis points of `actualAmount` the facilitator will take on-chain at settlement. `0` = **standard `upto`**: 100% to `payTo`, facilitator bills off-chain (mirrors `exact`'s billing model, and the reference Coinbase facilitator's free-tier-then-per-transaction pricing). `> 0` = **managed `upto`**: the client's signature commits to this exact value, so it cannot be changed after the fact. MUST be `<=` the contract's `max_fee_bps()` (2000 / 20% in the reference deployment). |
| `extra.areFeesSponsored` | No | Whether the facilitator sponsors the Stellar network fee for the settlement transaction. Currently always `true`, matching `exact`. |

## `PaymentPayload` `payload` Field

```json
{
  "authEntry": "AAAAAgAAAAA...",
  "requestNonce": "17423900461829181234",
  "deadline": "1786123000"
}
```

| Field | Type | Description |
|---|---|---|
| `authEntry` | string | Base64-encoded XDR of the client-signed `SorobanAuthorizationEntry` (the witness). |
| `requestNonce` | string (u64) | Part of the signed witness, used for off-chain correlation/idempotency by the facilitator, but does **no enforcement work on-chain** in this design — replay protection is provided entirely by the Soroban host's own per-authorization-entry nonce (CAP-0046-11), distinct from this field. |
| `deadline` | string (Unix timestamp, seconds) | After this time, the contract rejects settlement (`env.ledger().timestamp() > deadline`). Distinct from the authorization entry's own ledger-indexed `signatureExpirationLedger`, which the Soroban host enforces independently when checking the signature itself. |

**Full `PaymentPayload` object:**

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://example.com/llm/generate",
    "description": "LLM text generation, billed per token",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "upto",
    "network": "stellar:testnet",
    "amount": "10000000",
    "asset": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    "payTo": "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO",
    "maxTimeoutSeconds": 120,
    "extra": {
      "settlementContract": "CDOMBVUSWUHDSS65VHKUDZ3IJTBUSMZILYULSYSNKCBE654YACKTN6EE",
      "facilitatorAddress": "GCNGT4YTTVFCE3YFQHP5XAKEF3X3FU3GT7LML7AS7F5MV5JWMWTFXVZA",
      "feeBps": 0,
      "areFeesSponsored": true
    }
  },
  "payload": {
    "authEntry": "AAAAAgAAAAA...",
    "requestNonce": "17423900461829181234",
    "deadline": "1786123000"
  }
}
```

## The Witness

The client signs one Soroban authorization entry whose root invocation is:

```
contract:  extra.settlementContract
function:  "settle"
args:      (from, pay_to, facilitator, token, max_amount, request_nonce, deadline, fee_bps)
```

Note that this is **8 of the 9** arguments `settle` actually takes at call
time — `actual_amount` is deliberately excluded. The contract enforces this
by calling, inside `settle`:

```rust
from.require_auth_for_args(
    (from, pay_to, facilitator, token, max_amount, request_nonce, deadline, fee_bps).into_val(&env)
);
```

`Address::require_auth_for_args` checks authorization against exactly the
args tuple passed to it — **not** the function's full call arguments — so a
witness signed once, during a simulation using `actual_amount = max_amount`
as a placeholder, remains valid for a later real settlement using any
`actual_amount <= max_amount`, at the exact `fee_bps` the client agreed to.

### The witness MUST carry exactly one sub-invocation (the escrow pull)

Unlike a design with no escrow step, this witness's authorized invocation
tree is **not** a bare leaf: when a client simulates the real `settle` call
to derive the witness (Protocol Flow, step 4), the simulation naturally
produces one sub-invocation nested under the root `settle` invocation — the
escrow-pulling `token.transfer(from, settlementContract, max_amount)` — and
that sub-invocation gets signed as part of the same witness. This is not
optional structure to strip out; it is exactly what makes the escrow pull
safe (see "Why a dedicated contract" above). A conformant facilitator MUST
verify the witness carries **exactly one** sub-invocation and that it
structurally matches the expected escrow pull — contract address equal to
the witness's own `token`, function name `"transfer"`, and args equal to
`(from, settlementContract, max_amount)` — rejecting anything with zero,
more than one, or a mismatched sub-invocation. See "Witness Decoding and
Structural Checks" below.

### `facilitator.require_auth()` is also required (MUST)

The witness alone binds `from`'s intent, but says nothing about *who is
allowed to submit it*. `settle` MUST also call:

```rust
facilitator.require_auth();
```

Without this, the witness is a bearer credential: since the resource server
receives it **before** the facilitator does (see Protocol Flow, step 6-7),
any party who has seen it — the resource server itself, a network
intermediary, anything logging the payload — could submit `settle`
themselves. Two concrete harms follow from that gap: an unmetered party could
force an immediate `actual_amount = max_amount` settlement before real usage
is known (defeating the point of `upto`), or grief the legitimate facilitator
by submitting `actual_amount = 0` first, which — per "Zero Settlement" below
— consumes the nonce without moving funds, permanently blocking the fair,
metered settlement the facilitator would otherwise have submitted for a
resource that, per "Ordering" above, has typically already been served.

This check requires no separate signature from the facilitator beyond the
transaction it already submits: since the facilitator is expected to be that
transaction's source account, Soroban satisfies `require_auth()` for a
plain (non-`_for_args`) call automatically via source-account credentials —
but only if the actual submitting signer's address equals `facilitator`
exactly. Facilitator implementations that support multiple signing addresses
MUST route settlement for a given witness through the *specific* address
that witness names, not a pool selected independently (e.g. round-robin) —
see `packages/stellar-upto/src/facilitator/scheme-escrow.ts`'s `settle()`
(this design's reference implementation; `scheme.ts` implements the same
routing for the allowance-based alternative, Appendix B — both share
`buildSettleOperation`, below, as their single source of truth). Because
building the settlement operation directly
(rather than via a full simulate-and-sign helper) does not auto-populate this
source-account credential, implementations MUST also explicitly attach a
`sorobanCredentialsSourceAccount`-typed authorization entry for it alongside
the client's witness entry — see the reference implementation's
`buildSettleOperation`.

> **Found via independent assessment, not present in the initial implementation.**
> An adversarial security validation of a pre-release draft of this contract
> identified the missing `facilitator.require_auth()` check; it was added,
> covered by dedicated tests using real (non-blanket-mocked) Soroban
> authorization semantics, and re-validated against a live testnet
> settlement before this spec was finalized. See
> `contracts/upto-settlement-escrow/src/test.rs` (tests
> `settling_without_the_facilitators_authorization_fails` and
> `settling_with_correct_nested_authorization_succeeds`) and
> `e2e/conformance/CONFORMANCE_REPORT.md` for the validation trail. (Originally
> found and fixed against the allowance-based design — see Appendix B — this
> design inherited the fix from the start, not as a later patch.)

Implementations MUST build the args tuple in exactly this order and with
these Soroban Contract Type mappings (see `packages/stellar-upto/src/witness.ts`,
which both the client and facilitator import — this is deliberately the
single source of truth, not duplicated logic that could drift):

| Position | Field | Soroban type |
|---|---|---|
| 0 | `from` | `Address` |
| 1 | `pay_to` | `Address` |
| 2 | `facilitator` | `Address` |
| 3 | `token` | `Address` |
| 4 | `max_amount` | `i128` |
| 5 | `request_nonce` | `u64` |
| 6 | `deadline` | `u64` |
| 7 | `fee_bps` | `u32` |

## Facilitator Verification Rules (MUST)

A facilitator verifying an `upto` payload on Stellar MUST enforce all of the
following before returning `isValid: true`:

### 1. Protocol Validation

- `x402Version` MUST be `2`.
- Both `payload.accepted.scheme` and `requirements.scheme` MUST be `"upto"`.
- `payload.accepted.network` MUST match `requirements.network`.

### 2. Witness Decoding and Structural Checks

- `authEntry` MUST decode as a valid `SorobanAuthorizationEntry`.
- Credentials MUST use `sorobanCredentialsAddress` (not source-account credentials).
- The signature field MUST NOT be void (i.e. it must actually be signed).
- The root invocation MUST authorize exactly one `sorobanAuthorizedFunctionTypeContractFn` call.
- The invocation's `contractAddress` MUST equal `requirements.extra.settlementContract`.
- The invocation's `functionName` MUST be `"settle"`.
- The invocation MUST carry exactly 8 args, matching the table above.
- Each arg MUST be validated against its expected Soroban type (e.g. position 4 MUST be `i128`, not merely "whatever `scValToNative` happens to coerce it to") *before* being converted to a native value — an implementation that skips this and only type-casts at the language level (e.g. TypeScript's `as string`) can silently accept a malformed witness whose fields decode to unexpected values.
- The invocation MUST carry **exactly one** sub-invocation, structurally validated (not merely counted) against the expected escrow pull: `contractAddress` equal to the witness's own `token`, `functionName` equal to `"transfer"`, and args equal to `(from, settlementContract, max_amount)` — see "The witness MUST carry exactly one sub-invocation" above. Zero sub-invocations, more than one, or a structural mismatch on any of these MUST be rejected; treating "no sub-invocations" as acceptable would silently accept a witness shaped for the allowance-based alternative design instead (Appendix B), which has no escrow pull to authorize.
- The credentials' signing address MUST equal the witness's own `from` field (position 0) — the Soroban host is expected to reject a mismatch on its own when checking `require_auth_for_args`, but a facilitator SHOULD verify this explicitly rather than relying on that host-level guarantee, since doing so turns a wasted RPC simulate call into an immediate, specific rejection.

### 3. Cross-Checking the Extracted Commitment (authoritative, not the JSON)

The witness's extracted args are the **authoritative** source for `from`,
`pay_to`, `facilitator`, `token`, `max_amount`, `request_nonce`, `deadline`,
and `fee_bps` — they are the only fields cryptographically bound by the
client's signature. A facilitator MUST NOT trust a separately-carried JSON
field (e.g. `payload.accepted.amount`, or `requestNonce`/`deadline` on the
`PaymentPayload.payload` object) as authoritative for any value that also
appears inside the signed witness; those JSON copies exist for convenience
and MUST be cross-checked for equality against the extracted commitment, not
substituted for it.

Required equality checks:
- `commitment.payTo == requirements.payTo`
- `commitment.token == requirements.asset`
- `commitment.feeBps == (requirements.extra.feeBps ?? 0)` — a missing `extra.feeBps` MUST be treated as `0`, not skipped: an implementation that skips the comparison entirely when the field is absent would let a client-signed non-zero `feeBps` through unchecked whenever the resource server simply omits the field, silently reducing the seller's cut.
- `commitment.requestNonce == payload.payload.requestNonce` (as decimal strings)
- `commitment.deadline == payload.payload.deadline`
- At **verify** time: `commitment.maxAmount == requirements.amount`
- At **settle** time: `requirements.amount <= commitment.maxAmount` (see "Phase-Dependent Amount Semantics" below)
- `requirements.extra.settlementContract == <the facilitator's own resolved settlement contract for this network>` — **required, not merely checked if present.** This field is never itself used to decide which contract the facilitator interacts with (that's always the facilitator's own configuration), so a mismatch can't misdirect funds, but the field is advertised to clients (who approve their SEP-41 allowance against it) and MAY be cataloged, and it's operationally required in the first place — a client cannot construct a witness at all without a `settlementContract` to build the auth entry against (see "The Witness" above) — so an honest, complete request never omits it. A facilitator MUST treat an omitted value the same as a wrong one, not silently accept it because there was nothing to compare against.
- `requirements.extra.facilitatorAddress == commitment.facilitator` — required for the same reason: a client cannot sign a witness without knowing which `facilitator` to name in it.

`payload.accepted` (the client-echoed advertised terms the payload was
constructed for) is a **separate** field from `requirements` and is subject
to the same rule: it MUST also be cross-checked against the commitment, not
trusted as-is. `requirements` is what THIS specific call (verify or settle)
supplies and is what the checks above bind to; `accepted` is meant to be
phase-invariant — the same object the client originally signed against,
carried unchanged through both calls — and a facilitator with any downstream
consumer of `accepted` (this reference implementation catalogs it into
Bazaar discovery on a successful settlement, since it's the advertised
ceiling, not the settle-phase actual charge — see "Settlement Logic") MUST
NOT assume it is automatically consistent with the witness just because
`requirements` was. For the standard client/resource-server integration
path this equality already holds by construction (the resource server's own
route config is deep-equality-checked against `payload.accepted` upstream of
the facilitator), but a facilitator's `/verify`/`/settle` HTTP routes are
necessarily public (any resource server must be able to call them with no
prior registration), so a direct caller holding a validly-signed witness
could otherwise supply a different `accepted` unconstrained by anything.
Required equality checks, in addition to the ones above:
- `commitment.payTo == accepted.payTo`
- `commitment.token == accepted.asset`
- `commitment.feeBps == (accepted.extra.feeBps ?? 0)`
- `commitment.maxAmount == accepted.amount` — **unconditionally**, in both
  phases (unlike `requirements.amount`, `accepted.amount` is never
  overridden to the settle-phase actual charge).
- `accepted.extra.settlementContract` and `accepted.extra.facilitatorAddress`
  MUST agree with the same values `requirements.extra` was just checked
  against, above — required, not merely checked if present, for the same
  reason.

A facilitator with a settlement-idempotency cache (see "Idempotency" below)
MUST NOT let these checks be bypassed by a cache hit. If a cache lookup key
is derived from anything narrower than the full request (e.g. the witness
bytes and settle amount alone, without `accepted`/`requirements`), a replay
carrying the same witness and amount but a mutated `accepted` or
`requirements` would collide with a prior *real* settlement's cache entry
and receive its cached `success` result without ever re-running these
checks against the mutated fields — undoing them entirely for any caller
willing to replay a previously-real settlement. The cache key MUST
fingerprint the complete request (`payload` including `accepted`, and
`requirements`), so a cache hit only ever occurs for a byte-for-byte
equivalent retry — the only case idempotency is meant to cover in the first
place.

### 4. 🚨🚨🚨 Facilitator Safety

- `commitment.facilitator` MUST be one of the facilitator's own signing addresses.
- `commitment.facilitator` MUST NOT equal `commitment.from` (the payer).
- `commitment.facilitator` MUST NOT equal `commitment.payTo` (the seller).
- `commitment.feeBps` MUST NOT exceed the contract's `max_fee_bps()` (a hard on-chain ceiling independent of any off-chain facilitator configuration).

These checks — mirroring the equivalent facilitator-safety section in
[`scheme_exact_stellar.md`][scheme-exact-stellar] — prevent a malicious or
compromised payload from naming a different facilitator, or from having the
facilitator unknowingly self-deal.

### 5. Time Bounds

- `commitment.deadline` MUST NOT be in the past (`env.ledger().timestamp() <= deadline` at settlement; a facilitator SHOULD apply a small clock-skew tolerance, not exceeding a few seconds, when checking this off-chain before submission).
- The authorization entry's own `signatureExpirationLedger` MUST NOT already be behind the facilitator's current ledger (with a small ledger-count tolerance for RPC skew, mirroring `exact`'s `SIGNATURE_EXPIRATION_LEDGER_TOLERANCE`).

### 6. Balance

- The facilitator SHOULD check `token.balance(from) >= requirements.amount` and reject with `invalid_upto_stellar_insufficient_balance` if insufficient. This is a pre-flight convenience check, this design's equivalent of an allowance check (there is no allowance to read) — the contract's own escrow-pulling `transfer` inside `settle` is the authoritative enforcement.

### 7. Simulation

- The facilitator MUST simulate the real `settle` invocation (with `actualAmount` = `requirements.amount` for the current phase) with the client's witness entry attached, and the simulation MUST succeed.
- The simulation-derived resource fee MUST NOT exceed the facilitator's configured `maxTransactionFeeStroops` safety ceiling. **Implementers should size this ceiling for `upto`'s two-transfer settlement, not copy `exact`'s single-transfer default** — see "Transaction Fees" below.

### 8. Availability (verify MUST NOT throw)

`/verify` is reachable by an unauthenticated caller with no funds and no
valid signature — every field it inspects (`requirements.amount`, the
decoded witness) is attacker-influenced input. A facilitator implementation
MUST validate `requirements.amount` (e.g. that it parses as a non-negative
integer string) *before* converting it to a numeric type, and MUST wrap the
entire verification path in structured error handling so that any
unanticipated malformed input yields an `isValid: false` response rather
than an uncaught exception — the latter is a free, zero-cost way to fault the
endpoint. (`/settle` re-runs the same verification internally and inherits
this protection; a facilitator that only guards `/settle` and not `/verify`
directly has not actually closed the gap, since they share the same
underlying check.)

## Phase-Dependent `amount` Semantics

Identical in spirit to [the base `upto` spec's §5](./scheme_upto.md#5-phase-dependent-amount-semantics-in-paymentrequirements)
and to [EVM `upto`'s settle-time verification](./scheme_upto_evm.md#settle-time-verification),
adapted for where the ceiling lives on Stellar:

- At **verification** time, `requirements.amount` represents the maximum the
  client authorizes, and MUST equal the `max_amount` extracted from the
  witness.
- At **settlement** time, `requirements.amount` represents the actual amount
  to settle, communicated by the resource server based on metered
  consumption, and MUST be `<=` the `max_amount` extracted from the witness.
- **Critically**, the facilitator MUST re-derive `max_amount` from the
  witness itself at both phases — never from `requirements.amount` or
  `payload.accepted.amount` — since only the witness is cryptographically
  bound to the client's signature.

## Transaction Fees

Facilitator implementations MAY expose a `maxTransactionFeeStroops`
configuration as a safety ceiling (mirroring `exact`'s equivalent option).
Because `settle` performs up to **three** token transfers (the escrow pull,
the seller leg, and the facilitator-fee leg, plus a fourth for the refund
when `actualAmount < maxAmount`) plus the witness auth check, its
simulation-derived resource fee runs meaningfully higher than `exact`'s
single-transfer fee. Measured live against a deployed testnet contract: a
managed-`upto` settlement's minimum resource fee came in at ~160,366
stroops (~0.016 XLM) — despite the extra transfer, this is *lower* than the
allowance-based alternative design's ~234,098-stroop measurement for a
comparable settlement (Appendix B), since this design never writes a
persistent replay-protection record. The reference implementation
(`packages/stellar-upto`) defaults `maxTransactionFeeStroops` to 250,000
stroops for both designs, deliberately higher than `exact`'s 50,000-stroop
default; implementers copying `exact`'s default into an `upto` facilitator
will see spurious `invalid_upto_stellar_fee_exceeds_maximum` rejections. See
`e2e/conformance/CONFORMANCE_REPORT.md`'s resource-cost benchmark for the
full comparison methodology (`simulateTransaction`-derived, not estimated).

## Settlement Logic

1. Facilitator re-verifies the payload independently (Section "Facilitator Verification Rules"), using `requirements.amount` as the actual amount to settle.
2. The facilitator builds an `invokeHostFunction` operation calling `settle(from, pay_to, facilitator, token, max_amount, actualAmount, request_nonce, deadline, fee_bps)` — **for every `actualAmount`, including `0`** — attaches **two** authorization entries — the client's pre-signed witness (for `from`) and a `sorobanCredentialsSourceAccount`-typed entry (for `facilitator`, satisfied by the transaction's own signature; see "The Witness" above) — and sets itself as the transaction source (sponsoring the network fee, `areFeesSponsored: true`).
3. The facilitator simulates once more at submission time to derive the settlement's Soroban resource fee and footprint (same pattern as `exact`'s settle-time simulation), signs the transaction, and submits it via RPC `sendTransaction`.
4. The facilitator polls for confirmation (`SUCCESS` or `FAILED`).
5. On success, the contract has atomically: verified the witness, pulled `max_amount` from `from` into escrow (nested as a sub-invocation of the witness, per "Why a dedicated contract" above), computed `fee = actualAmount * fee_bps / 10000`, paid `actualAmount - fee` to `pay_to`, paid `fee` to `facilitator` if non-zero, and refunded `max_amount - actualAmount` back to `from` if non-zero.

**A zero-amount settlement MUST still submit a real transaction and MUST NOT
be short-circuited off-chain.** This is the one place this spec deliberately
diverges from the base `upto` spec's "Zero Settlement" allowance (skip
submission, let the authorization expire unused): the Soroban host consumes
the witness's own authorization-entry nonce (CAP-0046-11) the moment the
transaction carrying it is applied, independent of what `actual_amount` the
contract computes with — a `settle` call is single-use regardless of the
amount it settles for, including zero (when `actual_amount == 0`, the
contract still escrows and then fully refunds `max_amount`, a real pair of
transfers, not a no-op). A facilitator that skips submission for
`actualAmount == 0` (as the base-spec shortcut suggests) leaves that witness
unconsumed, so the exact same witness could remain settleable for a real,
nonzero amount later — silently breaking the "one witness, one settlement"
guarantee this design is meant to provide. Implementers MUST always submit,
poll, and return the real transaction hash, even when `actualAmount` is `0`.
(This exact regression was found and fixed during an internal adversarial
validation of the allowance-based design — see Appendix B and
`e2e/conformance/CONFORMANCE_REPORT.md` for the live-testnet proof — and this
design was built with the fix already applied, not patched into it
afterward.)

**`SettlementResponse`:**

```json
{
  "success": true,
  "transaction": "d70e0224bda3bd84aa3880c5847c52232cf07bef5032f81a1ae3bbd2ea7ba367",
  "network": "stellar:testnet",
  "payer": "GDUKT3QFC2NVR2GFYPZIXWXUMZL4EMRA3UVCDY4POEJJLV7SW6QIS6VP",
  "amount": "4000000"
}
```

- `transaction`: transaction hash — always a real, non-empty hash on Stellar,
  including for a `$0` settlement (see the zero-amount note above; this is a
  deliberate departure from the base spec, where an empty string is allowed).
- `amount`: the actual amount settled, in atomic token units.

### Idempotency (SHOULD)

`/settle` may be called more than once for the same witness — a
resource-server retry after a network timeout is the common case, and the
first attempt may in fact have already succeeded on-chain. A facilitator
SHOULD treat a repeated call carrying the same request as *the same
request*, and return the result the first call already produced rather than
re-running verification and a simulate call that will only end up failing
once it reaches the contract's own `NonceAlreadyUsed` check. Only successful
outcomes should be treated this way — a failed attempt may have failed for a
transient reason (a dropped RPC call, for example), so a retry after a
failure SHOULD genuinely re-attempt rather than replay a stale error. This
mirrors ordinary payment-API idempotency-key conventions; neither the base
`upto` spec nor the EVM/SVM profiles address it directly, but it isn't
chain-specific — the reference implementation applies it in
`UptoStellarScheme.settle()` (`packages/stellar-upto`).

**The idempotency cache key MUST fingerprint the complete request** —
`payload` (including `accepted`) and `requirements` — **not just the
witness bytes and settle amount.** A cache hit intentionally skips the
checks in "Facilitator Verification Rules" entirely (that's the performance
point of caching), so if the key is narrower than the full request, a
replay carrying the same witness and amount but *mutated* `accepted`/
`requirements` collides with a prior real settlement's cache entry and
receives its cached `success` result without those fields ever being
re-checked — silently undoing every §3 cross-check for `accepted` for any
caller willing to replay a witness that was genuinely settled once. See
"Cross-Checking the Extracted Commitment" above and
`e2e/conformance/CONFORMANCE_REPORT.md`, "idempotency cache bypasses
validation," for how this was found. A cache hit still short-circuits
before any decode or RPC work — fingerprinting the full, already-in-memory
request objects is no more expensive than fingerprinting a substring of
them.

A facilitator's own downstream hooks (billing, cataloging, or anything else
triggered on a successful settlement) SHOULD also be idempotent
independently of this cache: even with a correctly-scoped cache key, an
*honest* retry (the common case this feature exists for) still produces a
second `success` result and SHOULD NOT be double-counted by, for example,
an off-chain billing ledger. The reference implementation deduplicates
billing records by the settlement's transaction hash
(`packages/facilitator/src/billing.ts`), since a cached replay's result —
including `transaction` — is always identical to the original.

## Error Codes

In addition to the standard x402 error codes, the reference implementation
(`packages/stellar-upto`) defines:

| Code | Meaning |
|---|---|
| `upto_stellar_network_not_configured` | No settlement contract is configured for `requirements.network` on this facilitator |
| `invalid_upto_stellar_payload_malformed` | `authEntry`/`requestNonce`/`deadline` missing or undecodable |
| `invalid_upto_stellar_witness_wrong_contract` | Witness targets a different contract than `extra.settlementContract` |
| `invalid_upto_stellar_witness_wrong_function` | Witness authorizes a function other than `settle` |
| `invalid_upto_stellar_witness_wrong_arity` | Witness args count is not 8 |
| `invalid_upto_stellar_witness_missing_escrow_subinvocation` | Witness carries zero, or more than one, sub-invocation (exactly one — the escrow pull — is required; see "The witness MUST carry exactly one sub-invocation") |
| `invalid_upto_stellar_witness_wrong_escrow_subinvocation` | Witness's sub-invocation doesn't structurally match the expected escrow pull (wrong contract, function, or args) |
| `invalid_upto_stellar_witness_wrong_arg_type` | A witness arg's Soroban type doesn't match its expected position (see §2) |
| `invalid_upto_stellar_witness_from_signer_mismatch` | The credentials' signing address doesn't match the witness's own `from` field |
| `invalid_upto_stellar_unsupported_credential_type` | Credentials are not address-based |
| `invalid_upto_stellar_missing_payer_signature` | Signature field is void |
| `invalid_upto_stellar_payload_malformed_amount` | `requirements.amount` doesn't parse as a non-negative integer string |
| `invalid_upto_stellar_payload_witness_mismatch` | JSON-carried `requestNonce`/`deadline` disagree with the signed witness |
| `invalid_upto_stellar_payload_wrong_recipient` | Witness `pay_to` disagrees with `requirements.payTo` |
| `invalid_upto_stellar_payload_wrong_asset` | Witness `token` disagrees with `requirements.asset` |
| `invalid_upto_stellar_payload_wrong_fee_bps` | Witness `fee_bps` disagrees with `requirements.extra.feeBps` |
| `invalid_upto_stellar_payload_wrong_settlement_contract` | `requirements.extra.settlementContract` disagrees with the facilitator's own configured contract |
| `invalid_upto_stellar_payload_extra_facilitator_mismatch` | `requirements.extra.facilitatorAddress` disagrees with the witness's committed `facilitator` |
| `invalid_upto_stellar_payload_accepted_inconsistent` | `payload.accepted` (`payTo`/`asset`/`extra.feeBps`/`extra.settlementContract`/`extra.facilitatorAddress`/`amount`) disagrees with the witness commitment |
| `invalid_upto_stellar_fee_exceeds_maximum` | `fee_bps` exceeds the contract's `max_fee_bps()`, or the simulated Stellar network fee exceeds `maxTransactionFeeStroops` |
| `invalid_upto_stellar_payload_wrong_facilitator` | Witness `facilitator` is not one of this facilitator's signing addresses |
| `invalid_upto_stellar_payload_facilitator_is_payer` | Witness `facilitator` equals `from` |
| `invalid_upto_stellar_payload_facilitator_is_payee` | Witness `facilitator` equals `pay_to` |
| `invalid_upto_stellar_payload_wrong_max_amount` | (verify only) `requirements.amount != commitment.maxAmount` |
| `invalid_upto_stellar_settlement_exceeds_amount` | (settle only) `requirements.amount > commitment.maxAmount` |
| `invalid_upto_stellar_deadline_expired` | `commitment.deadline` is in the past |
| `invalid_upto_stellar_signature_expired` | Authorization entry's `signatureExpirationLedger` is behind the current ledger |
| `invalid_upto_stellar_balance_check_failed` | The pre-flight balance read itself failed (e.g. an RPC error), distinct from a successful read that's simply too low |
| `invalid_upto_stellar_insufficient_balance` | On-chain token balance is below the required amount |
| `invalid_upto_stellar_simulation_failed` | The real `settle` simulation did not succeed |
| `settle_upto_stellar_signer_selection_failed` | No facilitator signer available at settlement |
| `settle_upto_stellar_transaction_signing_failed` | Facilitator's own transaction signing failed |
| `settle_upto_stellar_transaction_submission_failed` | RPC `sendTransaction` did not return `PENDING` |
| `settle_upto_stellar_transaction_failed` | Submitted transaction resolved to `FAILED` |

The on-chain contract (`contracts/upto-settlement-escrow`) defines its own
error enum for the checks it performs directly: `DeadlineExpired`,
`ActualExceedsMax`, `NegativeAmount`, `FeeExceedsCeiling`,
`FacilitatorIsPayer`, `FacilitatorIsPayTo` — notably no `NonceAlreadyUsed`:
replay rejection is a Soroban host-level failure (the transaction fails
before the contract ever runs, when a consumed authorization-entry nonce is
reused), not a contract-level error this enum needs to express. A conformant
facilitator's off-chain checks (above) are intended to reject invalid
payloads *before* ever reaching these on-chain paths, so encountering one of
these contract errors at settlement time indicates either a facilitator
implementation bug or a state change between verify and settle.

## Security Considerations

1. **Inherent `upto` trust model.** As in the base scheme and its EVM
   implementation: the facilitator is trusted to charge a fair amount up to
   the authorized maximum. A malicious facilitator could always charge the
   full `maxAmount` regardless of actual usage — this is inherent to the
   `upto` scheme itself, not something this Stellar-specific design can or
   should attempt to fix.
2. **`fee_bps` is client-signed, not facilitator-chosen at settlement time.**
   Unlike a design where the facilitator could pick its cut freely up to a
   ceiling, this scheme includes `fee_bps` inside the signed witness, so the
   facilitator cannot raise its fee after the client has signed. Only the
   contract's hard `MAX_FEE_BPS` ceiling (2000 / 20% in the reference
   deployment) bounds what a facilitator can *quote* in the first place.
3. **Nonce replay.** Enforced entirely by the Soroban host's own
   per-authorization-entry nonce (CAP-0046-11) — this design keeps no
   contract-level storage of its own, so there is no `DataKey` to check or
   write. This is a deliberate departure from the allowance-based
   alternative design (Appendix B), which enforces replay protection via its
   own explicit contract storage instead of relying on the host guarantee;
   CAP-0046-11 itself documents that the host-level nonce exists primarily
   for anti-malleability, not as a general-purpose application replay
   guard — this design accepts that as sufficient specifically because the
   witness's authorized invocation is scoped tightly enough (see item 4
   below) that there is nothing else for a reused nonce to be replayed
   *against*.
4. **The escrow pull's safety depends entirely on sub-invocation scoping —
   verified live, not just unit-tested.** A naive escrow design has the
   client sign a plain `require_auth()` for the literal transfer into the
   contract; that signature is a bearer credential usable to invoke the
   transfer directly and standalone, bypassing the fee-split/refund logic
   entirely (see "Why a dedicated contract" above). This design closes that
   by having the client's witness authorize `settle` itself, with the escrow
   transfer nested as a sub-invocation only reachable from within that exact
   `settle` execution (CAP-0046-11's authorization-tree matching). This was
   proven against the real network, not only a test harness: a genuinely
   signed witness from a completed live settlement was reused to attempt the
   standalone transfer directly, and Stellar's own authorization enforcement
   rejected it with `Error(Auth, InvalidAction)` — see
   `e2e/conformance/CONFORMANCE_REPORT.md`, "Design B live proof." A
   facilitator implementation that relaxes "Witness Decoding and Structural
   Checks" §2's sub-invocation validation (e.g. merely counting
   sub-invocations without checking they match the expected transfer shape)
   would reopen a variant of this exact gap.
5. **No shared-allowance race — structurally, not by mitigation.** Because
   this design has no allowance at all, the shared-allowance race that
   applies to the alternative design (Appendix B) — concurrent in-flight
   requests drawing down one allowance past what the client intended —
   cannot occur here: each `settle` call escrows and fully resolves its own
   `max_amount` independently of any other in-flight request.
6. **No canonical shared contract (yet).** Unlike Permit2 on EVM — which
   achieved canonical, shared-address status only after years of adoption
   and assessments — `x402UptoStellarEscrowSettlement` is new and unaudited. This
   spec does not assume or require a single canonical deployment; each
   facilitator deploys and is responsible for its own instance, addressed
   via `extra.settlementContract`. Canonicalization is left as a future
   ecosystem/governance question, not assumed by the protocol.
7. **Bearer-credential submission gap — found and fixed pre-release.** An
   independent adversarial validation of a draft of this design identified that,
   without `facilitator.require_auth()` (see "The Witness" above), the
   signed witness functioned as a bearer credential: any party who saw it —
   notably the resource server, which receives it before the facilitator
   does — could submit `settle` themselves, either forcing an unmetered
   maximum charge or griefing the facilitator by burning the nonce with a
   zero-amount settlement first. This is a materially broader trust boundary
   than item 1's accepted "the facilitator might overcharge" risk, since it
   extends to *any* holder of the witness, not just the named facilitator.
   The fix (the `require_auth()` call now in "The Witness") closes it, is
   covered by two dedicated contract tests using real (non-blanket-mocked)
   authorization semantics specifically because `env.mock_all_auths()` —
   used everywhere else in the test suite — would have silently passed even
   without the fix, and was re-validated against a live testnet settlement
   after the fix (see `e2e/conformance/CONFORMANCE_REPORT.md`).
8. **Zero-amount off-chain finality gap — found and fixed pre-release
   (against the allowance-based design; this design inherited the fix from
   the start).** A separate external validation found that an earlier reference
   implementation short-circuited `settle()` for `actualAmount == 0`
   off-chain (no transaction submitted), on the incorrect assumption that
   this mirrored the contract's own zero-settlement path. It didn't: the
   allowance-based contract writes `request_nonce` to storage before
   checking `actual_amount == 0`, so a real on-chain zero-settlement was
   single-use just like any other. The off-chain shortcut left the witness
   unburned and settleable for a real amount later, silently narrowing the
   "one witness, one settlement" guarantee to "one witness, one settlement,
   unless the first one happened to settle for zero." Fixed by always
   submitting a real transaction regardless of amount; re-validated live on
   testnet against the allowance-based contract (settle a witness for `0`,
   confirm a real transaction hash, then confirm a second settlement attempt
   for a nonzero amount against the same witness fails on-chain with
   `NonceAlreadyUsed` — see `e2e/conformance/CONFORMANCE_REPORT.md`). This
   design's equivalent property (see the zero-amount note under "Settlement
   Logic" above) holds structurally via the Soroban host's own nonce, not
   via a lesson that had to be relearned.
9. **Unvalidated `payload.accepted` gap — found and fixed pre-release.**
   A further external validation found that `payload.accepted` — the
   client-echoed advertised terms, carried on the payload separately from
   the settle-phase `requirements` object — was never cross-checked against
   the witness commitment at all (only `requirements` was, per §3). For the
   standard client/resource-server integration path this was harmless
   (`accepted` is deep-equality-checked against the resource server's own
   declared price upstream of the facilitator by construction), but this
   facilitator's `/verify`/`/settle` HTTP routes are necessarily public, so
   a direct caller holding a real, validly-signed witness could supply an
   `accepted` with a different `payTo`/`asset`/`feeBps`/`amount`. Settlement
   itself stayed correct either way (driven by `requirements` and the
   witness, not `accepted`), but a downstream consumer of `accepted` — this
   reference implementation catalogs it into Bazaar discovery on a
   successful settlement, since it's the advertised ceiling rather than the
   settle-phase actual charge (see `docs/architecture.md`'s "Discovery
   cataloging" note) — would publish whatever the caller supplied unchecked,
   letting a direct caller publish fabricated payTo/asset/price economics
   for a real, settled resource. Fixed by extending §3's cross-check
   requirement to `accepted` as well (`payTo`/`asset`/`feeBps`/`amount`, the
   last unconditionally in both phases); covered by dedicated unit tests in
   `packages/stellar-upto/test/facilitator-verify.test.ts`.
10. **Idempotency cache bypassed item 9's fix, plus an unbound `extra` gap —
   found and fixed pre-release.** A further external validation found two
   compounding issues in item 9's fix. First, `UptoStellarScheme.settle()`'s
   idempotency cache (see "Idempotency" above) was keyed on the witness
   bytes and settle amount alone — narrower than the full request — so a
   replay carrying the same witness+amount but a *mutated* `accepted`
   skipped `_verify` entirely (that's what a cache hit is for) and rode a
   prior real settlement's cached `success` result straight past item 9's
   fix, back into cataloging fabricated economics. This also meant an
   *honest* retry (the case idempotency exists for) still re-triggered the
   facilitator's `onAfterSettle` hooks with a fresh `success` result each
   time, double-counting off-chain billing on every retry, since
   `BillingLedger.record` was a plain append with no dedup. Second, item 9's
   fix itself only bound `payTo`/`asset`/`feeBps`/`amount` — `extra.
   settlementContract` and `extra.facilitatorAddress` remained unchecked on
   both `requirements` and `accepted`, an inconsistent application of the
   same principle (these don't affect fund safety, since the facilitator
   never takes `settlementContract` from `extra` for its own logic, but
   both are advertised to clients and cataloged). **Fixed**: the cache key
   now fingerprints the complete request (payload including `accepted`, and
   requirements — see "Idempotency" above); `BillingLedger.record` dedupes
   by transaction hash (`packages/facilitator/src/billing.ts`); and §3's
   cross-check now also covers `extra.settlementContract`/
   `extra.facilitatorAddress` on both `requirements` and `accepted`. Covered
   by new unit tests in `packages/stellar-upto/test/settlement-cache.test.ts`,
   `packages/stellar-upto/test/facilitator-verify.test.ts`, and
   `packages/facilitator/test/billing.test.ts`.
11. **`extra.settlementContract`/`extra.facilitatorAddress` were checked only
    if present, and a client-facing MCP payment cap could be bypassed by a
    quoting resource server — found and fixed pre-release.** A further
    external validation found two more issues, one Stellar-specific and one in
    the agent-facing SDK layer that consumes this spec. First, item 9's fix
    bound `payTo`/`asset`/`feeBps`/`amount` on `accepted` (and
    `requirements`) to the witness, but left `extra.settlementContract`/
    `extra.facilitatorAddress` checked only "if present" — an inconsistent
    application of the same rule, since both fields are operationally
    required in the first place (a client cannot construct a witness
    without them; see "The Witness" above), so an honest request never
    omits either. **Fixed**: §3's cross-check now requires both fields
    unconditionally, treating an omission the same as a mismatch, on both
    `requirements` and `accepted`. Second — outside this spec's own scope,
    but directly consuming it — `packages/mcp-discovery-server`'s
    `call_resource` tool enforced an operator-configured spending cap by
    probing a resource with one HTTP request (`inspectPaymentRequirements`)
    and then paying via `wrapFetchWithPayment`'s own, entirely separate,
    second HTTP request; nothing guaranteed a resource server quoted the
    same price to both, so a server could quote low on the probe and high
    on the real request and the cap would never see the real quote.
    **Fixed** by checking the cap against the exact response
    `wrapFetchWithPayment` itself uses to construct the payment, via a
    wrapped `fetch` passed into it, rather than a separate probe
    (`packages/mcp-discovery-server/src/index.ts`,
    `checkPaymentRequiredResponse` in `guardrails.ts`). Also hardened in
    the same round: the client's `extra.facilitatorAddress` validation
    checked only truthiness, not Stellar-address format, so a malformed
    remote `402` failed later inside Soroban argument construction instead
    of with a clear validation error (`packages/stellar-upto/src/client/scheme.ts`);
    and `BillingLedger`'s `transaction_hash` column (added in item 9's fix)
    was only added via `CREATE TABLE IF NOT EXISTS`, which is a no-op
    against an operator's pre-existing database file — every `record()`
    call against an existing deployment would have started failing outright
    on upgrade. Fixed with an idempotent migration step that runs on every
    startup regardless of whether the table is new
    (`packages/facilitator/src/billing.ts`).
12. **No external security assessment.** Beyond the validations in items 7 through 11, the
   reference contract has not undergone a formal, independent security
   assessment. Treat it as a proof of concept — validated by unit tests using
   real authorization semantics and by live testnet settlements, and
   validated once adversarially — not as production-hardened infrastructure,
   until a proper assessment is completed.

## Appendix A: Reference Deployment (Stellar Testnet)

- Contract (`x402UptoStellarEscrowSettlement`): `CDOMBVUSWUHDSS65VHKUDZ3IJTBUSMZILYULSYSNKCBE654YACKTN6EE`
- Wasm hash: `4ca9ba977a17754ba29be9ad409fcd3741774ee951ae9d64578a3910c3372e8a`

See `e2e/conformance/CONFORMANCE_REPORT.md` for settled transaction hashes
covering `exact`, standard `upto`, and managed `upto` — including the live
sub-invocation security proof described in "Security Considerations" item 4.

## Appendix B: Benchmark Comparison Baseline

This design (escrow-and-refund) was measured against an earlier,
functionally equivalent contract, `x402UptoStellarSettlement`
(`contracts/upto-settlement`), which settles using a SEP-41 **allowance**
plus `transfer_from` instead of escrow-and-refund. It is not documented here
as a parallel protocol — it exists in this codebase, and remains selectable
in the reference implementation (`UPTO_DESIGN=allowance`), specifically so
this comparison stays reproducible, not as a recommended deployment path.

**Resource cost, measured live via `simulateTransaction` against both
deployed contracts, comparable settlement:**

| Metric | This design (escrow-and-refund) | Allowance + `transfer_from` |
|---|---|---|
| Instructions | 2,075,130 | 2,057,787 |
| Write bytes | 648 | 868 |
| Min. resource fee (stroops) | 160,366 | 234,098 |

The allowance design's extra persistent-storage write (a
`DataKey::Nonce(from, request_nonce)` entry this design never writes) costs
more than this design's extra escrow-pull transfer saves — a ~31% higher
minimum resource fee for the allowance design, and the direct, measured
reason escrow-and-refund became this project's canonical design. Full
methodology, reproduction steps, and the capabilities the allowance design
offers in exchange for that cost (buyer-initiated cancellation, an on-chain
settlement-status query) are in `docs/architecture.md`, "Benchmark
methodology and full results," and
`e2e/conformance/CONFORMANCE_REPORT.md`, "Resource benchmark: Design A vs.
Design B, in full."

**Reference Deployment (Stellar Testnet), for reproducing the benchmark:**

- This design: `CDOMBVUSWUHDSS65VHKUDZ3IJTBUSMZILYULSYSNKCBE654YACKTN6EE`
- Allowance + `transfer_from` baseline: `CAA2TLPOAUBMYM26AMBJ6RHOBXVLLVYGF5RYJHITBHEPOWWOG23BKOTB`

[SEP-41]: https://stellar.org/protocol/sep-41
[scheme-exact-stellar]: ../exact/scheme_exact_stellar.md
