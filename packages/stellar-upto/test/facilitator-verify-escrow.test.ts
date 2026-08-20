import { describe, expect, it } from "vitest";
import { Keypair, nativeToScVal } from "@stellar/stellar-sdk";
import { STELLAR_TESTNET_CAIP2, type FacilitatorStellarSigner } from "@x402/stellar";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { UptoStellarEscrowScheme } from "../src/facilitator/scheme-escrow.js";
import type { UptoWitnessCommitment } from "../src/types.js";
import { buildEscrowEntry, randomContractAddress } from "./helpers.js";

/**
 * Covers `UptoStellarEscrowScheme` (Design B, facilitator)'s pre-RPC
 * validation logic. Deliberately mirrors `facilitator-verify.test.ts`
 * (`UptoStellarScheme`, Design A) test-for-test: both classes share the same
 * decoded-witness validation chain (see `scheme-escrow.ts`'s module
 * docstring), so the same adversarial inputs must be rejected the same way
 * by both. The one behavioral difference between the two designs — an
 * allowance pre-flight (Design A) vs. a balance pre-flight (Design B) — sits
 * *after* every check this file exercises and requires a real RPC call, so
 * it's out of scope here for the same reason it's out of scope in Design A's
 * file.
 */

const SETTLEMENT_CONTRACT = randomContractAddress();
const TOKEN = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

function stubSigner(address: string): FacilitatorStellarSigner {
  return {
    address,
    signAuthEntry: async () => {
      throw new Error("not expected to sign in a pre-RPC rejection test");
    },
    signTransaction: async () => {
      throw new Error("not expected to sign in a pre-RPC rejection test");
    },
  };
}

function makeFacilitator(facilitatorAddress: string): UptoStellarEscrowScheme {
  return new UptoStellarEscrowScheme([stubSigner(facilitatorAddress)], {
    [STELLAR_TESTNET_CAIP2]: SETTLEMENT_CONTRACT,
  });
}

function sampleCommitment(overrides: Partial<UptoWitnessCommitment> = {}): UptoWitnessCommitment {
  return {
    from: Keypair.random().publicKey(),
    payTo: Keypair.random().publicKey(),
    facilitator: Keypair.random().publicKey(),
    token: TOKEN,
    maxAmount: 1_000_000n,
    requestNonce: 42n,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
    feeBps: 0,
    feeFixed: 0n,
    feeMode: 0,
    ...overrides,
  };
}

function buildPayload(
  commitment: UptoWitnessCommitment,
  overrides: {
    requestNonce?: string;
    deadline?: string;
    authEntry?: string;
  } = {},
): PaymentPayload {
  const entry = buildEscrowEntry(commitment, SETTLEMENT_CONTRACT);
  const requirements = buildRequirements(commitment);
  return {
    x402Version: 2,
    resource: { url: "https://example.com/paid" },
    accepted: requirements,
    payload: {
      authEntry: overrides.authEntry ?? entry.toXDR("base64"),
      requestNonce: overrides.requestNonce ?? commitment.requestNonce.toString(),
      deadline: overrides.deadline ?? commitment.deadline.toString(),
    },
  };
}

function buildRequirements(
  commitment: UptoWitnessCommitment,
  extraOverrides: Record<string, unknown> = {},
): PaymentRequirements {
  return {
    scheme: "upto",
    network: STELLAR_TESTNET_CAIP2,
    asset: commitment.token,
    amount: commitment.maxAmount.toString(),
    payTo: commitment.payTo,
    maxTimeoutSeconds: 300,
    extra: {
      settlementContract: SETTLEMENT_CONTRACT,
      facilitatorAddress: commitment.facilitator,
      feeBps: commitment.feeBps,
      areFeesSponsored: true,
      ...extraOverrides,
    },
  };
}

