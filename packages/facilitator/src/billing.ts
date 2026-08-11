import Database from "better-sqlite3";

/**
 * How often a seller's free settlement allowance renews. Each period resets
 * on its own calendar boundary in UTC: a day resets at UTC midnight, a month
 * on the 1st, a year on January 1st — the same "reset convention" a seller's
 * plan must define explicitly, per the pricing model below.
 */
export type AllowancePeriod = "day" | "month" | "year";

/**
 * The off-chain billing fee shape: a fixed per-settlement charge, a
 * percentage of the settled amount, or a combination of both. When both
 * components are configured, the applied fee is `min(fixed, percentage ×
 * settled amount)` or `max(...)`, per `combineRule` — e.g. a plan offering
 * "0.0001 USDC or 1% of the settled amount, whichever is smaller" protects
 * small settlements from a disproportionate fixed charge while still scaling
 * with volume on larger ones.
 *
 * Percentage components operate on the settlement asset's own atomic units
 * (`assetDecimals`, default 7 — SEP-41 USDC's decimals), not a hardcoded USD
 * conversion: protocol support covers "any SEP-41 token, USDC by
 * default" (`docs/architecture.md`), and different tokens can have different
 * decimals. An operator metering a non-7-decimal token must set
 * `assetDecimals` correctly, the same operational responsibility the
 * settlement path itself already has — silently assuming 7 would produce a
 * wrong (and wrong-by-orders-of-magnitude) fee for such a token.
 *
 * Fees are always denominated and paid in USD-equivalent terms (USDC) per
 * the pricing model this mirrors — see `docs/architecture.md`'s "on-chain
 * fee model" note for the one place this deliberately does NOT apply
 * (managed `upto`'s on-chain `fee_bps` is a percentage of whatever asset was
 * actually settled, not USDC-denominated, since a Soroban contract has no
 * price oracle to convert a fixed USDC amount into an arbitrary settlement
 * asset without one).
 */
export type BillingFeeConfig =
  | { readonly mode: "fixed"; readonly feeUsd: number }
  | {
      readonly mode: "percentage";
      /** Fraction of the settled amount, e.g. `0.01` = 1%. */
      readonly feeFraction: number;
      /** Decimals of the settlement asset's atomic units. Default 7 (SEP-41 USDC). */
      readonly assetDecimals?: number;
    }
  | {
      readonly mode: "combined";
      readonly feeUsd: number;
      readonly feeFraction: number;
      readonly assetDecimals?: number;
      /** Whether the applied fee is the smaller or larger of the two components. */
      readonly combineRule: "min" | "max";
    };

/**
 * A seller's complete billing configuration: how often their free allowance
 * renews, how large it is, and how the fee is computed once it's exhausted.
 * Every field the pricing model requires ("the allowance period, reset
 * convention, pricing rule and expiration must be defined in the seller's
 * configuration") lives here — there is no separate, implicit global
 * default a seller's plan silently falls back to for any of these.
 */
export interface SellerBillingPlan {
  readonly allowancePeriod: AllowancePeriod;
  readonly freeSettlementsPerPeriod: number;
  readonly feeConfig: BillingFeeConfig;
}

function percentageFeeUsd(
  feeFraction: number,
  assetDecimals: number | undefined,
  amountAtomic: string | null | undefined,
): number {
  const decimals = assetDecimals ?? 7;
  const atomic = amountAtomic ? BigInt(amountAtomic) : 0n;
  return (Number(atomic) / 10 ** decimals) * feeFraction;
}

function computeFeeUsd(config: BillingFeeConfig, amountAtomic: string | null | undefined): number {
  switch (config.mode) {
    case "fixed":
      return config.feeUsd;
    case "percentage":
      return percentageFeeUsd(config.feeFraction, config.assetDecimals, amountAtomic);
    case "combined": {
      const fixed = config.feeUsd;
      const percentage = percentageFeeUsd(config.feeFraction, config.assetDecimals, amountAtomic);
      return config.combineRule === "min" ? Math.min(fixed, percentage) : Math.max(fixed, percentage);
    }
  }
}

