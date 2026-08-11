/**
 * x402 `upto` scheme for Stellar/Soroban.
 *
 * Root export mirrors `@x402/stellar`'s convention: the client scheme by
 * default (most integrations just need to sign payments), with `./client`,
 * `./facilitator`, and `./server` subpaths for explicit role-specific access.
 *
 * @module
 */
export { UptoStellarScheme } from "./client/scheme.js";

export * from "./types.js";
export * from "./constants.js";
export { buildWitnessScArgs, buildSettleScArgs, SETTLE_FUNCTION_NAME } from "./witness.js";
