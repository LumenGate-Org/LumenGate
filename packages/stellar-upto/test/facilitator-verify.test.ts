import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { STELLAR_TESTNET_CAIP2, type FacilitatorStellarSigner } from "@x402/stellar";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { UptoStellarScheme } from "../src/facilitator/scheme.js";
import type { UptoWitnessCommitment } from "../src/types.js";
import { buildEntry, randomContractAddress } from "./helpers.js";

/**
 * Covers `UptoStellarScheme` (facilitator)'s pre-RPC validation logic: every
 * check up to and including the deadline check happens before any network
 * call, so these run fast and offline while still exercising the exact
 * security-critical logic an adversarial validation flagged as previously
 * untested — in particular the `verify()` crash-safety fix (a malformed
 * `requirements.amount` must reject, not throw) and the `feeBps` fix (a
 * witness signed for a non-zero fee must not slip through when the resource
 * server's `requirements.extra.feeBps` is simply omitted).
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

function makeFacilitator(facilitatorAddress: string): UptoStellarScheme {
  return new UptoStellarScheme([stubSigner(facilitatorAddress)], {
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
  const entry = buildEntry(commitment, SETTLEMENT_CONTRACT);
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

describe("UptoStellarScheme facilitator: pre-RPC rejection paths", () => {
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

  it("rejects a network mismatch between payload and requirements", async () => {
    const commitment = sampleCommitment();
    const facilitator = makeFacilitator(commitment.facilitator);
    const payload = buildPayload(commitment);
    const requirements = { ...buildRequirements(commitment), network: "stellar:pubnet" };
    const result = await facilitator.verify(payload, requirements);
    expect(result).toMatchObject({ isValid: false, invalidReason: "network_mismatch" });
  });

  it("rejects when no settlement contract is configured for the network", async () => {
    const commitment = sampleCommitment();
    // Configured for pubnet only, but the payload targets testnet.
    const facilitator = new UptoStellarScheme([stubSigner(commitment.facilitator)], {
      "stellar:pubnet": SETTLEMENT_CONTRACT,
    });
    const payload = buildPayload(commitment);
    const result = await facilitator.verify(payload, buildRequirements(commitment));
    expect(result).toMatchObject({ isValid: false, invalidReason: "upto_stellar_network_not_configured" });
  });

  it("rejects a malformed payload missing the authEntry field", async () => {
    const commitment = sampleCommitment();
    const facilitator = makeFacilitator(commitment.facilitator);
    const payload = buildPayload(commitment);
    // @ts-expect-error deliberately malformed for the test
    payload.payload = { requestNonce: "1", deadline: "1" };
    const result = await facilitator.verify(payload, buildRequirements(commitment));
    expect(result).toMatchObject({ isValid: false, invalidReason: "invalid_upto_stellar_payload_malformed" });
  });

  it("rejects a non-numeric requirements.amount without throwing (crash-safety fix)", async () => {
    const commitment = sampleCommitment();
    const facilitator = makeFacilitator(commitment.facilitator);
    const payload = buildPayload(commitment);
    const requirements = { ...buildRequirements(commitment), amount: "not-a-number" };
    // Must resolve to a structured rejection, not throw — this is the exact
    // crash previously reachable with zero cost and no valid signature.
    await expect(facilitator.verify(payload, requirements)).resolves.toMatchObject({
      isValid: false,
      invalidReason: "invalid_upto_stellar_payload_malformed_amount",
    });
  });

  it("rejects a wrong payTo", async () => {
    const commitment = sampleCommitment();
    const facilitator = makeFacilitator(commitment.facilitator);
    const payload = buildPayload(commitment);
    const requirements = { ...buildRequirements(commitment), payTo: Keypair.random().publicKey() };
    const result = await facilitator.verify(payload, requirements);
    expect(result).toMatchObject({ isValid: false, invalidReason: "invalid_upto_stellar_payload_wrong_recipient" });
  });

  it("rejects a wrong asset", async () => {
    const commitment = sampleCommitment();
    const facilitator = makeFacilitator(commitment.facilitator);
    const payload = buildPayload(commitment);
    const requirements = { ...buildRequirements(commitment), asset: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" };
    const result = await facilitator.verify(payload, requirements);
    expect(result).toMatchObject({ isValid: false, invalidReason: "invalid_upto_stellar_payload_wrong_asset" });
  });

  it("rejects when the witness signs a non-zero feeBps but requirements.extra omits feeBps entirely (fee-bypass fix)", async () => {
    const commitment = sampleCommitment({ feeBps: 500 });
    const facilitator = makeFacilitator(commitment.facilitator);
    const payload = buildPayload(commitment);
    const requirements = buildRequirements(commitment);
    delete (requirements.extra as Record<string, unknown>).feeBps;
    const result = await facilitator.verify(payload, requirements);
    expect(result).toMatchObject({ isValid: false, invalidReason: "invalid_upto_stellar_payload_wrong_fee_bps" });
  });

  it("passes the feeBps check (proceeding to the next check) when both witness and extra agree on feeBps: 0 with extra.feeBps omitted", async () => {
    // feeBps defaults to 0 on both sides, so this must NOT be rejected for
    // feeBps specifically — instead it should reach (and fail) the next
    // check in sequence, proving the feeBps gate was satisfied and not
    // merely skipped past accidentally.
    const commitment = sampleCommitment({ feeBps: 0, facilitator: Keypair.random().publicKey() });
    const facilitator = makeFacilitator(Keypair.random().publicKey()); // different from commitment.facilitator
    const payload = buildPayload(commitment);
    const requirements = buildRequirements(commitment);
    delete (requirements.extra as Record<string, unknown>).feeBps;
    const result = await facilitator.verify(payload, requirements);
    expect(result).toMatchObject({
      isValid: false,
      invalidReason: "invalid_upto_stellar_payload_wrong_facilitator",
    });
  });

  it("rejects a feeBps that exceeds the on-chain ceiling", async () => {
    const commitment = sampleCommitment({ feeBps: 2_500 });
    const facilitator = makeFacilitator(commitment.facilitator);
    const payload = buildPayload(commitment);
    const requirements = buildRequirements(commitment);
    const result = await facilitator.verify(payload, requirements);
    expect(result).toMatchObject({ isValid: false, invalidReason: "invalid_upto_stellar_fee_exceeds_maximum" });
  });

  it("rejects a facilitator address the facilitator instance doesn't recognize as its own", async () => {
    const commitment = sampleCommitment();
    const facilitator = makeFacilitator(Keypair.random().publicKey()); // not commitment.facilitator
    const payload = buildPayload(commitment);
    const result = await facilitator.verify(payload, buildRequirements(commitment));
    expect(result).toMatchObject({ isValid: false, invalidReason: "invalid_upto_stellar_payload_wrong_facilitator" });
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
    const requirements = { ...buildRequirements(commitment), amount: (commitment.maxAmount - 1n).toString() };
    const result = await facilitator.verify(payload, requirements);
    expect(result).toMatchObject({ isValid: false, invalidReason: "invalid_upto_stellar_payload_wrong_max_amount" });
  });

  it("rejects at settle time when requirements.amount exceeds the signed maximum", async () => {
    const commitment = sampleCommitment();
    const facilitator = makeFacilitator(commitment.facilitator);
    const payload = buildPayload(commitment);
    const requirements = { ...buildRequirements(commitment), amount: (commitment.maxAmount + 1n).toString() };
    const result = await facilitator.settle(payload, requirements);
    expect(result).toMatchObject({ success: false, errorReason: "invalid_upto_stellar_settlement_exceeds_amount" });
  });

  it("rejects an expired deadline", async () => {
    const commitment = sampleCommitment({ deadline: BigInt(Math.floor(Date.now() / 1000) - 3_600) });
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
    expect(result).toMatchObject({ isValid: false, invalidReason: "invalid_upto_stellar_payload_witness_mismatch" });
  });

  // `payload.accepted` is the client-echoed advertised terms — phase-invariant,
  // and (for a direct caller of this facilitator's public HTTP routes, unlike
  // the standard @x402/express integration path) not otherwise cross-checked
  // against the witness anywhere else. A mismatch here doesn't let funds move
  // incorrectly (settlement is driven by `requirements` and the witness), but
  // `accepted` also flows into Bazaar cataloging on a successful settlement —
  // see docs/architecture.md's "Discovery cataloging" note.
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

    it("rejects when accepted.asset differs from the witness's token", async () => {
      const commitment = sampleCommitment();
      const facilitator = makeFacilitator(commitment.facilitator);
      const payload = buildPayload(commitment);
      payload.accepted = {
        ...payload.accepted,
        asset: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      };
      const result = await facilitator.verify(payload, buildRequirements(commitment));
      expect(result).toMatchObject({
        isValid: false,
        invalidReason: "invalid_upto_stellar_payload_accepted_inconsistent",
      });
    });

    it("rejects when accepted.extra.feeBps differs from the witness's signed feeBps", async () => {
      const commitment = sampleCommitment({ feeBps: 500 });
      const facilitator = makeFacilitator(commitment.facilitator);
      const payload = buildPayload(commitment);
      payload.accepted = {
        ...payload.accepted,
        extra: { ...(payload.accepted.extra as Record<string, unknown>), feeBps: 0 },
      };
      const result = await facilitator.verify(payload, buildRequirements(commitment));
      expect(result).toMatchObject({
        isValid: false,
        invalidReason: "invalid_upto_stellar_payload_accepted_inconsistent",
      });
    });

    it("rejects when accepted.amount differs from the witness's signed max, even at settle time with a smaller (otherwise-valid) actual amount", async () => {
      const commitment = sampleCommitment();
      const facilitator = makeFacilitator(commitment.facilitator);
      const payload = buildPayload(commitment);
      // A direct caller could try to advertise a fabricated, larger "max" via
      // `accepted` while settling for a small, real, otherwise-valid amount.
      payload.accepted = { ...payload.accepted, amount: (commitment.maxAmount * 100n).toString() };
      const settleRequirements = {
        ...buildRequirements(commitment),
        amount: (commitment.maxAmount / 2n).toString(),
      };
      const result = await facilitator.settle(payload, settleRequirements);
      expect(result).toMatchObject({
        success: false,
        errorReason: "invalid_upto_stellar_payload_accepted_inconsistent",
      });
    });

    // A fully self-consistent payload (accepted matching the witness exactly)
    // is exactly what every other test in this file already builds via
    // `buildPayload`/`buildRequirements` — none of them were rejected by this
    // new check, which is the "doesn't false-positive on honest input" proof;
    // a dedicated "accepts" test here would need to proceed past every
    // pre-RPC check into real RPC calls, out of scope for this file (see its
    // module docstring).

    it("rejects when accepted.extra.settlementContract disagrees with the facilitator's own configured contract", async () => {
      const commitment = sampleCommitment();
      const facilitator = makeFacilitator(commitment.facilitator);
      const payload = buildPayload(commitment);
      payload.accepted = {
        ...payload.accepted,
        extra: { ...(payload.accepted.extra as Record<string, unknown>), settlementContract: randomContractAddress() },
      };
      const result = await facilitator.verify(payload, buildRequirements(commitment));
      expect(result).toMatchObject({
        isValid: false,
        invalidReason: "invalid_upto_stellar_payload_accepted_inconsistent",
      });
    });

    it("rejects when accepted.extra.facilitatorAddress disagrees with the witness's committed facilitator", async () => {
      const commitment = sampleCommitment();
      const facilitator = makeFacilitator(commitment.facilitator);
      const payload = buildPayload(commitment);
      payload.accepted = {
        ...payload.accepted,
        extra: {
          ...(payload.accepted.extra as Record<string, unknown>),
          facilitatorAddress: Keypair.random().publicKey(),
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
      const requirements = buildRequirements(commitment, { settlementContract: randomContractAddress() });
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
      const requirements = buildRequirements(commitment, { facilitatorAddress: Keypair.random().publicKey() });
      const result = await facilitator.verify(payload, requirements);
      expect(result).toMatchObject({
        isValid: false,
        invalidReason: "invalid_upto_stellar_payload_extra_facilitator_mismatch",
      });
    });

    // Both fields are operationally required — the client can't even build a
    // witness without them (see client/scheme.ts's own validation) — so an
    // omitted field must be rejected the same as a wrong one, not silently
    // accepted because there was nothing to compare against.
    it("rejects when requirements.extra.settlementContract is omitted entirely", async () => {
      const commitment = sampleCommitment();
      const facilitator = makeFacilitator(commitment.facilitator);
      const payload = buildPayload(commitment);
      const requirements = buildRequirements(commitment, { settlementContract: undefined });
      const result = await facilitator.verify(payload, requirements);
      expect(result).toMatchObject({
        isValid: false,
        invalidReason: "invalid_upto_stellar_payload_wrong_settlement_contract",
      });
    });

    it("rejects when requirements.extra.facilitatorAddress is omitted entirely", async () => {
      const commitment = sampleCommitment();
      const facilitator = makeFacilitator(commitment.facilitator);
      const payload = buildPayload(commitment);
      const requirements = buildRequirements(commitment, { facilitatorAddress: undefined });
      const result = await facilitator.verify(payload, requirements);
      expect(result).toMatchObject({
        isValid: false,
        invalidReason: "invalid_upto_stellar_payload_extra_facilitator_mismatch",
      });
    });

    it("rejects when accepted.extra.settlementContract is omitted entirely", async () => {
      const commitment = sampleCommitment();
      const facilitator = makeFacilitator(commitment.facilitator);
      const payload = buildPayload(commitment);
      const acceptedExtra = { ...(payload.accepted.extra as Record<string, unknown>) };
      delete acceptedExtra.settlementContract;
      payload.accepted = { ...payload.accepted, extra: acceptedExtra };
      const result = await facilitator.verify(payload, buildRequirements(commitment));
      expect(result).toMatchObject({
        isValid: false,
        invalidReason: "invalid_upto_stellar_payload_accepted_inconsistent",
      });
    });

    it("rejects when accepted.extra.facilitatorAddress is omitted entirely", async () => {
      const commitment = sampleCommitment();
      const facilitator = makeFacilitator(commitment.facilitator);
      const payload = buildPayload(commitment);
      const acceptedExtra = { ...(payload.accepted.extra as Record<string, unknown>) };
      delete acceptedExtra.facilitatorAddress;
      payload.accepted = { ...payload.accepted, extra: acceptedExtra };
      const result = await facilitator.verify(payload, buildRequirements(commitment));
      expect(result).toMatchObject({
        isValid: false,
        invalidReason: "invalid_upto_stellar_payload_accepted_inconsistent",
      });
    });
  });
});
