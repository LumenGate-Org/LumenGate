import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { STELLAR_TESTNET_CAIP2, type FacilitatorStellarSigner } from "@x402/stellar";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { computeSettlementCacheKey, UptoStellarScheme } from "../src/facilitator/scheme.js";
import type { UptoWitnessCommitment } from "../src/types.js";
import { buildEntry, randomContractAddress } from "./helpers.js";

const SETTLEMENT_CONTRACT = randomContractAddress();
const TOKEN = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

function samplePayload(): { payload: PaymentPayload; requirements: PaymentRequirements } {
  const commitment: UptoWitnessCommitment = {
    from: Keypair.random().publicKey(),
    payTo: Keypair.random().publicKey(),
    facilitator: Keypair.random().publicKey(),
    token: TOKEN,
    maxAmount: 1_000_000n,
    requestNonce: 1n,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
    feeBps: 0,
  };
  const entry = buildEntry(commitment, SETTLEMENT_CONTRACT);
  const requirements: PaymentRequirements = {
    scheme: "upto",
    network: STELLAR_TESTNET_CAIP2,
    asset: commitment.token,
    amount: "0", // zero-amount settlement: still a real on-chain submission (see scheme.ts)
    payTo: commitment.payTo,
    maxTimeoutSeconds: 300,
    extra: {
      settlementContract: SETTLEMENT_CONTRACT,
      facilitatorAddress: commitment.facilitator,
      feeBps: 0,
      areFeesSponsored: true,
    },
  };
  const payload: PaymentPayload = {
    x402Version: 2,
    resource: { url: "https://example.com/paid" },
    accepted: { ...requirements, amount: commitment.maxAmount.toString() },
    payload: {
      authEntry: entry.toXDR("base64"),
      requestNonce: commitment.requestNonce.toString(),
      deadline: commitment.deadline.toString(),
    },
  };
  return { payload, requirements };
}

function stubSigner(address: string): FacilitatorStellarSigner {
  return {
    address,
    signAuthEntry: async () => {
      throw new Error("not expected to sign in this test");
    },
    signTransaction: async () => {
      throw new Error("not expected to sign in this test");
    },
  };
}

describe("computeSettlementCacheKey", () => {
  it("is stable for the same witness and amount", () => {
    const { payload, requirements } = samplePayload();
    expect(computeSettlementCacheKey(payload, requirements)).toEqual(
      computeSettlementCacheKey(payload, requirements),
    );
  });

  it("differs when the settlement amount differs", () => {
    const { payload, requirements } = samplePayload();
    const key1 = computeSettlementCacheKey(payload, requirements);
    const key2 = computeSettlementCacheKey(payload, { ...requirements, amount: "500" });
    expect(key1).not.toEqual(key2);
  });

  it("differs for a different witness", () => {
    const a = samplePayload();
    const b = samplePayload();
    expect(computeSettlementCacheKey(a.payload, a.requirements)).not.toEqual(
      computeSettlementCacheKey(b.payload, b.requirements),
    );
  });

  it("returns undefined when the payload carries no witness", () => {
    const { payload, requirements } = samplePayload();
    const malformed = { ...payload, payload: {} };
    expect(computeSettlementCacheKey(malformed, requirements)).toBeUndefined();
  });

  // The cache key used to be `authEntry:amount` only, so a replay carrying
  // the same witness+amount but a mutated `payload.accepted` collided with
  // a prior real settlement's cache entry — returning cached success
  // without ever re-validating `accepted`, which then flowed straight into
  // Bazaar cataloging. See e2e/conformance/CONFORMANCE_REPORT.md,
  // "idempotency cache bypasses validation."
  it("differs when payload.accepted is mutated, even with the same witness and amount", () => {
    const { payload, requirements } = samplePayload();
    const mutated: PaymentPayload = {
      ...payload,
      accepted: { ...payload.accepted, payTo: Keypair.random().publicKey() },
    };
    expect(computeSettlementCacheKey(payload, requirements)).not.toEqual(
      computeSettlementCacheKey(mutated, requirements),
    );
  });

  it("differs when requirements.payTo is mutated, even with the same witness and amount", () => {
    const { payload, requirements } = samplePayload();
    expect(computeSettlementCacheKey(payload, requirements)).not.toEqual(
      computeSettlementCacheKey(payload, { ...requirements, payTo: Keypair.random().publicKey() }),
    );
  });
});

