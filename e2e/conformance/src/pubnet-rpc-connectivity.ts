/**
 * Live, read-only proof that the facilitator's pubnet wiring
 * (`STELLAR_PUBNET_RPC_URL`, see `packages/facilitator/src/server.ts`)
 * actually reaches real Stellar mainnet infrastructure — not just that the
 * code typechecks.
 *
 * Deliberately does NOT submit any transaction or require a funded mainnet
 * account: this project's pubnet posture is "wired and verified reachable,
 * not exercised with real settlement funds" (see
 * `e2e/conformance/CONFORMANCE_REPORT.md`). `getHealth`/`getNetwork` are
 * account-free RPC methods, so this proves genuine mainnet RPC connectivity
 * without spending anything.
 */
import { rpc, Networks } from "@stellar/stellar-sdk";
import { getUsdcAddress, STELLAR_PUBNET_CAIP2 } from "@x402/stellar";

const RPC_URL = process.env.STELLAR_PUBNET_RPC_URL ?? "https://mainnet.sorobanrpc.com";

async function main(): Promise<void> {
  console.log(`1. Connecting to Stellar pubnet RPC: ${RPC_URL}`);
  const server = new rpc.Server(RPC_URL);

  const health = await server.getHealth();
  console.log(`   getHealth(): ${health.status}`);
  if (health.status !== "healthy") {
    throw new Error(`RPC reported unhealthy status: ${health.status}`);
  }

  const network = await server.getNetwork();
  console.log(`   getNetwork(): passphrase="${network.passphrase}", protocolVersion=${network.protocolVersion}`);
  if (network.passphrase !== Networks.PUBLIC) {
    throw new Error(
      `Expected the Public Global Stellar Network passphrase, got "${network.passphrase}" — ` +
        `this RPC endpoint is not actually mainnet.`,
    );
  }
  if (network.friendbotUrl) {
    throw new Error(
      `Mainnet has no friendbot, but this endpoint advertised one (${network.friendbotUrl}) — ` +
        `suspicious, likely misconfigured to point at testnet.`,
    );
  }

  const latestLedger = await server.getLatestLedger();
  console.log(`   getLatestLedger(): sequence=${latestLedger.sequence}`);

  console.log("\n2. Confirming the canonical mainnet USDC contract address is well-formed...");
  const usdcAddress = getUsdcAddress(STELLAR_PUBNET_CAIP2);
  console.log(`   getUsdcAddress(stellar:pubnet) = ${usdcAddress}`);
  if (!/^C[A-Z0-9]{55}$/.test(usdcAddress)) {
    throw new Error(`Unexpected USDC contract address shape: ${usdcAddress}`);
  }

  console.log("\n✅ PUBNET RPC CONNECTIVITY CONFIRMED");
  console.log("   Real, live Stellar mainnet RPC — healthy, correct network passphrase, current ledger.");
  console.log("   No transaction submitted and no funded account required for this check (by design —");
  console.log("   see the module docstring for why live settlement on pubnet is out of scope here).");
}

main().catch(err => {
  console.error("\n❌ PUBNET RPC CONNECTIVITY CHECK FAILED:", err);
  process.exit(1);
});
