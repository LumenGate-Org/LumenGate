import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair, nativeToScVal } from "@stellar/stellar-sdk";
import { STELLAR_TESTNET_CAIP2, type FacilitatorStellarSigner } from "@x402/stellar";

const buildMock = vi.hoisted(() => vi.fn());

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    contract: { ...actual.contract, AssembledTransaction: { build: buildMock } },
  };
});

const { cancelUptoPayment } = await import("../src/cancel.js");

const SETTLEMENT_CONTRACT = "CDOMBVUSWUHDSS65VHKUDZ3IJTBUSMZILYULSYSNKCBE654YACKTN6EE";

function stubSigner(): FacilitatorStellarSigner {
  return {
    address: Keypair.random().publicKey(),
    signTransaction: vi.fn(),
    signAuthEntry: vi.fn(),
  } as unknown as FacilitatorStellarSigner;
}

afterEach(() => {
  buildMock.mockReset();
});

describe("cancelUptoPayment", () => {
  it("submits a cancel transaction and returns its hash", async () => {
    buildMock.mockResolvedValue({
      signAndSend: vi.fn().mockResolvedValue({
        sendTransactionResponse: { hash: "cancelhash123" },
      }),
    });

    const result = await cancelUptoPayment({
      signer: stubSigner(),
      settlementContract: SETTLEMENT_CONTRACT,
      requestNonce: 17_423_900_461_829_181_234n,
      network: STELLAR_TESTNET_CAIP2,
    });

    expect(result).toEqual({ transaction: "cancelhash123" });
  });

  it("builds the cancel invocation with method 'cancel' and the correct requestNonce arg", async () => {
    buildMock.mockResolvedValue({
      signAndSend: vi.fn().mockResolvedValue({
        sendTransactionResponse: { hash: "cancelhash123" },
      }),
    });

    await cancelUptoPayment({
      signer: stubSigner(),
      settlementContract: SETTLEMENT_CONTRACT,
      requestNonce: 42n,
      network: STELLAR_TESTNET_CAIP2,
    });

    expect(buildMock).toHaveBeenCalledTimes(1);
    const call = buildMock.mock.calls[0][0];
    expect(call.method).toBe("cancel");
    expect(call.contractId).toBe(SETTLEMENT_CONTRACT);
    expect(call.args[1]).toEqual(nativeToScVal(42n, { type: "u64" }));
  });

  it("throws when the transaction doesn't return a hash", async () => {
    buildMock.mockResolvedValue({
      signAndSend: vi.fn().mockResolvedValue({ sendTransactionResponse: undefined }),
    });

    await expect(
      cancelUptoPayment({
        signer: stubSigner(),
        settlementContract: SETTLEMENT_CONTRACT,
        requestNonce: 1n,
        network: STELLAR_TESTNET_CAIP2,
      }),
    ).rejects.toThrow(/did not return a hash/);
  });
});