describe("UptoStellarEscrowScheme facilitator (Design B): pre-RPC rejection paths", () => {
  it("rejects an unsupported x402Version", async () => {
    const commitment = sampleCommitment();
    const facilitator = makeFacilitator(commitment.facilitator);
    const payload = { ...buildPayload(commitment), x402Version: 1 };
    const result = await facilitator.verify(payload, buildRequirements(commitment));
    expect(result).toMatchObject({ isValid: false, invalidReason: "invalid_x402_version" });
  });

  it("rejects a non-upto scheme", async () => {
    const commitment = sampleCommitment();
    const facilitator = makeFacilitator(commitment.facilitator);
    const payload = buildPayload(commitment);
    payload.accepted = { ...payload.accepted, scheme: "exact" };
    const result = await facilitator.verify(payload, buildRequirements(commitment));
    expect(result).toMatchObject({ isValid: false, invalidReason: "unsupported_scheme" });
  });

  it("rejects when no settlement contract is configured for the network", async () => {
    const commitment = sampleCommitment();
    const facilitator = new UptoStellarEscrowScheme([stubSigner(commitment.facilitator)], {
      "stellar:pubnet": SETTLEMENT_CONTRACT,
    });
    const payload = buildPayload(commitment);
    const result = await facilitator.verify(payload, buildRequirements(commitment));
    expect(result).toMatchObject({
      isValid: false,
      invalidReason: "upto_stellar_network_not_configured",
    });
  });

  it("rejects a non-numeric requirements.amount without throwing (crash-safety)", async () => {
    const commitment = sampleCommitment();
    const facilitator = makeFacilitator(commitment.facilitator);
    const payload = buildPayload(commitment);
    const requirements = { ...buildRequirements(commitment), amount: "not-a-number" };
    await expect(facilitator.verify(payload, requirements)).resolves.toMatchObject({
      isValid: false,
      invalidReason: "invalid_upto_stellar_payload_malformed_amount",
    });
  });

  it("rejects a feeBps that exceeds the on-chain ceiling (same MAX_FEE_BPS as Design A)", async () => {
    const commitment = sampleCommitment({ feeBps: 2_500 });
    const facilitator = makeFacilitator(commitment.facilitator);
    const payload = buildPayload(commitment);
    const requirements = buildRequirements(commitment);
    const result = await facilitator.verify(payload, requirements);
    expect(result).toMatchObject({
      isValid: false,
      invalidReason: "invalid_upto_stellar_fee_exceeds_maximum",
    });
  });

  it("rejects a facilitator address the facilitator instance doesn't recognize as its own", async () => {
    const commitment = sampleCommitment();
    const facilitator = makeFacilitator(Keypair.random().publicKey());
    const payload = buildPayload(commitment);
    const result = await facilitator.verify(payload, buildRequirements(commitment));
    expect(result).toMatchObject({
      isValid: false,
      invalidReason: "invalid_upto_stellar_payload_wrong_facilitator",
    });
  });

  it("rejects self-dealing where the facilitator address equals the payer", async () => {
    const shared = Keypair.random().publicKey();
    const commitment = sampleCommitment({ facilitator: shared, from: shared });
    const facilitator = makeFacilitator(shared);
    const payload = buildPayload(commitment);
    const result = await facilitator.verify(payload, buildRequirements(commitment));
    expect(result).toMatchObject({
      isValid: false,
      invalidReason: "invalid_upto_stellar_payload_facilitator_is_payer",
    });
  });

  it("rejects self-dealing where the facilitator address equals the payee", async () => {
    const shared = Keypair.random().publicKey();
    const commitment = sampleCommitment({ facilitator: shared, payTo: shared });
    const facilitator = makeFacilitator(shared);
    const payload = buildPayload(commitment);
    const result = await facilitator.verify(payload, buildRequirements(commitment));
    expect(result).toMatchObject({
      isValid: false,
      invalidReason: "invalid_upto_stellar_payload_facilitator_is_payee",
    });
  });

  it("rejects at verify time when requirements.amount doesn't equal the signed maximum", async () => {
    const commitment = sampleCommitment();
    const facilitator = makeFacilitator(commitment.facilitator);
    const payload = buildPayload(commitment);
    const requirements = {
      ...buildRequirements(commitment),
      amount: (commitment.maxAmount - 1n).toString(),
    };
    const result = await facilitator.verify(payload, requirements);
    expect(result).toMatchObject({
      isValid: false,
      invalidReason: "invalid_upto_stellar_payload_wrong_max_amount",
    });
  });

  it("rejects at settle time when requirements.amount exceeds the signed maximum", async () => {
    const commitment = sampleCommitment();
    const facilitator = makeFacilitator(commitment.facilitator);
    const payload = buildPayload(commitment);
    const requirements = {
      ...buildRequirements(commitment),
      amount: (commitment.maxAmount + 1n).toString(),
    };
    const result = await facilitator.settle(payload, requirements);
    expect(result).toMatchObject({
      success: false,
      errorReason: "invalid_upto_stellar_settlement_exceeds_amount",
    });
  });

  it("rejects an expired deadline", async () => {
    const commitment = sampleCommitment({
      deadline: BigInt(Math.floor(Date.now() / 1000) - 3_600),
    });
    const facilitator = makeFacilitator(commitment.facilitator);
    const payload = buildPayload(commitment);
    const result = await facilitator.verify(payload, buildRequirements(commitment));
    expect(result).toMatchObject({ isValid: false, invalidReason: "invalid_upto_stellar_deadline_expired" });
  });

  it("rejects when the JSON-carried requestNonce disagrees with the signed witness", async () => {
    const commitment = sampleCommitment();
    const facilitator = makeFacilitator(commitment.facilitator);
    const payload = buildPayload(commitment, { requestNonce: "999999" });
    const result = await facilitator.verify(payload, buildRequirements(commitment));
    expect(result).toMatchObject({
      isValid: false,
      invalidReason: "invalid_upto_stellar_payload_witness_mismatch",
    });
  });

  describe("payload.accepted consistency (defense-in-depth against catalog poisoning)", () => {
    it("rejects when accepted.payTo differs from the witness's payTo", async () => {
      const commitment = sampleCommitment();
      const facilitator = makeFacilitator(commitment.facilitator);
      const payload = buildPayload(commitment);
      payload.accepted = { ...payload.accepted, payTo: Keypair.random().publicKey() };
      const result = await facilitator.verify(payload, buildRequirements(commitment));
      expect(result).toMatchObject({
        isValid: false,
        invalidReason: "invalid_upto_stellar_payload_accepted_inconsistent",
      });
    });

    it("rejects when accepted.extra.settlementContract disagrees with the facilitator's own configured contract", async () => {
      const commitment = sampleCommitment();
      const facilitator = makeFacilitator(commitment.facilitator);
      const payload = buildPayload(commitment);
      payload.accepted = {
        ...payload.accepted,
        extra: {
          ...(payload.accepted.extra as Record<string, unknown>),
          settlementContract: randomContractAddress(),
        },
      };
      const result = await facilitator.verify(payload, buildRequirements(commitment));
      expect(result).toMatchObject({
        isValid: false,
        invalidReason: "invalid_upto_stellar_payload_accepted_inconsistent",
      });
    });
  });

  describe("requirements.extra binding (settlementContract / facilitatorAddress)", () => {
    it("rejects when requirements.extra.settlementContract disagrees with the facilitator's own configured contract", async () => {
      const commitment = sampleCommitment();
      const facilitator = makeFacilitator(commitment.facilitator);
      const payload = buildPayload(commitment);
      const requirements = buildRequirements(commitment, {
        settlementContract: randomContractAddress(),
      });
      const result = await facilitator.verify(payload, requirements);
      expect(result).toMatchObject({
        isValid: false,
        invalidReason: "invalid_upto_stellar_payload_wrong_settlement_contract",
      });
    });

    it("rejects when requirements.extra.facilitatorAddress disagrees with the witness's committed facilitator", async () => {
      const commitment = sampleCommitment();
      const facilitator = makeFacilitator(commitment.facilitator);
      const payload = buildPayload(commitment);
      const requirements = buildRequirements(commitment, {
        facilitatorAddress: Keypair.random().publicKey(),
      });
      const result = await facilitator.verify(payload, requirements);
      expect(result).toMatchObject({
        isValid: false,
        invalidReason: "invalid_upto_stellar_payload_extra_facilitator_mismatch",
      });
    });
  });

  describe("escrow sub-invocation shape (Design B's core security requirement)", () => {
    it("rejects a witness with zero sub-invocations (Design A's shape, not Design B's)", async () => {
      const commitment = sampleCommitment();
      const facilitator = makeFacilitator(commitment.facilitator);
      const entry = buildEscrowEntry(commitment, SETTLEMENT_CONTRACT, { subInvocationCount: 0 });
      const payload = buildPayload(commitment, { authEntry: entry.toXDR("base64") });
      const result = await facilitator.verify(payload, buildRequirements(commitment));
      expect(result).toMatchObject({
        isValid: false,
        invalidReason: "invalid_upto_stellar_witness_missing_escrow_subinvocation",
      });
    });

    it("rejects a witness with more than one sub-invocation", async () => {
      const commitment = sampleCommitment();
      const facilitator = makeFacilitator(commitment.facilitator);
      const entry = buildEscrowEntry(commitment, SETTLEMENT_CONTRACT, { subInvocationCount: 2 });
      const payload = buildPayload(commitment, { authEntry: entry.toXDR("base64") });
      const result = await facilitator.verify(payload, buildRequirements(commitment));
      expect(result).toMatchObject({
        isValid: false,
        invalidReason: "invalid_upto_stellar_witness_missing_escrow_subinvocation",
      });
    });

    it("rejects a sub-invocation on the wrong contract (not the witness's own token)", async () => {
      const commitment = sampleCommitment();
      const facilitator = makeFacilitator(commitment.facilitator);
      const entry = buildEscrowEntry(commitment, SETTLEMENT_CONTRACT, {
        subContractAddress: randomContractAddress(),
      });
      const payload = buildPayload(commitment, { authEntry: entry.toXDR("base64") });
      const result = await facilitator.verify(payload, buildRequirements(commitment));
      expect(result).toMatchObject({
        isValid: false,
        invalidReason: "invalid_upto_stellar_witness_wrong_escrow_subinvocation",
      });
    });

    it("rejects a sub-invocation calling something other than transfer", async () => {
      const commitment = sampleCommitment();
      const facilitator = makeFacilitator(commitment.facilitator);
      const entry = buildEscrowEntry(commitment, SETTLEMENT_CONTRACT, {
        subFunctionName: "approve",
      });
      const payload = buildPayload(commitment, { authEntry: entry.toXDR("base64") });
      const result = await facilitator.verify(payload, buildRequirements(commitment));
      expect(result).toMatchObject({
        isValid: false,
        invalidReason: "invalid_upto_stellar_witness_wrong_escrow_subinvocation",
      });
    });

    it("rejects a sub-invocation whose transfer amount doesn't match the witness's maxAmount (a smuggled extra pull)", async () => {
      const commitment = sampleCommitment();
      const facilitator = makeFacilitator(commitment.facilitator);
      const entry = buildEscrowEntry(commitment, SETTLEMENT_CONTRACT, {
        subArgs: [
          nativeToScVal(commitment.from, { type: "address" }),
          nativeToScVal(SETTLEMENT_CONTRACT, { type: "address" }),
          nativeToScVal(commitment.maxAmount * 2n, { type: "i128" }),
        ],
      });
      const payload = buildPayload(commitment, { authEntry: entry.toXDR("base64") });
      const result = await facilitator.verify(payload, buildRequirements(commitment));
      expect(result).toMatchObject({
        isValid: false,
        invalidReason: "invalid_upto_stellar_witness_wrong_escrow_subinvocation",
      });
    });
  });

  // Design-B-specific: `getExtra()` must not surface any allowance-related
  // hint (there is nothing to approve under escrow-and-refund) while still
  // advertising the same contract/facilitator/fee-ceiling shape Design A's
  // `getExtra()` does, since resource servers and clients treat both designs'
  // quotes identically at this layer.
  it("getExtra() advertises the configured contract and fee ceiling, with no allowance-specific fields", () => {
    const facilitatorAddress = Keypair.random().publicKey();
    const facilitator = makeFacilitator(facilitatorAddress);
    const extra = facilitator.getExtra(STELLAR_TESTNET_CAIP2);
    expect(extra).toMatchObject({
      settlementContract: SETTLEMENT_CONTRACT,
      facilitatorAddress,
      maxFeeBps: 2_000,
      areFeesSponsored: true,
    });
    expect(extra).not.toHaveProperty("allowance");
  });
});
