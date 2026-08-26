/**
 * Live testnet conformance check: `contracts/spending-policy-account`, a
 * reference custom `__check_auth` account that enforces a real, on-chain
 * per-period spending ceiling — not just an owner-key check.
 *
 * Why this exists: `contracts/custom-account-demo` (see
 * `custom-account-testnet.ts`) already proved that a custom `__check_auth`
 * account composes with this project's schemes unmodified, but that
 * account deliberately has no spending-policy logic — a fact this
 * project's own docs stated plainly. This project's submission stated
 * something stronger than what was built: that a real spending policy had
 * already been tested on testnet. This script closes that gap for real,
 * mirroring `custom-account-testnet.ts`'s structure and rigor exactly, but
 * proving the other half of the story: a settlement that *respects* the
 * budget succeeds, and one that would *exceed* it is rejected on-chain,
 * not just in a unit test.
 *
 * Same client-side signing note as `custom-account-testnet.ts`: the
 * facilitator side (`ExactStellarScheme`) is completely unmodified; only
 * the client-side signing here is custom, since this account's `Signature`
 * type is a raw 64-byte Ed25519 signature, not a plain keypair's classic
 * wrapper.
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

const SPENDING_POLICY_CONTRACT = env("SPENDING_POLICY_CONTRACT");
const OWNER_SECRET = env("OWNER_SECRET"); // ed25519 secret whose public key was `init`'d as the account's owner
const ASSET_TOKEN = env("ASSET_TOKEN");
const FACILITATOR_SECRET = env("FACILITATOR_SECRET");
const SELLER_ADDRESS = env("SELLER_ADDRESS");
const RPC_URL = process.env.RPC_URL ?? "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

async function remainingBudget(): Promise<bigint> {
  const tx = await contract.AssembledTransaction.build({
    contractId: SPENDING_POLICY_CONTRACT,
    method: "remaining_budget",
    args: [],
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: RPC_URL,
    publicKey: SELLER_ADDRESS,
    parseResultXdr: scValToNative,
  });
  if (!tx.simulation || !("result" in tx.simulation) || !tx.simulation.result) {
    throw new Error("remaining_budget simulation failed");
  }
  return scValToNative(tx.simulation.result.retval) as bigint;
}

/** Builds, signs (via the account's custom Ed25519 signature shape), and
 * returns a `PaymentPayload` for a single `exact` transfer of `amount` from
 * the spending-policy account to the seller — identical in structure to
 * `custom-account-testnet.ts`'s single settlement, factored out here since
 * this script needs to build two of them in sequence. */
async function buildSignedPayload(
  amount: string,
  server: ReturnType<typeof getRpcClient>,
  owner: Keypair,
  requirements: PaymentRequirements,
): Promise<PaymentPayload> {
  const latestLedger = await server.getLatestLedger();
  const expiration = latestLedger.sequence + 40;
  const tx = await contract.AssembledTransaction.build({
    contractId: ASSET_TOKEN,
    method: "transfer",
    args: [
      nativeToScVal(SPENDING_POLICY_CONTRACT, { type: "address" }),
      nativeToScVal(SELLER_ADDRESS, { type: "address" }),
      nativeToScVal(amount, { type: "i128" }),
    ],
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: RPC_URL,
    parseResultXdr: (result: xdr.ScVal) => result,
  });

  const missingSigners = tx.needsNonInvokerSigningBy();
  if (!missingSigners.includes(SPENDING_POLICY_CONTRACT)) {
    throw new Error(
      `Expected the spending-policy account (${SPENDING_POLICY_CONTRACT}) to need to sign, got [${missingSigners.join(", ")}]`,
    );
  }

  const builtTx = tx.built;
  if (!builtTx) throw new Error("assembly did not produce a built transaction");
  const invokeOp = builtTx.operations[0] as Operation.InvokeHostFunction;
  const authEntries = invokeOp.auth ?? [];
  const entryIndex = authEntries.findIndex(entry => {
    const credentials = entry.credentials();
    if (credentials.switch().name !== "sorobanCredentialsAddress") return false;
    const addr = scValToNative(xdr.ScVal.scvAddress(credentials.address().address())) as string;
    return addr === SPENDING_POLICY_CONTRACT;
  });
  if (entryIndex === -1) throw new Error("no auth entry found for the spending-policy account");

  const signedEntry = await authorizeEntry(
    authEntries[entryIndex],
    async (_preimage: xdr.HashIdPreimage, payload: Buffer) => ({
      signatureScVal: xdr.ScVal.scvBytes(owner.sign(payload)),
    }),
    expiration,
    NETWORK_PASSPHRASE,
    SPENDING_POLICY_CONTRACT,
  );
  const newAuthEntries = [...authEntries];
  newAuthEntries[entryIndex] = signedEntry;

  const rebuiltOp = Operation.invokeHostFunction({
    func: invokeOp.func,
    auth: newAuthEntries,
    source: invokeOp.source,
  });

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

  return {
    x402Version: 2,
    resource: { url: "https://example.com/spending-policy-conformance-check" },
    accepted: requirements,
    payload: { transaction: finalTx.toXDR() },
  };
}

