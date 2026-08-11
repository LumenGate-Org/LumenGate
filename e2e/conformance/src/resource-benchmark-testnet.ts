/**
 * Live testnet resource benchmark: Design A (`x402-upto-settlement`,
 * allowance + `transfer_from`) vs. Design B (`x402-upto-settlement-escrow`,
 * escrow-and-refund) — the comparison external validation specifically asked
 * for, via `simulateTransaction` against both real deployed contracts.
 *
 * Soroban's `simulateTransaction` performs authorization checks in a mode
 * that doesn't require real signatures (deferred to actual execution) —
 * only real on-chain state (balances, allowances, prior nonce usage)
 * affects the result — so this needs no witness signing at all, just a
 * comparable, currently-valid call shape for each contract.
 */
import { STELLAR_TESTNET_CAIP2, getNetworkPassphrase, getRpcClient } from "@x402/stellar";
import { nativeToScVal, xdr, Address, Operation, TransactionBuilder, BASE_FEE } from "@stellar/stellar-sdk";

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
};

const DESIGN_A_CONTRACT = env("SETTLEMENT_CONTRACT");
const DESIGN_B_CONTRACT = env("ESCROW_CONTRACT");
const ASSET_TOKEN = env("ASSET_TOKEN");
const BUYER_ADDRESS = env("BUYER_ADDRESS");
const FACILITATOR_ADDRESS = env("FACILITATOR_ADDRESS");
const SELLER_ADDRESS = env("SELLER_ADDRESS");
const RPC_URL = process.env.RPC_URL ?? "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = getNetworkPassphrase(STELLAR_TESTNET_CAIP2);

function settleArgs(maxAmount: bigint, actualAmount: bigint, requestNonce: bigint, deadline: bigint, feeBps: number) {
  return [
    nativeToScVal(BUYER_ADDRESS, { type: "address" }),
    nativeToScVal(SELLER_ADDRESS, { type: "address" }),
    nativeToScVal(FACILITATOR_ADDRESS, { type: "address" }),
    nativeToScVal(ASSET_TOKEN, { type: "address" }),
    nativeToScVal(maxAmount, { type: "i128" }),
    nativeToScVal(actualAmount, { type: "i128" }),
    nativeToScVal(requestNonce, { type: "u64" }),
    nativeToScVal(deadline, { type: "u64" }),
    nativeToScVal(feeBps, { type: "u32" }),
  ];
}

interface BenchResult {
  label: string;
  instructions: number;
  readBytes: number;
  writeBytes: number;
  minResourceFeeStroops: string;
  transactionSizeBytes: number;
}

async function benchmark(label: string, contractId: string, requestNonce: bigint): Promise<BenchResult> {
  const server = getRpcClient(STELLAR_TESTNET_CAIP2, { url: RPC_URL });
  const account = await server.getAccount(FACILITATOR_ADDRESS);

  const maxAmount = 1_000_000n;
  const actualAmount = 400_000n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const feeBps = 500;

  const op = Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(contractId).toScAddress(),
        functionName: "settle",
        args: settleArgs(maxAmount, actualAmount, requestNonce, deadline, feeBps),
      }),
    ),
    auth: [],
  });

  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .setTimeout(60)
    .addOperation(op)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (!("transactionData" in sim) || !sim.transactionData) {
    throw new Error(`${label}: simulation failed: ${JSON.stringify(sim)}`);
  }

  const resources = sim.transactionData.build().resources();
  const minResourceFeeStroops = "minResourceFee" in sim ? String(sim.minResourceFee) : "unknown";

  return {
    label,
    instructions: resources.instructions(),
    readBytes: resources.diskReadBytes(),
    writeBytes: resources.writeBytes(),
    minResourceFeeStroops,
    transactionSizeBytes: tx.toXDR().length, // base64 length, a proxy for wire size
  };
}

async function main(): Promise<void> {
  const nonceA = BigInt(Math.floor(Date.now() / 1000));
  const nonceB = nonceA + 1n; // Design B doesn't actually check this for replay, but keep distinct for clarity

  console.log("Simulating a comparable settle() call against both deployed contracts...");
  console.log(`Design A (allowance + transfer_from): ${DESIGN_A_CONTRACT}`);
  console.log(`Design B (escrow-and-refund):         ${DESIGN_B_CONTRACT}\n`);

  const resultA = await benchmark("Design A (allowance + transfer_from)", DESIGN_A_CONTRACT, nonceA);
  const resultB = await benchmark("Design B (escrow-and-refund)", DESIGN_B_CONTRACT, nonceB);

  const rows = [resultA, resultB];
  console.log("| Design | Instructions | Read bytes | Write bytes | Min resource fee (stroops) | Tx size (base64 bytes) |");
  console.log("|---|---|---|---|---|---|");
  for (const r of rows) {
    console.log(
      `| ${r.label} | ${r.instructions.toLocaleString()} | ${r.readBytes.toLocaleString()} | ${r.writeBytes.toLocaleString()} | ${r.minResourceFeeStroops} | ${r.transactionSizeBytes.toLocaleString()} |`,
    );
  }

  const instructionDelta = resultB.instructions - resultA.instructions;
  const readDelta = resultB.readBytes - resultA.readBytes;
  const writeDelta = resultB.writeBytes - resultA.writeBytes;
  console.log(`\nDesign B vs Design A: instructions ${instructionDelta >= 0 ? "+" : ""}${instructionDelta}, ` +
    `read bytes ${readDelta >= 0 ? "+" : ""}${readDelta}, write bytes ${writeDelta >= 0 ? "+" : ""}${writeDelta}`);
  console.log("\nNote: this benchmark's settle() call for Design A does not include a real signed witness or a");
  console.log("valid allowance for this specific fresh nonce/facilitator pairing, so its simulation may itself");
  console.log("report an auth or allowance failure inside `sim` diagnostics even though resource *footprint*");
  console.log("(reads/writes/instructions touched before the auth check short-circuits) is still comparable —");
  console.log("see the script output above for what actually ran on each side.");
}

main().catch(err => {
  console.error("\n❌ BENCHMARK FAIL:", err);
  process.exit(1);
});
