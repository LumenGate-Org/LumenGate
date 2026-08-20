import { describe, expect, it } from "vitest";
import { Keypair, nativeToScVal } from "@stellar/stellar-sdk";
import { buildSettleScArgs, buildWitnessScArgs } from "../src/witness.js";
import { decodeWitnessEntry } from "../src/facilitator/decode.js";
import type { UptoWitnessCommitment } from "../src/types.js";
import { buildEntry, randomContractAddress } from "./helpers.js";

const SETTLEMENT_CONTRACT = randomContractAddress();

function sampleCommitment(): UptoWitnessCommitment {
  return {
    from: Keypair.random().publicKey(),
    payTo: Keypair.random().publicKey(),
    facilitator: Keypair.random().publicKey(),
    token: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    maxAmount: 1_000_000n,
    requestNonce: 42n,
    deadline: 9_999_999_999n,
    feeBps: 500,
    feeFixed: 0n,
    feeMode: 0,
  };
}

describe("witness encode/decode round-trip", () => {
  it("recovers an identical commitment from a validly-shaped entry", () => {
    const commitment = sampleCommitment();
    const entry = buildEntry(commitment, SETTLEMENT_CONTRACT);
    const xdrBase64 = entry.toXDR("base64");

    const result = decodeWitnessEntry(xdrBase64, SETTLEMENT_CONTRACT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.commitment).toEqual(commitment);
  });

  it("buildSettleScArgs matches buildWitnessScArgs on the shared 10 fields, plus actualAmount", () => {
    const commitment = sampleCommitment();
    const witnessArgs = buildWitnessScArgs(commitment);
    const settleArgs = buildSettleScArgs(commitment, 500_000n);

    expect(settleArgs).toHaveLength(11);
    expect(witnessArgs).toHaveLength(10);
    // settleArgs = [from, payTo, facilitator, token, maxAmount, actualAmount, requestNonce, deadline, feeBps, feeFixed, feeMode]
    // witnessArgs = [from, payTo, facilitator, token, maxAmount, requestNonce, deadline, feeBps, feeFixed, feeMode]
    for (let i = 0; i < 5; i++) {
      expect(settleArgs[i].toXDR("base64")).toEqual(witnessArgs[i].toXDR("base64"));
    }
    for (let i = 5; i < 10; i++) {
      expect(settleArgs[i + 1].toXDR("base64")).toEqual(witnessArgs[i].toXDR("base64"));
    }
  });

  it("rejects malformed XDR", () => {
    const result = decodeWitnessEntry("not-valid-base64-xdr", SETTLEMENT_CONTRACT);
    expect(result).toEqual({ ok: false, error: "invalid_upto_stellar_payload_malformed" });
  });

  it("rejects an entry targeting a different contract", () => {
    const commitment = sampleCommitment();
    const otherContract = randomContractAddress();
    const entry = buildEntry(commitment, SETTLEMENT_CONTRACT, { contractAddress: otherContract });
    const result = decodeWitnessEntry(entry.toXDR("base64"), SETTLEMENT_CONTRACT);
    expect(result).toEqual({ ok: false, error: "invalid_upto_stellar_witness_wrong_contract" });
  });

  it("rejects an entry authorizing the wrong function name", () => {
    const commitment = sampleCommitment();
    const entry = buildEntry(commitment, SETTLEMENT_CONTRACT, { functionName: "not_settle" });
    const result = decodeWitnessEntry(entry.toXDR("base64"), SETTLEMENT_CONTRACT);
    expect(result).toEqual({ ok: false, error: "invalid_upto_stellar_witness_wrong_function" });
  });

  it("rejects an entry with the wrong argument count", () => {
    const commitment = sampleCommitment();
    const entry = buildEntry(commitment, SETTLEMENT_CONTRACT, { argCount: 7 });
    const result = decodeWitnessEntry(entry.toXDR("base64"), SETTLEMENT_CONTRACT);
    expect(result).toEqual({ ok: false, error: "invalid_upto_stellar_witness_wrong_arity" });
  });

  it("rejects an entry carrying unexpected sub-invocations", () => {
    const commitment = sampleCommitment();
    const entry = buildEntry(commitment, SETTLEMENT_CONTRACT, { subInvocationCount: 1 });
    const result = decodeWitnessEntry(entry.toXDR("base64"), SETTLEMENT_CONTRACT);
    expect(result).toEqual({ ok: false, error: "invalid_upto_stellar_witness_has_subinvocations" });
  });

  it("rejects an entry with a void (unsigned) signature", () => {
    const commitment = sampleCommitment();
    const entry = buildEntry(commitment, SETTLEMENT_CONTRACT, { signed: false });
    const result = decodeWitnessEntry(entry.toXDR("base64"), SETTLEMENT_CONTRACT);
    expect(result).toEqual({ ok: false, error: "invalid_upto_stellar_missing_payer_signature" });
  });

  it("rejects an entry whose args carry an unexpected ScVal type at any position", () => {
    const commitment = sampleCommitment();
    const wrongTypedArgs = buildWitnessScArgs(commitment);
    // maxAmount (position 4) should be i128; substitute a plain u32 instead.
    wrongTypedArgs[4] = nativeToScVal(42, { type: "u32" });
    const entry = buildEntry(commitment, SETTLEMENT_CONTRACT, { args: wrongTypedArgs });
    const result = decodeWitnessEntry(entry.toXDR("base64"), SETTLEMENT_CONTRACT);
    expect(result).toEqual({ ok: false, error: "invalid_upto_stellar_witness_wrong_arg_type" });
  });

  it("rejects an entry whose signing address doesn't match the witness's `from`", () => {
    const commitment = sampleCommitment();
    const someoneElse = Keypair.random().publicKey();
    const entry = buildEntry(commitment, SETTLEMENT_CONTRACT, { signerAddress: someoneElse });
    const result = decodeWitnessEntry(entry.toXDR("base64"), SETTLEMENT_CONTRACT);
    expect(result).toEqual({ ok: false, error: "invalid_upto_stellar_witness_from_signer_mismatch" });
  });
});
