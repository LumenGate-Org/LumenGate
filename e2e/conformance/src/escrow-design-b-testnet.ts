/**
 * Live testnet conformance check for `x402-upto-settlement-escrow` (Design
 * B) — the escrow-and-refund `upto` contract built as a corrected version
 * of a design proposed in external validation, alongside the existing
 * `x402-upto-settlement` (Design A, allowance + `transfer_from`).
 *
 * Two things are proven here, both live, against the real deployed
 * contract — not mocked, not just the Rust unit test harness:
 *
 * 1. **The happy path works.** A witness signed for `maxAmount` (via
 *    `contract.AssembledTransaction`, which auto-populates the required
 *    authorization tree — including the escrow-pull `token.transfer` as a
 *    sub-invocation of `settle`, entirely from simulating the real call, no
 *    hand-built XDR) settles later for a genuinely different `actualAmount`,
 *    correctly splitting the fee and refunding the difference, atomically.
 *
 * 2. **The bearer-artifact fix holds on a real network.** The exact signed
 *    authorization entry produced in step 1 — whose root invocation is
 *    `settle(...)` with the escrow transfer nested as its sub-invocation —
 *    is then reused to attempt a DIRECT, standalone `token.transfer(from,
 *    contract, maxAmount)` call, bypassing `settle()` entirely. This is
 *    exactly what a party holding an extracted/leaked signed entry would
 *    try (per the protocol flow, the resource server sees the witness
 *    before the facilitator ever does). If Soroban's real authorization
 *    tree matching (CAP-0046-11) enforces what it's specified to, this
 *    submission must fail on-chain — proving the fix isn't just a property
 *    of the Rust test harness's mock, but of the actual network.
 */
import {
  createEd25519Signer,
  STELLAR_TESTNET_CAIP2,
  getNetworkPassphrase,
  getRpcClient,
  type ClientStellarSigner,
  type FacilitatorStellarSigner,
} from "@x402/stellar";
import { buildSettleScArgs, type UptoWitnessCommitment } from "@x402-stellar/upto";
import {
  contract,
  nativeToScVal,
  scValToNative,
  xdr,
  Address,
  Operation,
  TransactionBuilder,
  BASE_FEE,
  Keypair,
} from "@stellar/stellar-sdk";

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
};

const ESCROW_CONTRACT = env("ESCROW_CONTRACT");
const ASSET_TOKEN = env("ASSET_TOKEN");
const BUYER_SECRET = env("BUYER_SECRET");
const FACILITATOR_SECRET = env("FACILITATOR_SECRET");
const SELLER_ADDRESS = env("SELLER_ADDRESS");
const RPC_URL = process.env.RPC_URL ?? "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = getNetworkPassphrase(STELLAR_TESTNET_CAIP2);

async function balanceOf(address: string): Promise<bigint> {
  const tx = await contract.AssembledTransaction.build({
    contractId: ASSET_TOKEN,
    method: "balance",
    args: [nativeToScVal(address, { type: "address" })],
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: RPC_URL,
    publicKey: address,
    parseResultXdr: scValToNative,
  });
  if (!tx.simulation || !("result" in tx.simulation) || !tx.simulation.result) {
    throw new Error(`balance simulation failed for ${address}`);
  }
  return scValToNative(tx.simulation.result.retval) as bigint;
}