describe("UptoStellarScheme.settle(): idempotency", () => {
  it("short-circuits on a cache hit without calling the underlying settlement logic at all", async () => {
    // A real success response can only be produced by reaching the network
    // (settlement — including the zero-amount case — always submits a real
    // on-chain transaction; there's no RPC-free path) — so this seeds the
    // cache directly to isolate exactly the property under test:
    // a cache hit returns the cached value and never touches
    // `settleUnguarded` at all, regardless of what that would have done.
    // The cache actually getting populated by a real successful settlement
    // is exercised live in e2e/conformance.
    const { payload, requirements } = samplePayload();
    const extra = requirements.extra as { facilitatorAddress: string };
    const facilitator = new UptoStellarScheme([stubSigner(extra.facilitatorAddress)], {
      [STELLAR_TESTNET_CAIP2]: SETTLEMENT_CONTRACT,
    });

    const cacheKey = computeSettlementCacheKey(payload, requirements)!;
    const seeded = {
      success: true as const,
      transaction: "seeded-tx-hash",
      network: STELLAR_TESTNET_CAIP2,
      payer: "seeded-payer",
      amount: "0",
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (facilitator as any).settlementCache.set(cacheKey, seeded);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spy = vi.spyOn(facilitator as any, "settleUnguarded");

    const result = await facilitator.settle(payload, requirements);

    expect(result).toEqual(seeded);
    expect(spy).not.toHaveBeenCalled();
  });

  it("a replay with a mutated payload.accepted does not hit a cache seeded under the original — closes the discovery-poisoning replay", async () => {
    const { payload, requirements } = samplePayload();
    const extra = requirements.extra as { facilitatorAddress: string };
    const facilitator = new UptoStellarScheme([stubSigner(extra.facilitatorAddress)], {
      [STELLAR_TESTNET_CAIP2]: SETTLEMENT_CONTRACT,
    });

    const originalCacheKey = computeSettlementCacheKey(payload, requirements)!;
    const seeded = {
      success: true as const,
      transaction: "seeded-tx-hash",
      network: STELLAR_TESTNET_CAIP2,
      payer: "seeded-payer",
      amount: "0",
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (facilitator as any).settlementCache.set(originalCacheKey, seeded);

    // Same witness, same settle amount — but a different advertised payTo,
    // exactly what a malicious direct /settle caller would try in order to
    // ride the real settlement's cached success into cataloging a
    // fabricated payTo.
    const mutatedPayload: PaymentPayload = {
      ...payload,
      accepted: { ...payload.accepted, payTo: Keypair.random().publicKey() },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spy = vi.spyOn(facilitator as any, "settleUnguarded");
    const result = await facilitator.settle(mutatedPayload, requirements);

    // Must NOT silently return the seeded cached success for the mutated
    // request — the cache key now differs, so it must fall through to a
    // real (fresh) settlement attempt instead.
    expect(result).not.toEqual(seeded);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed settlement — a retry genuinely retries", async () => {
    const { payload, requirements } = samplePayload();
    // A facilitator that doesn't recognize the witness's facilitator address
    // fails during verification, before ever reaching settlement — a
    // representative "real" failure.
    const facilitator = new UptoStellarScheme([stubSigner(Keypair.random().publicKey())], {
      [STELLAR_TESTNET_CAIP2]: SETTLEMENT_CONTRACT,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spy = vi.spyOn(facilitator as any, "settleUnguarded");

    const first = await facilitator.settle(payload, requirements);
    const second = await facilitator.settle(payload, requirements);

    expect(first.success).toBe(false);
    expect(second.success).toBe(false);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
