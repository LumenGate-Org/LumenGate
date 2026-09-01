import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { STELLAR_TESTNET_CAIP2 } from "@x402/stellar";
import type { PaymentRequirements, SupportedKind } from "@x402/core/types";
import { UptoStellarScheme } from "../src/server/scheme.js";
import { UptoFeeMode } from "../src/types.js";
import { MAX_FEE_BPS } from "../src/constants.js";

function baseRequirements(): PaymentRequirements {
  return {
    scheme: "upto",
    network: STELLAR_TESTNET_CAIP2,
    asset: Keypair.random().publicKey().replace(/^G/, "C"),
    amount: "10000000",
    payTo: Keypair.random().publicKey(),
    maxTimeoutSeconds: 300,
    extra: { existingField: "preserved" },
  };
}

function supportedKind(extra?: Record<string, unknown>): SupportedKind {
  return {
    x402Version: 2,
    scheme: "upto",
    network: STELLAR_TESTNET_CAIP2,
    extra,
  };
}

describe("UptoStellarScheme (server): constructor validation", () => {
  it("defaults to feeBps 0, feeFixed 0n, feeMode Percentage", async () => {
    const scheme = new UptoStellarScheme();
    const result = await scheme.enhancePaymentRequirements(
      baseRequirements(),
      supportedKind({
        settlementContract: "C" + "A".repeat(55),
        facilitatorAddress: Keypair.random().publicKey(),
      }),
      [],
    );
    expect(result.extra).toMatchObject({
      feeBps: 0,
      feeFixed: "0",
      feeMode: UptoFeeMode.Percentage,
    });
  });

  it("rejects a negative feeBps", () => {
    expect(() => new UptoStellarScheme({ feeBps: -1 })).toThrow(/feeBps must be between/);
  });

  it("rejects a feeBps above MAX_FEE_BPS", () => {
    expect(() => new UptoStellarScheme({ feeBps: MAX_FEE_BPS + 1 })).toThrow(
      /feeBps must be between/,
    );
  });

  it("accepts feeBps exactly at MAX_FEE_BPS (boundary)", () => {
    expect(() => new UptoStellarScheme({ feeBps: MAX_FEE_BPS })).not.toThrow();
  });

  it("accepts feeBps exactly at 0 (boundary)", () => {
    expect(() => new UptoStellarScheme({ feeBps: 0 })).not.toThrow();
  });

  it("rejects a negative feeFixed", () => {
    expect(() => new UptoStellarScheme({ feeFixed: -1n })).toThrow(/feeFixed must be non-negative/);
  });

  it("accepts feeFixed of exactly 0n", () => {
    expect(() => new UptoStellarScheme({ feeFixed: 0n })).not.toThrow();
  });

  it("stores a non-default feeMode", async () => {
    const scheme = new UptoStellarScheme({ feeMode: UptoFeeMode.CombinedMax, feeBps: 100, feeFixed: 50n });
    const result = await scheme.enhancePaymentRequirements(
      baseRequirements(),
      supportedKind({
        settlementContract: "C" + "A".repeat(55),
        facilitatorAddress: Keypair.random().publicKey(),
      }),
      [],
    );
    expect(result.extra).toMatchObject({
      feeBps: 100,
      feeFixed: "50",
      feeMode: UptoFeeMode.CombinedMax,
    });
  });
});

describe("UptoStellarScheme (server): registerMoneyParser", () => {
  it("returns the same instance, for chaining", () => {
    const scheme = new UptoStellarScheme();
    expect(scheme.registerMoneyParser(async () => null)).toBe(scheme);
  });
});

describe("UptoStellarScheme (server): parsePrice", () => {
  it("passes an AssetAmount object through unchanged when it has an asset", async () => {
    const scheme = new UptoStellarScheme();
    const asset = Keypair.random().publicKey().replace(/^G/, "C");
    const result = await scheme.parsePrice({ amount: "500", asset }, STELLAR_TESTNET_CAIP2);
    expect(result).toEqual({ amount: "500", asset, extra: {} });
  });

  it("rejects an AssetAmount object with no asset", async () => {
    const scheme = new UptoStellarScheme();
    await expect(
      scheme.parsePrice({ amount: "500", asset: "" }, STELLAR_TESTNET_CAIP2),
    ).rejects.toThrow(/Asset address must be specified/);
  });

  it("tries registered money parsers in order before falling back to USDC", async () => {
    const scheme = new UptoStellarScheme();
    const calls: number[] = [];
    scheme.registerMoneyParser(async () => {
      calls.push(1);
      return null;
    });
    const asset = Keypair.random().publicKey().replace(/^G/, "C");
    scheme.registerMoneyParser(async () => {
      calls.push(2);
      return { amount: "999", asset, extra: {} };
    });

    const result = await scheme.parsePrice("$1.00", STELLAR_TESTNET_CAIP2);
    expect(calls).toEqual([1, 2]);
    expect(result).toEqual({ amount: "999", asset, extra: {} });
  });

  it("falls back to USDC conversion when no parser claims the price", async () => {
    const scheme = new UptoStellarScheme();
    const result = await scheme.parsePrice(1, STELLAR_TESTNET_CAIP2);
    expect(typeof result.amount).toBe("string");
    expect(result.asset).toBeTruthy();
  });
});

