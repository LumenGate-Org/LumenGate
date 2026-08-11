# x402UptoStellarEscrowSettlement

This project's primary, default `upto`/`managed upto` settlement contract
for Stellar — escrow-and-refund, no prior `approve()` step required, no
persistent on-chain state. Wired into `packages/stellar-upto`
(`UptoStellarEscrowScheme`) and `packages/facilitator` (default
`UPTO_DESIGN=escrow`); documented as canonical in
`specs/schemes/upto/scheme_upto_stellar.md`. See the module docs at the top
of [`src/lib.rs`](./src/lib.rs) for the full implementation-level writeup,
and "The `upto` settlement design" in
[`docs/architecture.md`](../../docs/architecture.md) for the design
narrative and security analysis.

An earlier design, [`contracts/upto-settlement`](../upto-settlement)
(allowance + `transfer_from`, referred to as **Design A** below), remains
implemented and selectable (`UPTO_DESIGN=allowance`) and is what this
document's benchmark section compares against.

## Design

The escrow-and-refund flow is inspired by Stellar's official
[Atomic Swap example contract](https://developers.stellar.org/docs/build/smart-contracts/example-contracts/atomic-swap).
It avoids Design A's persistent SEP-41 allowance by having `settle` pull the
buyer's maximum amount into escrow, pay the seller and facilitator, and refund
the remainder atomically. The escrow transfer is scoped as a sub-invocation of
`settle`; a standalone `require_auth()` transfer would be a reusable bearer
credential and is intentionally not used. See the module docs in `src/lib.rs`
and "The `upto` settlement design" in `docs/architecture.md` for the full
analysis.

## Build

```bash
stellar contract build
# -> target/wasm32v1-none/release/x402_upto_settlement_escrow.wasm (6,598 bytes)
```

## Test

```bash
cargo test
```

13 unit tests cover: standard and managed settlement (fee split + refund),
zero-`max_amount` and zero-`actual_amount` edge cases, expired-deadline
rejection, over-max-amount rejection, fee-ceiling rejection, facilitator
self-dealing rejection (as payer or payee), the `max_fee_bps` view, and —
the two pairs that matter most — `settling_without_the_facilitators_authorization_fails`
/ `settling_with_correct_nested_authorization_succeeds` (mirroring Design
A's equivalent pair), and **`escrow_pull_cannot_be_invoked_directly_outside_settle`**,
which is the actual security proof for this whole design: it constructs a
mock authorization whose structure says "the escrow transfer is only valid
nested under `settle`," then attempts to invoke that same transfer directly
as a standalone top-level call, and asserts it panics. `soroban-sdk`'s
`mock_auths` test harness checks this against the real authorization
tree-matching algorithm (not a simplified stand-in), so a passing result
here is real signal — not proof by itself, though; see "Live proof" below
for the same property checked against the actual network.

## Live proof (not just unit-tested)

Deployed to Stellar testnet and exercised for real —
`e2e/conformance/src/escrow-design-b-testnet.ts`
(`pnpm escrow-design-b:testnet` in `e2e/conformance`):

1. **Happy path.** A witness signed for `maxAmount` (via
   `contract.AssembledTransaction`, which simulates the real call and
   auto-populates the required authorization tree — including the
   escrow-pull `token.transfer` as a genuine sub-invocation of `settle`,
   with no hand-built XDR) settled later for a lower, genuinely different
   `actualAmount`: seller and facilitator received their correctly-split
   shares, and the buyer was refunded the difference, atomically, in one
   transaction, with **no prior `approve` call** — see
   `e2e/conformance/CONFORMANCE_REPORT.md`, "Design B live proof," for the
   transaction hash and exact balance deltas.
2. **The security proof.** The exact signed authorization entry from step
   1 — root invocation `settle(...)`, escrow transfer nested as its
   sub-invocation — was then reused to attempt a direct, standalone
   `token.transfer(buyer, contract, maxAmount)` call, bypassing `settle()`
   entirely: exactly what a party holding an extracted/leaked witness would
   try (the resource server sees it before the facilitator does, per the
   protocol flow). The real network rejected it —
   `Error(Auth, InvalidAction)`, "Unauthorized function call for address" —
   proving Soroban's authorization tree matching (CAP-0046-11) enforces the
   scoping this design depends on, on the actual network, not only inside
   the Rust test harness's mock.

## Resource benchmark vs. Design A

`e2e/conformance/src/resource-benchmark-testnet.ts`
(`pnpm resource-benchmark:testnet`), `simulateTransaction` against both
real deployed contracts for a comparable `settle()` call:

| Design | Instructions | Read bytes | Write bytes | Min resource fee (stroops) |
|---|---|---|---|---|
| A (allowance + `transfer_from`) | 2,057,787 | 492 | 868 | 234,098 |
| B (escrow-and-refund) | 2,075,130 | 492 | 648 | 160,366 |

Design B: essentially identical instructions (+0.8%), identical read
footprint, **220 fewer write bytes** (no persistent `Nonce` entry to write
— the concrete, measured effect of Design A's custom replay-protection
storage vs. Design B's reliance on the host's own per-entry nonce), and a
**~31% lower minimum resource fee**. This is the real cost of Design A's
extra persistent state and its `cancel`/`is_settled` capabilities — Design
B is cheaper per settlement precisely because it gives those up.

## What this design gives up vs. Design A

- **No `cancel` entry point.** Design A's `cancel` writes to the same
  storage `settle` checks, letting a buyer invalidate one specific
  not-yet-settled witness on demand. This contract owns no storage at all,
  so there's nothing to write a cancellation to — a buyer's only escape
  hatch is letting `deadline`/`signatureExpirationLedger` expire naturally,
  the same limitation the EVM `upto` spec already documents.
- **No `is_settled` view function.** Design A can answer "has this witness
  already been settled?" as an on-chain read. This contract's replay
  protection lives entirely in the Soroban host's own reserved ledger
  state, not exposed as a friendly contract-level query.
- **`request_nonce` does no enforcement work here.** It's still part of the
  signed args (for interface parity with Design A and off-chain
  correlation), but unlike Design A, on-chain replay protection is the
  host's own per-authorization-entry nonce, not this parameter.

## Interface

```
settle(from, pay_to, facilitator, token, max_amount, actual_amount,
       request_nonce, deadline, fee_bps) -> (seller_amount, facilitator_fee, refund)

max_fee_bps() -> u32   // 2000 (20%), identical ceiling to Design A
```

## Deploy

```bash
stellar contract deploy \
  --wasm target/wasm32v1-none/release/x402_upto_settlement_escrow.wasm \
  --source <deployer-identity> \
  --network testnet \
  --alias x402-upto-settlement-escrow
```

## Reference deployment (Stellar testnet)

- Contract: `CDOMBVUSWUHDSS65VHKUDZ3IJTBUSMZILYULSYSNKCBE654YACKTN6EE`
- Wasm hash: `4ca9ba977a17754ba29be9ad409fcd3741774ee951ae9d64578a3910c3372e8a`

This is the primary, integrated settlement contract — `packages/stellar-upto`
(`UptoStellarEscrowScheme`) and `packages/facilitator` (default
`UPTO_DESIGN=escrow`) target it directly, live-verified end to end through
the real TypeScript facilitator class, not only the raw contract:
`e2e/conformance/src/escrow-facilitator-testnet.ts`
(`pnpm escrow-facilitator:testnet`) runs the standard client against
`UptoStellarEscrowScheme.verify()`/`.settle()`, with correct on-chain
balance deltas across buyer, seller, and facilitator, including the refund
— see `e2e/conformance/CONFORMANCE_REPORT.md`, "Round four," for the
transaction hash and the one real bug that live-verification step caught
before it shipped.
