import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair, nativeToScVal } from "@stellar/stellar-sdk";
import { STELLAR_TESTNET_CAIP2, type FacilitatorStellarSigner } from "@x402/stellar";

const buildMock = vi.hoisted(() => vi.fn());
const getRpcClientMock = vi.hoisted(() => vi.fn());

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    contract: { ...actual.contract, AssembledTransaction: { build: buildMock } },
  };
});

vi.mock("@x402/stellar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@x402/stellar")>();
  return { ...actual, getRpcClient: getRpcClientMock };
});

const { ensureUptoAllowance } = await import("../src/allowance.js");

const TOKEN = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const SPENDER = "CDOMBVUSWUHDSS65VHKUDZ3IJTBUSMZILYULSYSNKCBE654YACKTN6EE";

function stubSigner(): FacilitatorStellarSigner {
  return {
    address: Keypair.random().publicKey(),
    signTransaction: vi.fn(),
    signAuthEntry: vi.fn(),
  } as unknown as FacilitatorStellarSigner;
}

/** Configures buildMock to answer both the `allowance` read and the `approve` write. */
function mockRpc(opts: {
  currentAllowance: bigint;
  latestLedgerSequence?: number;
  approveTxHash?: string;
}) {
  buildMock.mockImplementation(async (params: { method: string }) => {
    if (params.method === "allowance") {
      return {
        simulation: { result: { retval: nativeToScVal(opts.currentAllowance, { type: "i128" }) } },
      };
    }
    // "approve"
    return {
      signAndSend: vi.fn().mockResolvedValue({
        sendTransactionResponse: { hash: opts.approveTxHash ?? "approvetxhash" },
      }),
    };
  });
  getRpcClientMock.mockReturnValue({
    getLatestLedger: vi.fn().mockResolvedValue({ sequence: opts.latestLedgerSequence ?? 1000 }),
  });
}

afterEach(() => {
  buildMock.mockReset();
  getRpcClientMock.mockReset();
});

describe("ensureUptoAllowance", () => {
  it("does not submit an approval when the existing allowance already covers minAllowance", async () => {
    mockRpc({ currentAllowance: 1_000n });

    const result = await ensureUptoAllowance({
      signer: stubSigner(),
      token: TOKEN,
      spender: SPENDER,
      minAllowance: 500n,
      network: STELLAR_TESTNET_CAIP2,
    });

    expect(result).toEqual({ approved: false, allowance: 1_000n });
    expect(buildMock).toHaveBeenCalledTimes(1); // only the allowance read, no approve
  });

  it("submits an approval when the existing allowance is insufficient", async () => {
    mockRpc({ currentAllowance: 100n, approveTxHash: "abc123" });

    const result = await ensureUptoAllowance({
      signer: stubSigner(),
      token: TOKEN,
      spender: SPENDER,
      minAllowance: 500n,
      network: STELLAR_TESTNET_CAIP2,
    });

    expect(result).toEqual({ approved: true, allowance: 5_000n, transaction: "abc123" });
  });

  it("defaults approveAmount to 10x minAllowance when not specified", async () => {
    mockRpc({ currentAllowance: 0n });

    const result = await ensureUptoAllowance({
      signer: stubSigner(),
      token: TOKEN,
      spender: SPENDER,
      minAllowance: 42n,
      network: STELLAR_TESTNET_CAIP2,
    });

    expect(result.allowance).toBe(420n);
  });

  it("respects an explicit approveAmount override", async () => {
    mockRpc({ currentAllowance: 0n });

    const result = await ensureUptoAllowance({
      signer: stubSigner(),
      token: TOKEN,
      spender: SPENDER,
      minAllowance: 42n,
      approveAmount: 999n,
      network: STELLAR_TESTNET_CAIP2,
    });

    expect(result.allowance).toBe(999n);
  });

  it("computes liveUntilLedger from the current ledger plus the default lifetime", async () => {
    mockRpc({ currentAllowance: 0n, latestLedgerSequence: 5_000 });

    await ensureUptoAllowance({
      signer: stubSigner(),
      token: TOKEN,
      spender: SPENDER,
      minAllowance: 10n,
      network: STELLAR_TESTNET_CAIP2,
    });

    const approveCall = buildMock.mock.calls.find((c) => c[0].method === "approve");
    expect(approveCall).toBeDefined();
    const liveUntilArg = approveCall![0].args[3];
    // 5_000 + 17_280 * 30
    expect(liveUntilArg).toEqual(nativeToScVal(5_000 + 17_280 * 30, { type: "u32" }));
  });

  it("respects an explicit liveForLedgers override", async () => {
    mockRpc({ currentAllowance: 0n, latestLedgerSequence: 5_000 });

    await ensureUptoAllowance({
      signer: stubSigner(),
      token: TOKEN,
      spender: SPENDER,
      minAllowance: 10n,
      liveForLedgers: 100,
      network: STELLAR_TESTNET_CAIP2,
    });

    const approveCall = buildMock.mock.calls.find((c) => c[0].method === "approve");
    const liveUntilArg = approveCall![0].args[3];
    expect(liveUntilArg).toEqual(nativeToScVal(5_100, { type: "u32" }));
  });

  it("throws when the allowance read comes back with no simulation result", async () => {
    buildMock.mockResolvedValue({ simulation: undefined });
    getRpcClientMock.mockReturnValue({ getLatestLedger: vi.fn() });

    await expect(
      ensureUptoAllowance({
        signer: stubSigner(),
        token: TOKEN,
        spender: SPENDER,
        minAllowance: 10n,
        network: STELLAR_TESTNET_CAIP2,
      }),
    ).rejects.toThrow(/allowance read failed/);
  });
});
