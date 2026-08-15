/**
 * Live testnet conformance check: a payer that is a custom `__check_auth`
 * Soroban account contract — not a plain keypair — settling a real payment
 * through this project's actual, unmodified facilitator code
 * (`@x402/stellar`'s `ExactStellarScheme`, exact same class
 * `packages/facilitator` registers).
 *
 * Why this exists: the RFP states, literally, "Support classic keypairs and
 * custom `__check_auth` accounts." Before this script, this project's own
 * docs (`docs/architecture.md`, "Composition with Stellar smart account
 * spending policies") only argued this composes *by construction* —
 * `require_auth`/`require_auth_for_args` are the same primitive a
 * custom-account contract's `__check_auth` intercepts, so `exact`/`upto`
 * shouldn't care what kind of address the payer is. This script is that
 * argument, proven: `contracts/custom-account-demo` (a minimal Ed25519
 * `__check_auth` account) settles a real `exact` payment, verified and
 * settled by the real `ExactStellarScheme` facilitator, with zero changes
 * to any of this project's shipped code.
 *
 * The one thing NOT reused unmodified: the *client-side* signing. `@x402/
 * stellar`'s exact-scheme client assumes a plain keypair signer
 * (`ClientStellarSigner`/`basicNodeSigner`); a custom account's signature is
 * a different shape (here, a raw 64-byte Ed25519 signature, not the classic
 * `Vec<{public_key, signature}>` wrapper), so this script builds the
 * transaction with the same `contract.AssembledTransaction` the real client
 * uses, then signs the resulting auth entry itself via `authorizeEntry()`'s
 * low-level override path — proving the *facilitator* side needs no
 * changes, which is the actual RFP requirement ("Support ... custom
 * `__check_auth` accounts" is about what the facilitator accepts).
 */
import {
  createEd25519Signer,
  STELLAR_TESTNET_CAIP2,
  getRpcClient,
  type FacilitatorStellarSigner,
} from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  contract,
  nativeToScVal,
  scValToNative,
  xdr,
  Keypair,
  Operation,
  authorizeEntry,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
};

const CUSTOM_ACCOUNT_CONTRACT = env("CUSTOM_ACCOUNT_CONTRACT");
const OWNER_SECRET = env("OWNER_SECRET"); // ed25519 secret whose public key was `init`'d as the account's owner
const ASSET_TOKEN = env("ASSET_TOKEN");
const FACILITATOR_SECRET = env("FACILITATOR_SECRET");
const SELLER_ADDRESS = env("SELLER_ADDRESS");
const RPC_URL = process.env.RPC_URL ?? "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

async function balanceOf(address: string, simulationSource: string): Promise<bigint> {
  // `simulationSource` must be a classic G-account (the SDK resolves
  // `publicKey` via `Keypair.fromPublicKey`, which rejects a contract
  // C-address) — it's only the *simulating* account, unrelated to whose
  // balance is being read, so any funded G-account works here even when
  // `address` itself is the custom account contract.
  const tx = await contract.AssembledTransaction.build({
    contractId: ASSET_TOKEN,
    method: "balance",
    args: [nativeToScVal(address, { type: "address" })],
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: RPC_URL,
    publicKey: simulationSource,
    parseResultXdr: scValToNative,
  });
  if (!tx.simulation || !("result" in tx.simulation) || !tx.simulation.result) {
    throw new Error(`balance simulation failed for ${address}`);
  }
  return scValToNative(tx.simulation.result.retval) as bigint;
}

