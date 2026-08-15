# e2e/conformance

Live scripts that exercise the deployed testnet facilitator stack end to end
— real signing, real RPC simulation, real settlement transactions — plus one
read-only pubnet connectivity check (`pubnet:rpc-connectivity`, no signing
or funded account needed) and one no-signing-required resource benchmark
(`resource-benchmark:testnet`). See `CONFORMANCE_REPORT.md` for the recorded
results.

`upto`'s primary, default contract is the escrow-and-refund design
(`contracts/upto-settlement-escrow`, `x402UptoStellarEscrowSettlement`) — it
needs **no prior `approve()` step** from the buyer, just a sufficient token
balance. The allowance-based design (`contracts/upto-settlement`) remains
implemented and selectable (`UPTO_DESIGN=allowance` in the facilitator) and
is what the resource-cost benchmark measures against — see
`CONFORMANCE_REPORT.md`, "Resource benchmark: Design A vs. Design B, in
full."

## Prerequisites

1. A deployed `x402UptoStellarEscrowSettlement` contract (see
   `contracts/upto-settlement-escrow/README.md` for `stellar contract
   deploy`).
2. A SEP-41 token the buyer holds a balance of. Unlike the allowance-based
   design, **no `approve` step is needed** — the escrow contract pulls
   directly from the buyer's balance at settlement time. For a
   self-contained test token (rather than depending on testnet USDC
   availability), wrap a throwaway classic asset:
   ```bash
   stellar keys generate deployer --network testnet --fund
   stellar keys generate buyer --network testnet --fund
   stellar keys generate seller --network testnet --fund
   stellar keys generate facilitator --network testnet --fund

   DEPLOYER=$(stellar keys address deployer)
   for id in buyer seller facilitator; do
     stellar tx new change-trust --source $id --network testnet --line "TUSD:$DEPLOYER"
   done
   stellar tx new payment --source deployer --network testnet \
     --destination buyer --asset "TUSD:$DEPLOYER" --amount 10000000000
   stellar contract asset deploy --source deployer --network testnet --asset "TUSD:$DEPLOYER"
   # -> prints the SAC token contract address; use it as ASSET_TOKEN below
   ```

## Running

```bash
export ESCROW_CONTRACT=<deployed x402UptoStellarEscrowSettlement address>
export ASSET_TOKEN=<SEP-41 token address>
export BUYER_SECRET=$(stellar keys show buyer)
export FACILITATOR_SECRET=$(stellar keys show facilitator)
export SELLER_ADDRESS=$(stellar keys address seller)

pnpm exact:testnet                 # exact scheme, tier 1
pnpm escrow-facilitator:testnet    # upto/managed-upto through the real UptoStellarEscrowScheme
                                    # TypeScript facilitator class (default design) — tiers 2/3
```

Each nonce used by these scripts is derived from the current timestamp, so
repeated runs against the same buyer don't collide.

### The allowance-based design (comparison baseline)

These need `SETTLEMENT_CONTRACT` (a deployed `x402UptoStellarSettlement`
address) instead of `ESCROW_CONTRACT`, and the buyer must `approve` it first
(see "One-Time Allowance" in `specs/schemes/upto/scheme_upto_stellar.md`,
Appendix B):

```bash
stellar contract invoke --id <ASSET_TOKEN> --source buyer --network testnet --send=yes -- \
  approve --from $(stellar keys address buyer) --spender <SETTLEMENT_CONTRACT> \
  --amount 500000000 --expiration_ledger <current+500000>

export SETTLEMENT_CONTRACT=<deployed x402UptoStellarSettlement address>
pnpm upto:testnet                # allowance-based upto scheme, through UptoStellarScheme
pnpm cancel-idempotency:testnet  # cancel, and /settle idempotency on a retried call
pnpm zero-amount-nonce:testnet   # zero-amount settlement burns the nonce on-chain (regression)

# Also requires CHANNEL_ACCOUNT_SECRET (one funded-with-XLM-only account, no
# trustline needed):
export CHANNEL_ACCOUNT_SECRET=<channel account secret key>
pnpm channel-account:testnet     # confirms settlement uses the channel account's
                                  # sequence number, not the facilitator signer's
```

### Design comparison and security proof

```bash
# Requires both ESCROW_CONTRACT and SETTLEMENT_CONTRACT set (above), plus
# BUYER_ADDRESS/FACILITATOR_ADDRESS (public keys only — no secrets/signing
# needed, since simulateTransaction doesn't require real signatures):
export BUYER_ADDRESS=$(stellar keys address buyer)
export FACILITATOR_ADDRESS=$(stellar keys address facilitator)
pnpm resource-benchmark:testnet   # simulateTransaction resource-cost comparison, both designs

# Requires ESCROW_CONTRACT, ASSET_TOKEN, BUYER_SECRET, FACILITATOR_SECRET, SELLER_ADDRESS:
pnpm escrow-design-b:testnet      # raw-contract happy path + the live bearer-artifact security proof
```

### Custom `__check_auth` account composability (RFP-literal requirement)

```bash
# Requires a deployed contracts/custom-account-demo instance, `init`-ed with
# an owner key, and holding a balance of ASSET_TOKEN:
export CUSTOM_ACCOUNT_CONTRACT=<deployed x402CustomAccountDemo address>
export OWNER_SECRET=<the secret whose public key was init'd as the account's owner>
export ASSET_TOKEN=<SEP-41 token address>
export FACILITATOR_SECRET=$(stellar keys show facilitator)
export SELLER_ADDRESS=$(stellar keys address seller)
pnpm custom-account:testnet   # a custom __check_auth account settles a real exact
                               # payment through the unmodified ExactStellarScheme
                               # facilitator — no facilitator changes needed
```

```bash
# No env vars, no funded account, no prerequisites above — pure read-only
# RPC calls (getHealth/getNetwork/getLatestLedger) against real Stellar
# mainnet, proving the facilitator's pubnet wiring reaches genuine mainnet
# infrastructure without spending anything. Set STELLAR_PUBNET_RPC_URL to
# override the default public provider.
pnpm pubnet:rpc-connectivity
```

## Notes from the live run

The first attempt against the real deployment failed for two reasons, neither
a design flaw:

1. **Missing facilitator trustline.** The test token is a Stellar Asset
   Contract wrapping a classic asset, so *any* recipient — including the
   facilitator receiving its on-chain fee — needs a classic trustline first.
   Fixed by adding a `change-trust` step for the facilitator account.
2. **Fee ceiling tuned for the wrong scheme.** `stellar-upto`'s facilitator
   inherited `exact`'s `maxTransactionFeeStroops` default (50,000), sized for
   a single token transfer. `upto`'s `settle` does up to three transfers plus
   the witness auth check, and its real simulation-derived resource fee
   exceeded that ceiling. Fixed by raising the package default to 250,000
   stroops (still ~0.025 XLM — negligible) for both designs.

A later run against the escrow-based `UptoStellarEscrowScheme` (once it was
built) surfaced a read-after-write staleness quirk in the public testnet
RPC's balance-read path, unrelated to the facilitator or contract — see
`CONFORMANCE_REPORT.md`, "Round four," for the full account and fix.

Both fixes are reflected in the current code; the passing runs in
`CONFORMANCE_REPORT.md` are from after these fixes.