/**
 * The facilitator-wide default plan applied to any seller with no
 * seller-specific plan set via `BillingLedger.setSellerPlan`: matches the
 * example in the pricing model this implements — 1,000 free settlements per
 * day, then `min(0.0001 USDC, 1% of the settled amount)`.
 */
export const DEFAULT_SELLER_BILLING_PLAN: SellerBillingPlan = {
  allowancePeriod: "day",
  freeSettlementsPerPeriod: 1_000,
  feeConfig: { mode: "combined", feeUsd: 0.0001, feeFraction: 0.01, combineRule: "min" },
};

function periodKey(date: Date, period: AllowancePeriod): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  switch (period) {
    case "day":
      return `${year}-${month}-${day}`;
    case "month":
      return `${year}-${month}`;
    case "year":
      return `${year}`;
  }
}

/**
 * Off-chain usage metering for the `exact` and standard-`upto` (`feeBps: 0`)
 * billing tiers. Each seller (`payTo`) can carry its own `SellerBillingPlan`
 * — allowance period (day/month/year), free-settlement count per period, and
 * pricing rule (fixed, percentage, or combined) — set via `setSellerPlan`;
 * sellers with no plan set fall back to `DEFAULT_SELLER_BILLING_PLAN`. This
 * is deliberately simple — a real deployment would back this with a proper
 * accounts/invoicing system; here it demonstrates the configurable-business-
 * model pattern `docs/architecture.md` describes.
 *
 * Only successful settlements are ever charged: `record()` is only ever
 * called from the facilitator's `onAfterSettle` hook when `result.success`
 * is true (see `packages/facilitator/src/server.ts`) — failed verifications
 * and failed settlements never reach this ledger at all, so there is nothing
 * to exclude here; it's structural, not a filter this class applies.
 *
 * Managed-`upto` (`feeBps > 0`) doesn't need any of this: the facilitator is
 * paid atomically on-chain by the settlement contract itself (see
 * `contracts/upto-settlement-escrow`), so there is nothing to meter or
 * invoice here.
 */
export class BillingLedger {
  private readonly db: Database.Database;
  private readonly sellerPlans: Map<string, SellerBillingPlan> = new Map();