describe("UptoStellarScheme (server): enhancePaymentRequirements", () => {
  it("throws when the facilitator didn't advertise settlementContract", () => {
    const scheme = new UptoStellarScheme();
    expect(() =>
      scheme.enhancePaymentRequirements(
        baseRequirements(),
        supportedKind({ facilitatorAddress: Keypair.random().publicKey() }),
        [],
      ),
    ).toThrow(/did not advertise settlementContract/);
  });

  it("throws when the facilitator didn't advertise facilitatorAddress", () => {
    const scheme = new UptoStellarScheme();
    expect(() =>
      scheme.enhancePaymentRequirements(
        baseRequirements(),
        supportedKind({ settlementContract: "C" + "A".repeat(55) }),
        [],
      ),
    ).toThrow(/did not advertise settlementContract/);
  });

  it("throws when supportedKind.extra is entirely absent", () => {
    const scheme = new UptoStellarScheme();
    expect(() =>
      scheme.enhancePaymentRequirements(baseRequirements(), supportedKind(undefined), []),
    ).toThrow(/did not advertise settlementContract/);
  });

  it("preserves pre-existing extra fields while merging in the new ones", async () => {
    const scheme = new UptoStellarScheme({ feeBps: 250 });
    const result = await scheme.enhancePaymentRequirements(
      baseRequirements(),
      supportedKind({
        settlementContract: "C" + "A".repeat(55),
        facilitatorAddress: Keypair.random().publicKey(),
      }),
      [],
    );
    expect(result.extra).toMatchObject({ existingField: "preserved", feeBps: 250 });
  });

  it("defaults areFeesSponsored to true when the facilitator doesn't say", async () => {
    const scheme = new UptoStellarScheme();
    const result = await scheme.enhancePaymentRequirements(
      baseRequirements(),
      supportedKind({
        settlementContract: "C" + "A".repeat(55),
        facilitatorAddress: Keypair.random().publicKey(),
      }),
      [],
    );
    expect(result.extra?.areFeesSponsored).toBe(true);
  });

  it("preserves an explicit areFeesSponsored: false rather than defaulting it to true", async () => {
    const scheme = new UptoStellarScheme();
    const result = await scheme.enhancePaymentRequirements(
      baseRequirements(),
      supportedKind({
        settlementContract: "C" + "A".repeat(55),
        facilitatorAddress: Keypair.random().publicKey(),
        areFeesSponsored: false,
      }),
      [],
    );
    expect(result.extra?.areFeesSponsored).toBe(false);
  });
});

describe("UptoStellarScheme (server): validateFacilitatorSupport", () => {
  it("skips validation entirely for non-Percentage fee modes", () => {
    const scheme = new UptoStellarScheme({ feeMode: UptoFeeMode.Fixed, feeBps: 0, feeFixed: 999999n });
    const result = scheme.validateFacilitatorSupport(
      STELLAR_TESTNET_CAIP2,
      supportedKind({ maxFeeBps: 10 }),
      [],
    );
    expect(result).toBeUndefined();
  });

  it("passes when the facilitator advertises no maxFeeBps cap", () => {
    const scheme = new UptoStellarScheme({ feeBps: 1500 });
    const result = scheme.validateFacilitatorSupport(STELLAR_TESTNET_CAIP2, supportedKind({}), []);
    expect(result).toBeUndefined();
  });

  it("passes when configured feeBps is within the facilitator's advertised maxFeeBps", () => {
    const scheme = new UptoStellarScheme({ feeBps: 500 });
    const result = scheme.validateFacilitatorSupport(
      STELLAR_TESTNET_CAIP2,
      supportedKind({ maxFeeBps: 1000 }),
      [],
    );
    expect(result).toBeUndefined();
  });

  it("returns an error string when configured feeBps exceeds the facilitator's advertised maxFeeBps", () => {
    const scheme = new UptoStellarScheme({ feeBps: 1500 });
    const result = scheme.validateFacilitatorSupport(
      STELLAR_TESTNET_CAIP2,
      supportedKind({ maxFeeBps: 1000 }),
      [],
    );
    expect(result).toMatch(/exceeds facilitator's advertised maxFeeBps/);
  });

  it("passes at the exact boundary (feeBps === maxFeeBps)", () => {
    const scheme = new UptoStellarScheme({ feeBps: 1000 });
    const result = scheme.validateFacilitatorSupport(
      STELLAR_TESTNET_CAIP2,
      supportedKind({ maxFeeBps: 1000 }),
      [],
    );
    expect(result).toBeUndefined();
  });
});
