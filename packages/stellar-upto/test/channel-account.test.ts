import { describe, expect, it } from "vitest";
import { Account, Keypair, TransactionBuilder, xdr, BASE_FEE } from "@stellar/stellar-sdk";
import { STELLAR_TESTNET_CAIP2, getNetworkPassphrase } from "@x402/stellar";
import { buildSettleOperation, UptoStellarScheme } from "../src/facilitator/scheme.js";
import type { UptoWitnessCommitment } from "../src/types.js";
import { buildEntry, randomContractAddress } from "./helpers.js";

const SETTLEMENT_CONTRACT = randomContractAddress();
const TOKEN = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const NETWORK_PASSPHRASE = getNetworkPassphrase(STELLAR_TESTNET_CAIP2);

function sampleCommitment(): UptoWitnessCommitment {
  return {
    from: Keypair.random().publicKey(),
    payTo: Keypair.random().publicKey(),
    facilitator: Keypair.random().publicKey(),
    token: TOKEN,
    maxAmount: 1_000_000n,
    requestNonce: 1n,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
  };
}

describe("buildSettleOperation: operation source binding (channel-account safety)", () => {
  // The whole point of channel accounts is that the *transaction's* source
  // account can be anything (a channel account, paying only fee/sequence),
  // while `facilitator.require_auth()` on-chain must still resolve to
  // `commitment.facilitator` specifically — which only holds if the
  // *operation's* own source is explicitly bound to it, independent of
  // whatever ends up being the transaction's source. This test builds a full
  // transaction with a source account that is deliberately NOT the
  // facilitator, round-trips it through XDR (matching what actually happens
  // over the wire), and asserts the operation still carries the facilitator
  // as its own source.
  it("binds the operation's source to commitment.facilitator, independent of the transaction's source account", () => {
    const commitment = sampleCommitment();
    const entry = buildEntry(commitment, SETTLEMENT_CONTRACT);
    const op = buildSettleOperation(SETTLEMENT_CONTRACT, commitment, 500_000n, entry);

    const unrelatedChannelAccountAddress = Keypair.random().publicKey();
    const channelAccount = new Account(unrelatedChannelAccountAddress, "100");

    const tx = new TransactionBuilder(channelAccount, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .setTimeout(60)
      .addOperation(op)
      .build();

    // Round-trip through XDR, exactly like what's actually submitted to RPC.
    const rebuilt = TransactionBuilder.fromXDR(tx.toXDR(), NETWORK_PASSPHRASE);
    expect("operations" in rebuilt).toBe(true);
    const rebuiltOps = (rebuilt as { operations: { type: string; source?: string }[] }).operations;
    expect(rebuiltOps).toHaveLength(1);
    expect(rebuiltOps[0].source).toBe(commitment.facilitator);
    expect(rebuiltOps[0].source).not.toBe(unrelatedChannelAccountAddress);

    // The transaction's own source account is untouched — still the channel account.
    expect(tx.source).toBe(unrelatedChannelAccountAddress);
  });

  it("carries both the client witness and the facilitator source-account auth entry", () => {
    const commitment = sampleCommitment();
    const entry = buildEntry(commitment, SETTLEMENT_CONTRACT);
    const op = buildSettleOperation(SETTLEMENT_CONTRACT, commitment, 500_000n, entry);

    expect(op.body().switch().name).toBe("invokeHostFunction");
    const auth = op.body().invokeHostFunctionOp().auth();
    expect(auth).toHaveLength(2);
    expect(auth[1].credentials().switch().name).toBe("sorobanCredentialsSourceAccount");
  });
});

describe("UptoStellarScheme: channel account configuration", () => {
  const settlementContracts = { [STELLAR_TESTNET_CAIP2]: SETTLEMENT_CONTRACT };
  function stubSigner(): { address: string; signAuthEntry: () => never; signTransaction: () => never } {
    return {
      address: Keypair.random().publicKey(),
      signAuthEntry: () => {
        throw new Error("not used in this test");
      },
      signTransaction: () => {
        throw new Error("not used in this test");
      },
    };
  }

  it("accepts construction with no channel accounts configured (backward compatible)", () => {
    expect(() => new UptoStellarScheme([stubSigner()], settlementContracts)).not.toThrow();
  });

  it("accepts construction with a channel account pool configured", () => {
    const scheme = new UptoStellarScheme([stubSigner()], settlementContracts, {
      channelAccounts: [stubSigner(), stubSigner(), stubSigner()],
    });
    expect(scheme).toBeInstanceOf(UptoStellarScheme);
  });

  it("keeps channel account addresses out of the protocol-facing signer set", () => {
    // Channel accounts are a transaction-submission implementation detail —
    // they must never be advertised as a `facilitatorAddress` a client could
    // sign a witness against (they don't hold the identity
    // `facilitator.require_auth()` checks, only `signers` does), and must
    // never appear in `getSigners()`, which resource servers/clients use to
    // recognize valid facilitator identities.
    const signer = stubSigner();
    const channelAccounts = [stubSigner(), stubSigner()];
    const scheme = new UptoStellarScheme([signer], settlementContracts, { channelAccounts });

    expect(scheme.signingAddresses.has(signer.address)).toBe(true);
    for (const channelAccount of channelAccounts) {
      expect(scheme.signingAddresses.has(channelAccount.address)).toBe(false);
      expect(scheme.getSigners(STELLAR_TESTNET_CAIP2)).not.toContain(channelAccount.address);
    }
  });
});