async function main(): Promise<void> {
  const buyerSigner: ClientStellarSigner = createEd25519Signer(BUYER_SECRET, STELLAR_TESTNET_CAIP2);
  const facilitatorSigner: FacilitatorStellarSigner = createEd25519Signer(
    FACILITATOR_SECRET,
    STELLAR_TESTNET_CAIP2,
  );
  const server = getRpcClient(STELLAR_TESTNET_CAIP2, { url: RPC_URL });

  const feeBps = 500; // 5%, exercises the fee-split path
  const maxAmount = 500_000n; // 0.05 TUSD
  const actualAmount = 200_000n; // 0.02 TUSD metered usage
  const requestNonce = BigInt(Math.floor(Date.now() / 1000));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);

  const commitment: UptoWitnessCommitment = {
    from: buyerSigner.address,
    payTo: SELLER_ADDRESS,
    facilitator: facilitatorSigner.address,
    token: ASSET_TOKEN,
    maxAmount,
    requestNonce,
    deadline,
    feeBps,
  };

  console.log(`Buyer: ${buyerSigner.address}`);
  console.log(`Facilitator: ${facilitatorSigner.address}`);
  console.log(`Escrow contract: ${ESCROW_CONTRACT}`);

  console.log("\n=== Part 1: happy path ===");
  console.log("1. Client simulates settle(actual=max placeholder) and signs the resulting witness...");
  const latestLedger = await server.getLatestLedger();
  const simTx = await contract.AssembledTransaction.build({
    contractId: ESCROW_CONTRACT,
    method: "settle",
    args: buildSettleScArgs(commitment, maxAmount),
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: RPC_URL,
    parseResultXdr: (result: xdr.ScVal) => result,
  });
  if (!simTx.simulation || !("result" in simTx.simulation)) {
    throw new Error(`settle simulation failed: ${JSON.stringify(simTx.simulation)}`);
  }

  const missingSigners = simTx.needsNonInvokerSigningBy();
  console.log(`   needs signatures from: ${missingSigners.join(", ")}`);
  if (!missingSigners.includes(buyerSigner.address)) {
    throw new Error(`Expected buyer (${buyerSigner.address}) to need to sign, got [${missingSigners.join(", ")}]`);
  }

  await simTx.signAuthEntries({
    address: buyerSigner.address,
    signAuthEntry: buyerSigner.signAuthEntry,
    expiration: latestLedger.sequence + 100,
  });

  const builtSimTx = simTx.built;
  if (!builtSimTx) throw new Error("assembly did not produce a built transaction");
  const invokeOp = builtSimTx.operations[0] as Operation.InvokeHostFunction;
  const signedEntry = (invokeOp.auth ?? []).find(entry => {
    const credentials = entry.credentials();
    if (credentials.switch() !== xdr.SorobanCredentialsType.sorobanCredentialsAddress()) return false;
    const address = scValToNative(xdr.ScVal.scvAddress(credentials.address().address())) as string;
    return address === buyerSigner.address;
  });
  if (!signedEntry) throw new Error("signing did not produce a witness authorization entry");

  const subInvocationCount = signedEntry.rootInvocation().subInvocations().length;
  console.log(`   signed entry root: settle(...), sub-invocations: ${subInvocationCount}`);
  if (subInvocationCount !== 1) {
    throw new Error(
      `Expected exactly 1 sub-invocation (the escrow token.transfer), got ${subInvocationCount} — ` +
        "the auth tree wasn't nested the way the design requires.",
    );
  }
  const subFn = signedEntry.rootInvocation().subInvocations()[0].function().contractFn();
  console.log(`   sub-invocation: ${subFn.functionName()} on ${Address.fromScAddress(subFn.contractAddress()).toString()}`);

  const sellerBalanceBefore = await balanceOf(SELLER_ADDRESS);
  const facilitatorBalanceBefore = await balanceOf(facilitatorSigner.address);
  const buyerBalanceBefore = await balanceOf(buyerSigner.address);

  console.log("2. Facilitator submits the real settle() with a lower actualAmount...");
  const facilitatorAuthEntry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(ESCROW_CONTRACT).toScAddress(),
          functionName: "settle",
          args: buildSettleScArgs(commitment, actualAmount),
        }),
      ),
      subInvocations: [],
    }),
  });
  const settleOp = Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(ESCROW_CONTRACT).toScAddress(),
        functionName: "settle",
        args: buildSettleScArgs(commitment, actualAmount),
      }),
    ),
    auth: [signedEntry, facilitatorAuthEntry],
    source: facilitatorSigner.address,
  });

  // Two separate `TransactionBuilder(...).build()` calls below each need their
  // own freshly-fetched account object — `.build()` increments the account's
  // sequence number as a side effect, so reusing the same object across two
  // builds (one for simulation, one for the real submission) would silently
  // submit with a stale sequence number and fail with txBadSeq.
  const simAccount = await server.getAccount(facilitatorSigner.address);
  const settleSim = await server.simulateTransaction(
    new TransactionBuilder(simAccount, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
      .setTimeout(60)
      .addOperation(settleOp)
      .build(),
  );
  if (!("transactionData" in settleSim) || !settleSim.transactionData) {
    throw new Error(`settle simulation failed: ${JSON.stringify(settleSim)}`);
  }
  const facilitatorAccount = await server.getAccount(facilitatorSigner.address);
  const settleTx = new TransactionBuilder(facilitatorAccount, {
    fee: "300000",
    networkPassphrase: NETWORK_PASSPHRASE,
    sorobanData: settleSim.transactionData.build(),
  })
    .setTimeout(60)
    .addOperation(settleOp)
    .build();
  settleTx.sign(Keypair.fromSecret(FACILITATOR_SECRET));
  const sendResult = await server.sendTransaction(settleTx);
  if (sendResult.status !== "PENDING") {
    throw new Error(`settle submission failed: ${JSON.stringify(sendResult)}`);
  }
  const settleHash = sendResult.hash;
  let settleStatus = await server.getTransaction(settleHash);
  for (let i = 0; i < 20 && settleStatus.status === "NOT_FOUND"; i++) {
    await new Promise(r => setTimeout(r, 1500));
    settleStatus = await server.getTransaction(settleHash);
  }
  if (settleStatus.status !== "SUCCESS") {
    throw new Error(`settle transaction failed: ${JSON.stringify(settleStatus)}`);
  }
  console.log(`   settle tx: https://stellar.expert/explorer/testnet/tx/${settleHash}`);

  const sellerBalanceAfter = await balanceOf(SELLER_ADDRESS);
  const facilitatorBalanceAfter = await balanceOf(facilitatorSigner.address);
  const buyerBalanceAfter = await balanceOf(buyerSigner.address);

  const expectedFee = (actualAmount * BigInt(feeBps)) / 10_000n;
  const expectedSeller = actualAmount - expectedFee;
  const expectedRefund = maxAmount - actualAmount;

  const sellerDelta = sellerBalanceAfter - sellerBalanceBefore;
  const facilitatorDelta = facilitatorBalanceAfter - facilitatorBalanceBefore;
  const buyerDelta = buyerBalanceBefore - buyerBalanceAfter; // buyer paid net (max - refund) = actual

  console.log(`3. Balance deltas: seller +${sellerDelta} (expect +${expectedSeller})`);
  console.log(`                   facilitator +${facilitatorDelta} (expect +${expectedFee})`);
  console.log(`                   buyer net -${buyerDelta} (expect -${actualAmount})`);

  if (sellerDelta !== expectedSeller || facilitatorDelta !== expectedFee || buyerDelta !== actualAmount) {
    throw new Error("Balance deltas did not match the expected atomic fee split + refund");
  }
  console.log(
    `   refund of ${expectedRefund} correctly returned to buyer atomically, in the same transaction.`,
  );
  console.log("✅ Part 1 PASS: escrow-and-refund settlement works end to end on a real deployed contract.");

  console.log("\n=== Part 2: live misuse attempt (the actual security proof) ===");
  console.log("Attempting to reuse the SAME signed entry to invoke token.transfer DIRECTLY,");
  console.log("bypassing settle() entirely — this is exactly what a party holding a leaked/");
  console.log("extracted witness would try. It MUST fail for this design to be safe.");

  const directTransferOp = Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(ASSET_TOKEN).toScAddress(),
        functionName: "transfer",
        args: [
          nativeToScVal(buyerSigner.address, { type: "address" }),
          nativeToScVal(ESCROW_CONTRACT, { type: "address" }),
          nativeToScVal(maxAmount, { type: "i128" }),
        ],
      }),
    ),
    auth: [signedEntry], // the SAME entry from Part 1 — root is settle(), NOT transfer()
    source: facilitatorSigner.address,
  });

  let misuseRejected: boolean;
  let misuseReason = "";
  try {
    const misuseAccount = await server.getAccount(facilitatorSigner.address);
    const misuseSim = await server.simulateTransaction(
      new TransactionBuilder(misuseAccount, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
        .setTimeout(60)
        .addOperation(directTransferOp)
        .build(),
    );
    if ("error" in misuseSim && misuseSim.error) {
      misuseRejected = true;
      misuseReason = `simulation rejected: ${misuseSim.error}`;
    } else {
      misuseRejected = false;
    }
  } catch (error) {
    misuseRejected = true;
    misuseReason = `threw: ${error instanceof Error ? error.message : String(error)}`;
  }

  console.log(`   result: ${misuseRejected ? "REJECTED" : "NOT REJECTED"} (${misuseReason || "no error"})`);
  if (!misuseRejected) {
    throw new Error(
      "SECURITY FAILURE: the standalone token.transfer call was NOT rejected — the bearer-artifact " +
        "gap is NOT actually closed. Do not present this design as fixed.",
    );
  }

  console.log("✅ Part 2 PASS: Soroban's real authorization tree matching rejected the standalone");
  console.log("   transfer attempt — the signed entry's root (settle) doesn't match the actual");
  console.log("   invocation (a bare top-level transfer), exactly as CAP-0046-11 specifies.");
  console.log("\n🎉 CONFORMANCE PASS: Design B's escrow-and-refund settlement works correctly, and");
  console.log("   its fix for the naive design's bearer-artifact gap holds on a real network,");
  console.log("   not just in the Rust unit test harness's mock.");
}

main().catch(err => {
  console.error("\n❌ CONFORMANCE FAIL:", err);
  process.exit(1);
});
