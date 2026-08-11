import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { STELLAR_TESTNET_CAIP2, type ClientStellarSigner } from "@x402/stellar";
import type { PaymentRequirements } from "@x402/core/types";
import { UptoStellarScheme as UptoStellarClient } from "../src/client/scheme.js";

/**
 * `validateInput` runs before any network call, so a rejection is
 * synchronous-ish (the returned promise rejects immediately) and doesn't
 * need a live RPC target — see `createPaymentPayload` in `client/scheme.ts`.
 */

const TOKEN = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

function stubSigner(): ClientStellarSigner {
  return {
    address: Keypair.random().publicKey(),
    signAuthEntry: async () => {
      throw new Error("not expected to sign in an input-validation test");
    },
  };
}

function baseRequirements(amount: string): PaymentRequirements {
  return {
    scheme: "upto",
    network: STELLAR_TESTNET_CAIP2,
    asset: TOKEN,
    amount,
    payTo: Keypair.random().publicKey(),
    maxTimeoutSeconds: 300,
    extra: {
      settlementContract: Keypair.random().publicKey().replace(/^G/, "C"),
      facilitatorAddress: Keypair.random().publicKey(),
      feeBps: 0,
    },
  };
}

describe("UptoStellarScheme (client): amount validation", () => {
  const client = new UptoStellarClient(stubSigner());

  it("rejects exponential notation cleanly rather than throwing a BigInt SyntaxError later", async () => {
    // Number("1e3") === 1000, which passed the old Number.isInteger check —
    // but BigInt("1e3") throws. This must reject with the validation
    // Error, not an uncaught SyntaxError.
    await expect(client.createPaymentPayload(2, baseRequirements("1e3"))).rejects.toThrow(
      /Invalid amount/,
    );
  });

  it("rejects a decimal amount", async () => {
    await expect(client.createPaymentPayload(2, baseRequirements("10.5"))).rejects.toThrow(
      /Invalid amount/,
    );
  });

  it("rejects a negative amount", async () => {
    await expect(client.createPaymentPayload(2, baseRequirements("-10"))).rejects.toThrow(
      /Invalid amount/,
    );
  });

  it("rejects zero", async () => {
    await expect(client.createPaymentPayload(2, baseRequirements("0"))).rejects.toThrow(
      /Invalid amount/,
    );
  });

  it("rejects non-digit garbage", async () => {
    await expect(client.createPaymentPayload(2, baseRequirements("abc"))).rejects.toThrow(
      /Invalid amount/,
    );
  });
});

describe("UptoStellarScheme (client): extra.facilitatorAddress validation", () => {
  const client = new UptoStellarClient(stubSigner());

  it("rejects a missing facilitatorAddress", async () => {
    const requirements = baseRequirements("1000");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (requirements.extra as any).facilitatorAddress;
    await expect(client.createPaymentPayload(2, requirements)).rejects.toThrow(
      /Invalid or missing extra.facilitatorAddress/,
    );
  });

  it("rejects a malformed facilitatorAddress instead of failing later during Soroban arg construction", async () => {
    const requirements = baseRequirements("1000");
    requirements.extra = { ...(requirements.extra as object), facilitatorAddress: "not-a-stellar-address" };
    await expect(client.createPaymentPayload(2, requirements)).rejects.toThrow(
      /Invalid or missing extra.facilitatorAddress/,
    );
  });
});
