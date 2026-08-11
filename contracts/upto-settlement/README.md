# x402UptoStellarSettlement

Soroban contract implementing the x402 `upto` payment scheme on Stellar via
a SEP-41 allowance and `transfer_from` — an earlier design, superseded as
this project's default by the escrow-and-refund
[`contracts/upto-settlement-escrow`](../upto-settlement-escrow) following a
direct resource-cost benchmark comparison (see
[`docs/architecture.md`](../../docs/architecture.md), "The `upto` settlement
design"). It remains fully implemented, tested, and selectable
(`UPTO_DESIGN=allowance` in `packages/facilitator`) for a deployment that
specifically needs its `cancel`/`is_settled` capabilities, which the default
design doesn't offer. See
[`specs/schemes/upto/scheme_upto_stellar.md`](../../specs/schemes/upto/scheme_upto_stellar.md),
Appendix B, for its protocol treatment relative to the canonical (escrow)
design, and the module docs at the top of [`src/lib.rs`](./src/lib.rs) for
the implementation-level summary.

## Build

```bash
stellar contract build
# -> target/wasm32v1-none/release/x402_upto_settlement.wasm
```

## Test

```bash
cargo test
```

18 unit tests cover: standard and managed settlement (fee split), zero-amount
settlement, nonce replay rejection, expired deadline rejection, over-max
amount rejection, fee-ceiling rejection, facilitator self-dealing rejection
(facilitator as payer or payee), `cancel` (blocks a later settlement, doesn't
affect other nonces, can't cancel an already-settled or already-cancelled
nonce), and — the two pairs that matter most —
`settling_without_the_facilitators_authorization_fails` /
`settling_with_the_facilitators_authorization_succeeds`, and
`cancelling_without_the_payers_authorization_fails`, which prove their
respective `require_auth()` checks actually enforce something. Those three
deliberately use selective `mock_auths` instead of the blanket
`env.mock_all_auths()` every other test uses: `mock_all_auths` approves every
authorization check unconditionally, so a test suite built entirely on it
cannot distinguish "this check exists and works" from "this check is
missing" — which is exactly how the `facilitator.require_auth()` gap (see
"Security fix" below) went unnoticed until an adversarial validation looked for
it. The actual client-signature round-trip against a *real* deployed
instance is validated separately in `e2e/conformance` — see that directory's
`CONFORMANCE_REPORT.md` for the live-testnet results, including real
settlement, cancellation, and idempotency transaction hashes.

## Security fix: `facilitator.require_auth()`

An independent adversarial assessment of a pre-release draft found that
`settle` never verified *who submitted it* — only `from`'s witness was
checked. Since the signed witness is a bearer credential handed to the
resource server before the facilitator ever sees it (per the protocol
flow), any holder of it could have called `settle` themselves, either
forcing an unmetered maximum charge or griefing the facilitator by burning
the nonce with a zero-amount settlement first. The fix adds
`facilitator.require_auth()`, satisfied automatically by the facilitator's
own transaction signature (no new signing step) as long as the specific
signer who submits matches the witness-committed `facilitator` address
exactly. See "The Witness" in the spec doc for the full writeup, and
`e2e/conformance/CONFORMANCE_REPORT.md` for the before/after live-testnet
transactions.

## `cancel`: added after a cross-chain design comparison

Solana's `upto` implementation (a payment-channel design) gives a client an
escape hatch — `request_close` plus a grace period — to reclaim escrowed
funds if a channel is never settled. This scheme doesn't escrow client
funds at all (money stays in the client's own account until `settle` moves
it via a SEP-41 allowance), so a client already had a coarser equivalent:
revoking the entire allowance (`approve(spender, 0, ...)`) blocks every
future settlement under it, immediately, no grace period needed. What that
can't do is kill *one* specific stale or disputed witness while leaving a
shared allowance's other, still-wanted requests alone. `cancel(from,
request_nonce)` closes that narrower gap — see the doc comment on `cancel`
in `src/lib.rs` for the full design note, and `e2e/conformance/CONFORMANCE_REPORT.md`
for the live-testnet transaction proving it blocks a later settlement
attempt using the cancelled nonce.

## Deploy

```bash
stellar contract deploy \
  --wasm target/wasm32v1-none/release/x402_upto_settlement.wasm \
  --source <deployer-identity> \
  --network testnet \
  --alias x402-upto-settlement
```

Each facilitator operator deploys and owns their own instance — see "No
canonical shared contract" in `docs/architecture.md` for why this differs
from EVM's shared Permit2 deployment.

## Reference deployment (Stellar testnet)

- Contract: `CAA2TLPOAUBMYM26AMBJ6RHOBXVLLVYGF5RYJHITBHEPOWWOG23BKOTB`
- Wasm hash: `1351a471eb1ded52c81bec25153cb6e4b9d2f5aeb0fc49ad21977becd87efd75`

(Two earlier deployments are superseded — do not use them:
`CDOMPXLT4JXBEGEBXXLMW64LHB2OMUWKR3AOMHSMWUOW54HQFETUEXPE` predates the
`facilitator.require_auth()` security fix, and
`CCZMZ7OJEBSIPTUS3NR7CWRC3EVLNS2H3RJZBC2LNVFJBSG24IEZXZK2` predates `cancel`.)

## Interface

```
settle(from, pay_to, facilitator, token, max_amount, actual_amount,
       request_nonce, deadline, fee_bps) -> (seller_amount, facilitator_fee)

cancel(from, request_nonce)   // payer-only; invalidates one witness before settlement

is_settled(from, request_nonce) -> bool
max_fee_bps() -> u32   // 2000 (20%), the hard on-chain ceiling
```