async function main(): Promise<void> {
  const owner = Keypair.fromSecret(OWNER_SECRET);
  const facilitatorSigner: FacilitatorStellarSigner = createEd25519Signer(
    FACILITATOR_SECRET,
    STELLAR_TESTNET_CAIP2,
  );
  const server = getRpcClient(STELLAR_TESTNET_CAIP2, { url: RPC_URL });

  const amount = "50000"; // 0.005 TUSD (7 decimals)

  console.log(`Custom account (payer): ${CUSTOM_ACCOUNT_CONTRACT}`);
  console.log(`Owner key (signs for the account): ${owner.publicKey()}`);

  const requirements: PaymentRequirements = {
    scheme: "exact",
    network: STELLAR_TESTNET_CAIP2,
    asset: ASSET_TOKEN,
    amount,
    payTo: SELLER_ADDRESS,
    maxTimeoutSeconds: 300,
    extra: {
      areFeesSponsored: true,
    },
  };

  console.log("1. Building the same transfer() call the real exact-scheme client builds...");
  const latestLedger = await server.getLatestLedger();
  // Must stay within the facilitator's own maxLedger check:
  // currentLedger + ceil(maxTimeoutSeconds / estimatedLedgerCloseSeconds) —
  // a signature valid further out than `requirements.maxTimeoutSeconds`
  // implies is rejected (`invalid_exact_stellar_signature_expiration_too_far`).
  // ~5s/ledger, 300s budget above -> comfortably under the ~60-ledger cap.
  const expiration = latestLedger.sequence + 40;
  const tx = await contract.AssembledTransaction.build({
    contractId: ASSET_TOKEN,
    method: "transfer",
    args: [
      nativeToScVal(CUSTOM_ACCOUNT_CONTRACT, { type: "address" }),
      nativeToScVal(SELLER_ADDRESS, { type: "address" }),
      nativeToScVal(amount, { type: "i128" }),
    ],
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: RPC_URL,
    parseResultXdr: (result: xdr.ScVal) => result,
  });

  const missingSigners = tx.needsNonInvokerSigningBy();
  console.log(`   needs signatures from: ${missingSigners.join(", ")}`);
  if (!missingSigners.includes(CUSTOM_ACCOUNT_CONTRACT)) {
    throw new Error(
      `Expected the custom account (${CUSTOM_ACCOUNT_CONTRACT}) to need to sign, got [${missingSigners.join(", ")}]`,
    );
  }

  console.log("2. Signing the auth entry ourselves — not through the real client's keypair-only");
  console.log("   signer, since this account's signature shape is a raw 64-byte Ed25519 sig,");
  console.log("   not the classic Vec<{public_key,signature}> wrapper a plain keypair uses.");
  const builtTx = tx.built;
  if (!builtTx) throw new Error("assembly did not produce a built transaction");
  const invokeOp = builtTx.operations[0] as Operation.InvokeHostFunction;
  const authEntries = invokeOp.auth ?? [];
  const entryIndex = authEntries.findIndex(entry => {
    const credentials = entry.credentials();
    if (credentials.switch().name !== "sorobanCredentialsAddress") return false;
    const addr = scValToNative(xdr.ScVal.scvAddress(credentials.address().address())) as string;
    return addr === CUSTOM_ACCOUNT_CONTRACT;
  });
  if (entryIndex === -1) throw new Error("no auth entry found for the custom account");

  const signedEntry = await authorizeEntry(
    authEntries[entryIndex],
    async (_preimage: xdr.HashIdPreimage, payload: Buffer) => ({
      // Raw 64-byte Ed25519 signature, ScVal-encoded as plain bytes — the
      // exact shape contracts/custom-account-demo's `Signature = BytesN<64>`
      // expects `__check_auth` to receive, bypassing the classic-account
      // `{public_key, signature}` wrapping `authorizeEntry`'s default path
      // would otherwise apply (that wrapping is for the SDK's built-in
      // account contract, not a custom one).
      signatureScVal: xdr.ScVal.scvBytes(owner.sign(payload)),
    }),
    expiration,
    NETWORK_PASSPHRASE,
    CUSTOM_ACCOUNT_CONTRACT,
  );
  const newAuthEntries = [...authEntries];
  newAuthEntries[entryIndex] = signedEntry;

  // Rebuilt from scratch rather than mutating `builtTx.operations[0].auth`
  // in place and hoping `toXDR()` picks it up — this project's other
  // conformance scripts (e.g. escrow-design-b-testnet.ts) already establish
  // that a fresh `Operation.invokeHostFunction` + `TransactionBuilder`,
  // reusing the simulation's own `sorobanData`, is the reliable way to
  // attach a freshly-signed auth entry; no reason to risk a novel pattern
  // here instead of the one already proven.
  const rebuiltOp = Operation.invokeHostFunction({
    func: invokeOp.func,
    auth: newAuthEntries,
    source: invokeOp.source,
  });
  // The facilitator discards this envelope's source account/sequence
  // entirely on settle (it rebuilds around its own account — see
  // `@x402/stellar`'s exact-scheme facilitator, `settle()`), so any valid,
  // existing account works as this shell transaction's source *except* one
  // of the facilitator's own signing addresses — `ExactStellarScheme.verify()`
  // explicitly rejects a client-submitted payload whose transaction or
  // operation source is a facilitator signing address
  // (`invalid_exact_stellar_payload_unsafe_tx_or_op_source`), a real safety
  // check against a client trying to make the facilitator source its own
  // submission. The owner account (a real, independent, funded account) is
  // the natural choice — it's also who a genuine client would use.
  // Soroban resource data from the original simulation — reused here for a
  // well-formed submission, though not load-bearing: the real facilitator
  // (`ExactStellarScheme.settle()`) re-simulates and reassembles around its
  // own account before ever submitting, so this shell transaction only
  // needs to carry the correctly-signed operation through in one piece.
  if (!tx.simulation || !("transactionData" in tx.simulation)) {
    throw new Error("original simulation did not produce transactionData");
  }
  const sorobanData = tx.simulation.transactionData.build();
  const shellAccount = await server.getAccount(owner.publicKey());
  const finalTx = new TransactionBuilder(shellAccount, {
    fee: builtTx.fee,
    networkPassphrase: NETWORK_PASSPHRASE,
    sorobanData,
  })
    .setTimeout(120)
    .addOperation(rebuiltOp)
    .build();

  const paymentPayload: PaymentPayload = {
    x402Version: 2,
    resource: { url: "https://example.com/custom-account-conformance-check" },
    accepted: requirements,
    payload: { transaction: finalTx.toXDR() },
  };

  const facilitator = new ExactStellarScheme([facilitatorSigner], { rpcConfig: { url: RPC_URL } });

  console.log("3. ExactStellarScheme.verify() — the real, unmodified facilitator class...");
  const verifyResult = await facilitator.verify(paymentPayload, requirements);
  console.log("   verify result:", verifyResult);
  if (!verifyResult.isValid) {
    throw new Error(`verify failed: ${verifyResult.invalidReason} ${verifyResult.invalidMessage ?? ""}`);
  }

  const sellerBalanceBefore = await balanceOf(SELLER_ADDRESS, SELLER_ADDRESS);
  const payerBalanceBefore = await balanceOf(CUSTOM_ACCOUNT_CONTRACT, SELLER_ADDRESS);

  console.log("4. ExactStellarScheme.settle()...");
  const settleResult = await facilitator.settle(paymentPayload, requirements);
  console.log("   settle result:", settleResult);
  if (!settleResult.success) {
    throw new Error(`settle failed: ${settleResult.errorReason}`);
  }

  const sellerBalanceAfter = await balanceOf(SELLER_ADDRESS, SELLER_ADDRESS);
  const payerBalanceAfter = await balanceOf(CUSTOM_ACCOUNT_CONTRACT, SELLER_ADDRESS);

  const sellerDelta = sellerBalanceAfter - sellerBalanceBefore;
  const payerDelta = payerBalanceBefore - payerBalanceAfter;

  console.log(`5. Balance deltas: seller +${sellerDelta}, custom-account payer -${payerDelta}`);
  if (sellerDelta !== BigInt(amount) || payerDelta !== BigInt(amount)) {
    throw new Error("Balance deltas did not match the expected transfer amount");
  }

  console.log(
    "\n✅ CONFORMANCE PASS: a custom __check_auth Soroban account settled a real exact payment",
  );
  console.log("   through the unmodified ExactStellarScheme facilitator — proven live, not just");
  console.log("   argued by construction. RFP requirement 'Support classic keypairs and custom");
  console.log("   __check_auth accounts' is now backed by a real transaction.");
  console.log(`   Settlement tx: https://stellar.expert/explorer/testnet/tx/${settleResult.transaction}`);
}

main().catch(err => {
  console.error("\n❌ CONFORMANCE FAIL:", err);
  process.exit(1);
});