async function main(): Promise<void> {
  const owner = Keypair.fromSecret(OWNER_SECRET);
  const facilitatorSigner: FacilitatorStellarSigner = createEd25519Signer(
    FACILITATOR_SECRET,
    STELLAR_TESTNET_CAIP2,
  );
  const server = getRpcClient(STELLAR_TESTNET_CAIP2, { url: RPC_URL });
  const facilitator = new ExactStellarScheme([facilitatorSigner], { rpcConfig: { url: RPC_URL } });

  console.log(`Spending-policy account (payer): ${SPENDING_POLICY_CONTRACT}`);
  console.log(`Owner key (signs for the account): ${owner.publicKey()}`);

  const budgetBefore = await remainingBudget();
  console.log(`Remaining budget before this run: ${budgetBefore}`);

  // Sized to fit comfortably under the configured ceiling on its own, but
  // to push a *second* settlement of the same size over it — proving both
  // halves: a within-budget settlement succeeds, and a would-exceed one is
  // rejected on-chain, not just accepted because the signature checked out.
  const withinBudgetAmount = (budgetBefore * 60n / 100n).toString(); // 60% of remaining

  const makeRequirements = (amount: string): PaymentRequirements => ({
    scheme: "exact",
    network: STELLAR_TESTNET_CAIP2,
    asset: ASSET_TOKEN,
    amount,
    payTo: SELLER_ADDRESS,
    maxTimeoutSeconds: 300,
    extra: { areFeesSponsored: true },
  });

  console.log("\n=== Settlement 1: within budget — expected to succeed ===");
  const requirements1 = makeRequirements(withinBudgetAmount);
  const payload1 = await buildSignedPayload(withinBudgetAmount, server, owner, requirements1);

  const verify1 = await facilitator.verify(payload1, requirements1);
  console.log("verify():", verify1);
  if (!verify1.isValid) {
    throw new Error(`Settlement 1 verify() unexpectedly failed: ${verify1.invalidReason} ${verify1.invalidMessage ?? ""}`);
  }

  const settle1 = await facilitator.settle(payload1, requirements1);
  console.log("settle():", settle1);
  if (!settle1.success) {
    throw new Error(`Settlement 1 unexpectedly failed: ${settle1.errorReason}`);
  }
  console.log(`✅ Settlement 1 succeeded — tx: https://stellar.expert/explorer/testnet/tx/${settle1.transaction}`);

  const budgetAfterFirst = await remainingBudget();
  console.log(`Remaining budget after settlement 1: ${budgetAfterFirst}`);

  console.log("\n=== Settlement 2: would exceed the remaining budget — expected to be rejected ===");
  // Same amount as settlement 1 again — comfortably over what's left.
  const overBudgetAmount = withinBudgetAmount;
  const requirements2 = makeRequirements(overBudgetAmount);
  const payload2 = await buildSignedPayload(overBudgetAmount, server, owner, requirements2);

  let rejectedAt: "verify" | "settle" | "did-not-reject" = "did-not-reject";
  let rejectionDetail = "";
  const verify2 = await facilitator.verify(payload2, requirements2);
  console.log("verify():", verify2);
  if (!verify2.isValid) {
    rejectedAt = "verify";
    rejectionDetail = `${verify2.invalidReason} ${verify2.invalidMessage ?? ""}`;
  } else {
    const settle2 = await facilitator.settle(payload2, requirements2);
    console.log("settle():", settle2);
    if (!settle2.success) {
      rejectedAt = "settle";
      rejectionDetail = settle2.errorReason ?? "unknown";
    }
  }

  const budgetAfterSecond = await remainingBudget();
  console.log(`Remaining budget after settlement 2 attempt: ${budgetAfterSecond}`);

  if (rejectedAt === "did-not-reject") {
    throw new Error(
      `CONFORMANCE FAIL: settlement 2 should have been rejected for exceeding the on-chain budget, ` +
        `but it succeeded. Remaining budget went from ${budgetAfterFirst} to ${budgetAfterSecond}.`,
    );
  }
  if (budgetAfterSecond !== budgetAfterFirst) {
    throw new Error(
      `CONFORMANCE FAIL: a rejected settlement changed the recorded budget ` +
        `(${budgetAfterFirst} -> ${budgetAfterSecond}) — a failed attempt must not consume any allowance.`,
    );
  }

  console.log(
    `\n✅ CONFORMANCE PASS: settlement 2 was rejected at ${rejectedAt}() (${rejectionDetail}), ` +
      `and the on-chain budget was left unchanged by the rejection.`,
  );
  console.log(
    "   A real Soroban __check_auth spending-policy account enforced a per-period ceiling live,",
  );
  console.log(
    "   through the unmodified ExactStellarScheme facilitator — not just an owner-key check.",
  );
}

main().catch(err => {
  console.error("\n❌ CONFORMANCE FAIL:", err);
  process.exit(1);
});