  constructor(
    dbPath: string = ":memory:",
    private readonly defaultPlan: SellerBillingPlan = DEFAULT_SELLER_BILLING_PLAN,
    sellerPlans: ReadonlyMap<string, SellerBillingPlan> = new Map(),
  ) {
    this.sellerPlans = new Map(sellerPlans);
    this.db = new Database(dbPath);
    // `transaction_hash`/`amount`/`period_key`/`allowance_period` deliberately
    // aren't in this base table definition — see the migration step right
    // below. `CREATE TABLE IF NOT EXISTS` is a no-op against a pre-existing
    // database file (an operator's existing deployment, upgrading), so a
    // column added here would only ever exist in a *freshly created*
    // database; every existing deployment would keep running the old schema
    // forever, and every `record()`/`computeUsage()` call would start
    // failing or silently mis-scoping usage the moment this code shipped.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settlements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pay_to TEXT NOT NULL,
        scheme TEXT NOT NULL,
        network TEXT NOT NULL,
        fee_bps INTEGER NOT NULL,
        settled_at TEXT NOT NULL,
        month_key TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_settlements_pay_to_month ON settlements(pay_to, month_key);
    `);

    // Migration: add any column this table (fresh or pre-existing) doesn't
    // have yet. Runs unconditionally on every startup — cheap (`PRAGMA
    // table_info` is a metadata-only read) and safe to repeat.
    // `period_key`/`allowance_period` (added alongside per-seller,
    // per-period billing plans) follow the same idempotent pattern as
    // `transaction_hash`/`amount` before them, for the same reason.
    const columns = this.db.prepare(`PRAGMA table_info(settlements)`).all() as { name: string }[];
    const addColumnIfMissing = (name: string, ddl: string): void => {
      if (!columns.some(column => column.name === name)) {
        this.db.exec(`ALTER TABLE settlements ADD COLUMN ${ddl}`);
      }
    };
    addColumnIfMissing("transaction_hash", "transaction_hash TEXT");
    addColumnIfMissing("amount", "amount TEXT");
    addColumnIfMissing("period_key", "period_key TEXT");
    addColumnIfMissing("allowance_period", "allowance_period TEXT");

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_settlements_pay_to_period
        ON settlements(pay_to, allowance_period, period_key);
    `);

    // Partial unique index (NULL/empty hashes are unconstrained, so this
    // stays backward-compatible with any caller that doesn't supply one):
    // a repeated record() call for the same on-chain settlement is a
    // no-op instead of a duplicate row. This is what actually makes
    // billing idempotent-safe under a retried /settle call — a cache-hit
    // reply from a scheme's settle() still re-fires onAfterSettle with the
    // same (real) transaction hash every time, and without this constraint
    // each replay double-counted a seller's usage. See
    // e2e/conformance/CONFORMANCE_REPORT.md, "idempotency cache bypasses
    // validation."
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_settlements_tx_hash
        ON settlements(transaction_hash)
        WHERE transaction_hash IS NOT NULL AND transaction_hash != '';
    `);
  }

  /**
   * Sets (or replaces) a specific seller's billing plan — the allowance
   * period, free-settlement count, and pricing rule that seller's own
   * configuration defines, per the pricing model. Sellers with no plan set
   * here use `defaultPlan` (constructor argument, itself defaulting to
   * `DEFAULT_SELLER_BILLING_PLAN`).
   *
   * @param payTo - The seller address this plan applies to
   * @param plan - The seller's complete billing configuration
   */
  setSellerPlan(payTo: string, plan: SellerBillingPlan): void {
    this.sellerPlans.set(payTo, plan);
  }

  /**
   * The effective plan for a seller: their own configured plan if one was
   * set via `setSellerPlan`, otherwise the facilitator-wide default.
   *
   * @param payTo - The seller address to resolve a plan for
   * @returns That seller's effective billing plan
   */
  planFor(payTo: string): SellerBillingPlan {
    return this.sellerPlans.get(payTo) ?? this.defaultPlan;
  }

  /**
   * Records a completed settlement. Only meaningful for `feeBps === 0`
   * settlements (`exact`, or standard `upto`); managed-`upto` settlements are
   * still recorded for reporting, but `computeUsage` excludes them from the
   * off-chain charge since the facilitator was already paid on-chain.
   *
   * The period this settlement counts toward (`period_key`/`allowance_period`)
   * is resolved from the seller's *current* plan at record time — if a
   * seller's plan is later changed (e.g. day -> month), settlements recorded
   * under the old cadence keep their original period scoping rather than
   * being silently reinterpreted.
   *
   * Idempotent when `transactionHash` is supplied and non-empty: a second
   * `record()` call for the same on-chain transaction (e.g. a retried
   * `/settle` call served from a scheme's idempotency cache) is a silent
   * no-op rather than a duplicate row — see the unique index above.
   *
   * @param entry - The settlement to record
   */
  record(entry: {
    payTo: string;
    scheme: string;
    network: string;
    feeBps?: number;
    /** Settled amount in the asset's own atomic units (e.g. 7-decimal stroops for USDC). Used by percentage/combined fee calculation. */
    amount?: string;
    transactionHash?: string;
  }): void {
    const plan = this.planFor(entry.payTo);
    const now = new Date();
    const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const key = periodKey(now, plan.allowancePeriod);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO settlements
           (pay_to, scheme, network, fee_bps, amount, transaction_hash, settled_at, month_key, period_key, allowance_period)
         VALUES (@payTo, @scheme, @network, @feeBps, @amount, @transactionHash, @settledAt, @monthKey, @periodKey, @allowancePeriod)`,
      )
      .run({
        payTo: entry.payTo,
        scheme: entry.scheme,
        network: entry.network,
        feeBps: entry.feeBps ?? 0,
        amount: entry.amount ?? null,
        transactionHash: entry.transactionHash || null,
        settledAt: now.toISOString(),
        monthKey,
        periodKey: key,
        allowancePeriod: plan.allowancePeriod,
      });
  }

  /**
   * Computes the current period's off-chain usage and charge for a given
   * seller (`payTo`), under that seller's own effective plan (`planFor`).
   * On-chain-fee (managed `upto`) settlements are counted for visibility but
   * excluded from `billableCount`/`amountDueUsd`, since the facilitator
   * already collected its fee atomically on-chain for those.
   *
   * The free allowance is applied to the first `freeSettlementsPerPeriod`
   * off-chain-billable settlements in chronological order (`ORDER BY id`);
   * the charge for each settlement past that is computed individually via
   * the plan's `feeConfig` (fixed, percentage, or combined) and summed —
   * necessary because percentage/combined fees vary per settlement, unlike a
   * flat-rate-only model where `billableCount * feePerSettlementUsd` would
   * be equivalent.
   *
   * @param payTo - The seller address to compute usage for
   * @param periodKeyOverride - The period to compute for (matching the seller's own `allowancePeriod` format — `YYYY-MM-DD`/`YYYY-MM`/`YYYY`); default: the current period under that seller's plan
   * @returns Usage counts and computed off-chain charge
   */
  computeUsage(
    payTo: string,
    periodKeyOverride?: string,
  ): {
    allowancePeriod: AllowancePeriod;
    periodKey: string;
    totalSettlements: number;
    onChainFeeSettlements: number;
    billableCount: number;
    freeSettlementsPerPeriod: number;
    amountDueUsd: number;
  } {
    const plan = this.planFor(payTo);
    const key = periodKeyOverride ?? periodKey(new Date(), plan.allowancePeriod);

    const rows = this.db
      .prepare(
        `SELECT fee_bps as feeBps, amount FROM settlements
         WHERE pay_to = ? AND allowance_period = ? AND period_key = ?
         ORDER BY id ASC`,
      )
      .all(payTo, plan.allowancePeriod, key) as { feeBps: number; amount: string | null }[];

    const onChainFeeSettlements = rows.filter(r => r.feeBps > 0).length;
    const offChainRows = rows.filter(r => r.feeBps === 0);
    const billableRows = offChainRows.slice(plan.freeSettlementsPerPeriod);
    const amountDueUsd = billableRows.reduce(
      (sum, row) => sum + computeFeeUsd(plan.feeConfig, row.amount),
      0,
    );

    return {
      allowancePeriod: plan.allowancePeriod,
      periodKey: key,
      totalSettlements: rows.length,
      onChainFeeSettlements,
      billableCount: billableRows.length,
      freeSettlementsPerPeriod: plan.freeSettlementsPerPeriod,
      amountDueUsd: Number(amountDueUsd.toFixed(6)),
    };
  }

  /**
   * All-time settlement counts grouped by scheme and network — an
   * operational volume signal (e.g. for `GET /metrics`), distinct from
   * `computeUsage`'s per-seller, per-period *billing* view.
   *
   * @returns One row per distinct `(scheme, network)` pair with its total count
   */
  settlementCountsByGroup(): { scheme: string; network: string; count: number }[] {
    return this.db
      .prepare(`SELECT scheme, network, COUNT(*) as count FROM settlements GROUP BY scheme, network`)
      .all() as { scheme: string; network: string; count: number }[];
  }

  close(): void {
    this.db.close();
  }
}
