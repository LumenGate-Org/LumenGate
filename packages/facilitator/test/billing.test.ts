import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BillingLedger, DEFAULT_SELLER_BILLING_PLAN, type SellerBillingPlan } from "../src/billing.js";

const SELLER = "GANYLKM3JW555MX52DCOJNRF4KA6MM222V4LA3JKHRQNTI3JQV735NDC";

function plan(overrides: Partial<SellerBillingPlan> = {}): SellerBillingPlan {
  return {
    allowancePeriod: "month",
    freeSettlementsPerPeriod: 3,
    feeConfig: { mode: "fixed", feeUsd: 0.01 },
    ...overrides,
  };
}

describe("BillingLedger", () => {
  let ledger: BillingLedger;

  beforeEach(() => {
    ledger = new BillingLedger(":memory:", plan());
  });

  it("charges nothing within the free tier", () => {
    for (let i = 0; i < 3; i++) {
      ledger.record({ payTo: SELLER, scheme: "exact", network: "stellar:testnet" });
    }
    const usage = ledger.computeUsage(SELLER);
    expect(usage.totalSettlements).toBe(3);
    expect(usage.billableCount).toBe(0);
    expect(usage.amountDueUsd).toBe(0);
  });

  it("charges only settlements past the free tier", () => {
    for (let i = 0; i < 5; i++) {
      ledger.record({ payTo: SELLER, scheme: "exact", network: "stellar:testnet" });
    }
    const usage = ledger.computeUsage(SELLER);
    expect(usage.totalSettlements).toBe(5);
    expect(usage.billableCount).toBe(2);
    expect(usage.amountDueUsd).toBeCloseTo(0.02, 6);
  });

  it("excludes on-chain-fee (managed upto) settlements from off-chain billing", () => {
    for (let i = 0; i < 5; i++) {
      ledger.record({ payTo: SELLER, scheme: "upto", network: "stellar:testnet", feeBps: 500 });
    }
    const usage = ledger.computeUsage(SELLER);
    expect(usage.totalSettlements).toBe(5);
    expect(usage.onChainFeeSettlements).toBe(5);
    expect(usage.billableCount).toBe(0);
    expect(usage.amountDueUsd).toBe(0);
  });

  it("mixes on-chain and off-chain settlements correctly", () => {
    for (let i = 0; i < 4; i++) {
      ledger.record({ payTo: SELLER, scheme: "upto", network: "stellar:testnet", feeBps: 500 });
    }
    for (let i = 0; i < 4; i++) {
      ledger.record({ payTo: SELLER, scheme: "upto", network: "stellar:testnet", feeBps: 0 });
    }
    const usage = ledger.computeUsage(SELLER);
    expect(usage.totalSettlements).toBe(8);
    expect(usage.onChainFeeSettlements).toBe(4);
    // 4 off-chain-billable, 3 free -> 1 billable
    expect(usage.billableCount).toBe(1);
    expect(usage.amountDueUsd).toBeCloseTo(0.01, 6);
  });

  it("scopes usage per seller", () => {
    const otherSeller = "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO";
    for (let i = 0; i < 5; i++) {
      ledger.record({ payTo: SELLER, scheme: "exact", network: "stellar:testnet" });
    }
    ledger.record({ payTo: otherSeller, scheme: "exact", network: "stellar:testnet" });
    expect(ledger.computeUsage(otherSeller).totalSettlements).toBe(1);
    expect(ledger.computeUsage(SELLER).totalSettlements).toBe(5);
  });

  it("scopes usage per period (month, for this seller's plan)", () => {
    ledger.record({ payTo: SELLER, scheme: "exact", network: "stellar:testnet" });
    const usage = ledger.computeUsage(SELLER, "2020-01");
    expect(usage.totalSettlements).toBe(0);
    expect(usage.allowancePeriod).toBe("month");
  });

  // A retried /settle call for `upto` can be served from a scheme's
  // idempotency cache, which still re-fires the onAfterSettle billing hook
  // every time — with the same real transaction hash. Without a dedup key,
  // each retry double-counted the seller's usage. See
  // e2e/conformance/CONFORMANCE_REPORT.md, "idempotency cache bypasses
  // validation."
  it("does not double-count repeated record() calls for the same transaction hash", () => {
    for (let i = 0; i < 3; i++) {
      ledger.record({ payTo: SELLER, scheme: "upto", network: "stellar:testnet", transactionHash: "abc123" });
    }
    const usage = ledger.computeUsage(SELLER);
    expect(usage.totalSettlements).toBe(1);
  });

  it("still counts settlements with different transaction hashes separately", () => {
    ledger.record({ payTo: SELLER, scheme: "upto", network: "stellar:testnet", transactionHash: "abc123" });
    ledger.record({ payTo: SELLER, scheme: "upto", network: "stellar:testnet", transactionHash: "def456" });
    const usage = ledger.computeUsage(SELLER);
    expect(usage.totalSettlements).toBe(2);
  });

  it("does not dedupe entries that omit a transaction hash (backward compatible)", () => {
    ledger.record({ payTo: SELLER, scheme: "exact", network: "stellar:testnet" });
    ledger.record({ payTo: SELLER, scheme: "exact", network: "stellar:testnet" });
    const usage = ledger.computeUsage(SELLER);
    expect(usage.totalSettlements).toBe(2);
  });

  describe("percentage-mode fee config", () => {
    const SEVEN_DECIMALS = 10_000_000;

    it("charges a fraction of the settled amount, in the asset's own atomic units", () => {
      const ledger = new BillingLedger(
        ":memory:",
        plan({ freeSettlementsPerPeriod: 0, feeConfig: { mode: "percentage", feeFraction: 0.01 } }),
      );
      // 100 USDC (7 decimals) settled -> 1% = 1 USDC fee.
      ledger.record({ payTo: SELLER, scheme: "exact", network: "stellar:testnet", amount: String(100 * SEVEN_DECIMALS) });
      expect(ledger.computeUsage(SELLER).amountDueUsd).toBeCloseTo(1, 6);
    });

    it("respects a custom assetDecimals for non-USDC SEP-41 tokens", () => {
      const ledger = new BillingLedger(
        ":memory:",
        plan({
          freeSettlementsPerPeriod: 0,
          feeConfig: { mode: "percentage", feeFraction: 0.01, assetDecimals: 2 },
        }),
      );
      // 100 units of a 2-decimal token -> 1% = 1 unit fee.
      ledger.record({ payTo: SELLER, scheme: "exact", network: "stellar:testnet", amount: String(100 * 100) });
      expect(ledger.computeUsage(SELLER).amountDueUsd).toBeCloseTo(1, 6);
    });

    it("treats a missing amount as zero rather than throwing", () => {
      const ledger = new BillingLedger(
        ":memory:",
        plan({ freeSettlementsPerPeriod: 0, feeConfig: { mode: "percentage", feeFraction: 0.01 } }),
      );
      ledger.record({ payTo: SELLER, scheme: "exact", network: "stellar:testnet" });
      expect(ledger.computeUsage(SELLER).amountDueUsd).toBeCloseTo(0, 6);
    });

    it("still applies the free allowance before percentage fees kick in", () => {
      const ledger = new BillingLedger(
        ":memory:",
        plan({ freeSettlementsPerPeriod: 2, feeConfig: { mode: "percentage", feeFraction: 0.01 } }),
      );
      for (let i = 0; i < 3; i++) {
        ledger.record({ payTo: SELLER, scheme: "exact", network: "stellar:testnet", amount: String(100 * SEVEN_DECIMALS) });
      }
      const usage = ledger.computeUsage(SELLER);
      expect(usage.billableCount).toBe(1);
      expect(usage.amountDueUsd).toBeCloseTo(1, 6); // only the 3rd settlement is billed
    });
  });

  describe("combined-mode fee config (fixed vs. percentage, min or max)", () => {
    const SEVEN_DECIMALS = 10_000_000;

    it("min rule: applies the fixed fee when it's smaller than the percentage component", () => {
      const ledger = new BillingLedger(
        ":memory:",
        plan({
          freeSettlementsPerPeriod: 0,
          feeConfig: { mode: "combined", feeUsd: 0.0001, feeFraction: 0.01, combineRule: "min" },
        }),
      );
      // 1 USDC settled -> 1% = $0.01, above the $0.0001 fixed fee -> fixed wins.
      ledger.record({ payTo: SELLER, scheme: "exact", network: "stellar:testnet", amount: String(1 * SEVEN_DECIMALS) });
      expect(ledger.computeUsage(SELLER).amountDueUsd).toBeCloseTo(0.0001, 6);
    });

    it("min rule: applies the percentage component when it's smaller than the fixed fee", () => {
      const ledger = new BillingLedger(
        ":memory:",
        plan({
          freeSettlementsPerPeriod: 0,
          feeConfig: { mode: "combined", feeUsd: 0.0001, feeFraction: 0.01, combineRule: "min" },
        }),
      );
      // 0.001 USDC settled -> 1% = $0.00001, below the $0.0001 fixed fee -> percentage wins.
      ledger.record({
        payTo: SELLER,
        scheme: "exact",
        network: "stellar:testnet",
        amount: String(0.001 * SEVEN_DECIMALS),
      });
      expect(ledger.computeUsage(SELLER).amountDueUsd).toBeCloseTo(0.00001, 8);
    });

    it("max rule: applies whichever component is larger", () => {
      const ledger = new BillingLedger(
        ":memory:",
        plan({
          freeSettlementsPerPeriod: 0,
          feeConfig: { mode: "combined", feeUsd: 0.05, feeFraction: 0.01, combineRule: "max" },
        }),
      );
      // 1 USDC settled -> 1% = $0.01, below the $0.05 fixed fee -> max is the fixed fee.
      ledger.record({ payTo: SELLER, scheme: "exact", network: "stellar:testnet", amount: String(1 * SEVEN_DECIMALS) });
      expect(ledger.computeUsage(SELLER).amountDueUsd).toBeCloseTo(0.05, 6);

      // 1,000 USDC settled -> 1% = $10, above the $0.05 fixed fee -> max is the percentage.
      const bigLedger = new BillingLedger(
        ":memory:",
        plan({
          freeSettlementsPerPeriod: 0,
          feeConfig: { mode: "combined", feeUsd: 0.05, feeFraction: 0.01, combineRule: "max" },
        }),
      );
      bigLedger.record({
        payTo: SELLER,
        scheme: "exact",
        network: "stellar:testnet",
        amount: String(1_000 * SEVEN_DECIMALS),
      });
      expect(bigLedger.computeUsage(SELLER).amountDueUsd).toBeCloseTo(10, 6);
    });
  });

  describe("per-seller plans (allowance period, reset convention, pricing rule)", () => {
    it("applies a seller-specific plan instead of the default when one is set", () => {
      const ledger = new BillingLedger(":memory:", DEFAULT_SELLER_BILLING_PLAN);
      ledger.setSellerPlan(SELLER, plan({ freeSettlementsPerPeriod: 0, feeConfig: { mode: "fixed", feeUsd: 5 } }));
      ledger.record({ payTo: SELLER, scheme: "exact", network: "stellar:testnet" });
      expect(ledger.computeUsage(SELLER).amountDueUsd).toBeCloseTo(5, 6);
    });

    it("leaves other sellers on the default plan unaffected", () => {
      const otherSeller = "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO";
      const ledger = new BillingLedger(
        ":memory:",
        plan({ freeSettlementsPerPeriod: 0, feeConfig: { mode: "fixed", feeUsd: 1 } }),
      );
      ledger.setSellerPlan(SELLER, plan({ freeSettlementsPerPeriod: 0, feeConfig: { mode: "fixed", feeUsd: 5 } }));
      ledger.record({ payTo: SELLER, scheme: "exact", network: "stellar:testnet" });
      ledger.record({ payTo: otherSeller, scheme: "exact", network: "stellar:testnet" });
      expect(ledger.computeUsage(SELLER).amountDueUsd).toBeCloseTo(5, 6);
      expect(ledger.computeUsage(otherSeller).amountDueUsd).toBeCloseTo(1, 6);
    });

    it("a day-period plan resets on a different cadence than a month-period plan", () => {
      const ledger = new BillingLedger(":memory:", plan({ allowancePeriod: "day", freeSettlementsPerPeriod: 1 }));
      ledger.record({ payTo: SELLER, scheme: "exact", network: "stellar:testnet" });
      ledger.record({ payTo: SELLER, scheme: "exact", network: "stellar:testnet" });
      const usage = ledger.computeUsage(SELLER);
      expect(usage.allowancePeriod).toBe("day");
      expect(usage.periodKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(usage.billableCount).toBe(1); // 1 free, 1 billable, same UTC day
    });

    it("a year-period plan pools settlements across the whole calendar year", () => {
      const ledger = new BillingLedger(":memory:", plan({ allowancePeriod: "year", freeSettlementsPerPeriod: 2 }));
      for (let i = 0; i < 3; i++) {
        ledger.record({ payTo: SELLER, scheme: "exact", network: "stellar:testnet" });
      }
      const usage = ledger.computeUsage(SELLER);
      expect(usage.allowancePeriod).toBe("year");
      expect(usage.periodKey).toMatch(/^\d{4}$/);
      expect(usage.billableCount).toBe(1);
    });

    it("settlements recorded under a plan's period cadence keep that scoping even if the plan is later changed", () => {
      const ledger = new BillingLedger(":memory:", plan({ allowancePeriod: "month", freeSettlementsPerPeriod: 0 }));
      ledger.record({ payTo: SELLER, scheme: "exact", network: "stellar:testnet" });
      // Switch the seller to a day-period plan — the settlement above was
      // recorded under "month", so it must not appear when querying "day".
      ledger.setSellerPlan(SELLER, plan({ allowancePeriod: "day", freeSettlementsPerPeriod: 0 }));
      const usage = ledger.computeUsage(SELLER);
      expect(usage.allowancePeriod).toBe("day");
      expect(usage.totalSettlements).toBe(0);
    });
  });

  describe("settlementCountsByGroup", () => {
    it("returns nothing when no settlements have been recorded", () => {
      expect(ledger.settlementCountsByGroup()).toEqual([]);
    });

    it("groups by scheme and network, all-time and across all sellers (unlike computeUsage)", () => {
      const otherSeller = "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO";
      ledger.record({ payTo: SELLER, scheme: "exact", network: "stellar:testnet" });
      ledger.record({ payTo: otherSeller, scheme: "exact", network: "stellar:testnet" });
      ledger.record({ payTo: SELLER, scheme: "upto", network: "stellar:testnet", feeBps: 0 });
      ledger.record({ payTo: SELLER, scheme: "exact", network: "stellar:pubnet" });

      const groups = ledger.settlementCountsByGroup();
      expect(groups).toHaveLength(3);
      expect(groups).toContainEqual({ scheme: "exact", network: "stellar:testnet", count: 2 });
      expect(groups).toContainEqual({ scheme: "upto", network: "stellar:testnet", count: 1 });
      expect(groups).toContainEqual({ scheme: "exact", network: "stellar:pubnet", count: 1 });
    });
  });
});

describe("BillingLedger: migration against a pre-existing old-schema database", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "x402-billing-migration-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // `CREATE TABLE IF NOT EXISTS` is a no-op against a database file that
  // already has the table — simulates an operator's existing deployment,
  // created before `transaction_hash`/`period_key`/`allowance_period`
  // existed, being pointed at the new code without any manual migration step.
  it("adds missing columns to an existing settlements table, and both dedup and period-scoping work afterward", () => {
    const dbPath = join(dir, "billing.db");
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE settlements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pay_to TEXT NOT NULL,
        scheme TEXT NOT NULL,
        network TEXT NOT NULL,
        fee_bps INTEGER NOT NULL,
        settled_at TEXT NOT NULL,
        month_key TEXT NOT NULL
      );
    `);
    raw.close();

    const ledger = new BillingLedger(dbPath, plan({ freeSettlementsPerPeriod: 1_000 }));
    // Would throw ("no such column: transaction_hash") before the fix.
    expect(() =>
      ledger.record({ payTo: SELLER, scheme: "upto", network: "stellar:testnet", transactionHash: "abc123" }),
    ).not.toThrow();
    ledger.record({ payTo: SELLER, scheme: "upto", network: "stellar:testnet", transactionHash: "abc123" });

    expect(ledger.computeUsage(SELLER).totalSettlements).toBe(1);
  });

  it("is a safe no-op against a database that already has every column (fresh table)", () => {
    const dbPath = join(dir, "billing.db");
    const first = new BillingLedger(dbPath);
    first.record({ payTo: SELLER, scheme: "upto", network: "stellar:testnet", transactionHash: "abc123" });

    // Re-opening the same file (e.g. a process restart) must not error on
    // the already-present columns, and prior data must still be there.
    const second = new BillingLedger(dbPath);
    expect(second.computeUsage(SELLER).totalSettlements).toBe(1);
  });
});
