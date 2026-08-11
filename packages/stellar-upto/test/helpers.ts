import { Address, nativeToScVal, StrKey, xdr } from "@stellar/stellar-sdk";
import { randomBytes } from "node:crypto";
import { buildWitnessScArgs, SETTLE_FUNCTION_NAME } from "../src/witness.js";
import type { UptoWitnessCommitment } from "../src/types.js";

export function randomContractAddress(): string {
  return StrKey.encodeContract(randomBytes(32));
}

/**
 * Builds a `SorobanAuthorizationEntry` shaped like what
 * `contract.AssembledTransaction` + `signAuthEntries` would produce, without
 * going through a real RPC simulation — enough to exercise `decodeWitnessEntry`
 * (and, via its base64 XDR, the facilitator's pre-RPC verify checks) in
 * isolation. `signed` controls whether the signature ScVal is void.
 */
export function buildEntry(
  commitment: UptoWitnessCommitment,
  settlementContract: string,
  opts: {
    contractAddress?: string;
    functionName?: string;
    argCount?: number;
    subInvocationCount?: number;
    signed?: boolean;
    signerAddress?: string;
    args?: xdr.ScVal[];
  } = {},
): xdr.SorobanAuthorizationEntry {
  const args = opts.args ?? buildWitnessScArgs(commitment);
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(opts.contractAddress ?? settlementContract).toScAddress(),
        functionName: opts.functionName ?? SETTLE_FUNCTION_NAME,
        args: opts.argCount !== undefined ? args.slice(0, opts.argCount) : args,
      }),
    ),
    subInvocations: Array.from({ length: opts.subInvocationCount ?? 0 }, () =>
      trivialSubInvocation(opts.contractAddress ?? settlementContract),
    ),
  });

  const signature =
    opts.signed === false
      ? xdr.ScVal.scvVoid()
      : xdr.ScVal.scvVec([xdr.ScVal.scvBytes(Buffer.alloc(64, 1))]);

  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(opts.signerAddress ?? commitment.from).toScAddress(),
        nonce: xdr.Int64.fromString("1"),
        signatureExpirationLedger: 1_000_000,
        signature,
      }),
    ),
    rootInvocation: invocation,
  });
}

/**
 * Builds a Design-B-shaped witness entry: same root `settle` invocation as
 * `buildEntry`, but with the escrow-pulling `token.transfer(from,
 * settlementContract, maxAmount)` nested as its one sub-invocation — the
 * exact shape `decodeEscrowWitnessEntry` (`../src/facilitator/decode.ts`)
 * requires. Options let individual tests deliberately mis-shape the
 * sub-invocation to exercise each rejection path.
 */
export function buildEscrowEntry(
  commitment: UptoWitnessCommitment,
  settlementContract: string,
  opts: {
    subInvocationCount?: number;
    subContractAddress?: string;
    subFunctionName?: string;
    subArgs?: xdr.ScVal[];
    signed?: boolean;
  } = {},
): xdr.SorobanAuthorizationEntry {
  const args = buildWitnessScArgs(commitment);
  const subArgs =
    opts.subArgs ??
    [
      nativeToScVal(commitment.from, { type: "address" }),
      nativeToScVal(settlementContract, { type: "address" }),
      nativeToScVal(commitment.maxAmount, { type: "i128" }),
    ];
  const escrowSubInvocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(opts.subContractAddress ?? commitment.token).toScAddress(),
        functionName: opts.subFunctionName ?? "transfer",
        args: subArgs,
      }),
    ),
    subInvocations: [],
  });
  const subInvocationCount = opts.subInvocationCount ?? 1;
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(settlementContract).toScAddress(),
        functionName: SETTLE_FUNCTION_NAME,
        args,
      }),
    ),
    subInvocations: Array.from({ length: subInvocationCount }, () => escrowSubInvocation),
  });

  const signature =
    opts.signed === false
      ? xdr.ScVal.scvVoid()
      : xdr.ScVal.scvVec([xdr.ScVal.scvBytes(Buffer.alloc(64, 1))]);

  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(commitment.from).toScAddress(),
        nonce: xdr.Int64.fromString("1"),
        signatureExpirationLedger: 1_000_000,
        signature,
      }),
    ),
    rootInvocation: invocation,
  });
}

function trivialSubInvocation(contractAddress: string): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(contractAddress).toScAddress(),
        functionName: "noop",
        args: [],
      }),
    ),
    subInvocations: [],
  });
}
