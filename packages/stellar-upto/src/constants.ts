/**
 * Must match `MAX_FEE_BPS` in `contracts/upto-settlement/src/lib.rs`. Kept as a
 * documented constant here (rather than queried on every use) since it only
 * changes on a contract redeploy; `UptoStellarScheme.getExtra()` still exposes
 * it so resource servers don't have to hardcode it a second time themselves.
 */
export const MAX_FEE_BPS = 2_000;

export const SUPPORTED_X402_VERSION = 2;

/**
 * Tolerance (in ledgers) applied when comparing an auth entry's
 * `signatureExpirationLedger` against the facilitator's freshly-fetched
 * "current ledger", to absorb RPC/query skew. Mirrors the equivalent
 * tolerance in `@x402/stellar`'s `exact` scheme facilitator.
 */
export const SIGNATURE_EXPIRATION_LEDGER_TOLERANCE = 2;

/** Wall-clock tolerance (seconds) applied when checking `deadline` freshness. */
export const DEADLINE_CLOCK_SKEW_TOLERANCE_SECONDS = 5;
