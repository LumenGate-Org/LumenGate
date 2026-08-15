import { extractDiscoveryInfo } from "@x402/extensions/bazaar";
import type {
  FacilitatorSettleResultContext,
  FacilitatorVerifyFailureContext,
  FacilitatorVerifyResultContext,
} from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  BazaarCatalog,
  DEFAULT_PROVISIONAL_TTL_MS,
  resourceId,
  type BazaarExtensionStatus,
} from "@x402-stellar/discovery";
import { verifyResourceOwnership } from "./resource-ownership.js";

/**
 * Tracks the Bazaar cataloging outcome per in-flight request, keyed by the
 * exact `PaymentPayload` object instance the route handler passed into
 * `facilitator.verify(...)`/`facilitator.settle(...)`. The hooks (which have
 * no access to the HTTP response) record the outcome here; the route
 * handler (which does) reads it back to set the `EXTENSION-RESPONSES`
 * header — avoids re-running extraction/validation a second time in the
 * handler just to know the status.
 */
const lastExtensionStatus = new WeakMap<
  PaymentPayload,
  { status: BazaarExtensionStatus; rejectedReason?: string }
>();

export function getBazaarExtensionStatus(
  payload: PaymentPayload,
): { status: BazaarExtensionStatus; rejectedReason?: string } | undefined {
  return lastExtensionStatus.get(payload);
}

/**
 * Default `minSettledAmountForUniqueBuyerCredit` (docs/bazaar-usage-ranking-design.md
 * §2.3) — the atomic-unit floor a settlement must clear before its buyer
 * counts toward a resource's `unique_buyers` signal. `1000n` matches
 * `DEFAULT_SELLER_BILLING_PLAN`'s own `feeUsd: 0.0001` in `billing.ts` at
 * that same plan's default 7-decimal asset scale (`0.0001 * 10^7 = 1000`) —
 * reusing a number this project already treats as "a real, non-trivial
 * amount" rather than inventing a new one. Same caveat as
 * `AGENT_MAX_PAYMENT_AMOUNT` in `packages/mcp-discovery-server/src/guardrails.ts`:
 * this assumes the threshold and the settled amount it's compared against
 * share one asset's decimals — an operator metering a non-7-decimal asset
 * should pass an explicit threshold to `createUsageTrackingHook` instead.
 */
export const DEFAULT_MIN_SETTLED_AMOUNT_FOR_UNIQUE_BUYER_CREDIT = 1000n;

/**
 * Extracts the catalog-ready payload shared by both hooks below. Always
 * built from `paymentPayload.accepted` (the client-echoed *advertised*
 * requirements), never from settle-phase `requirements` — `@x402/core`'s
 * `settlePayment` builds settle-phase `requirements` as `{ ...accepted,
 * amount: <this specific request's metered charge> }` for `upto`
 * (`resolveSettlementOverrideAmount`), so cataloging it would publish a
 * one-off metered charge as the resource's advertised price instead of the
 * ceiling the client actually authorized. `accepted` is deep-equality
 * checked against the resource server's own declared `accepts` entry
 * upstream (`paymentRequirementsMatchAccepted`) for the standard
 * `@x402/express` path, and cross-checked against the witness commitment
 * directly by `UptoStellarScheme._verify` for direct callers of this
 * facilitator's public routes — see `createBazaarCatalogingHook`'s original
 * doc history for the full incident trail.
 */
function extractCatalogInput(paymentPayload: PaymentPayload) {
  const advertised = paymentPayload.accepted as PaymentRequirements;
  const discovered = extractDiscoveryInfo(paymentPayload, advertised, true);
  if (!discovered) return null;

  return {
    resourceUrl: discovered.resourceUrl,
    type: discovered.discoveryInfo.input.type,
    method: "method" in discovered ? discovered.method : undefined,
    toolName: "toolName" in discovered ? discovered.toolName : undefined,
    x402Version: discovered.x402Version,
    description: discovered.description,
    mimeType: discovered.mimeType,
    serviceName: discovered.serviceName,
    tags: discovered.tags,
    iconUrl: discovered.iconUrl,
    payTo: advertised.payTo,
    scheme: advertised.scheme,
    network: advertised.network,
    requirements: advertised,
    extensions: discovered.extensions,
  };
}

/**
 * Builds the `onAfterVerify` hook that catalogs a client-declared Bazaar
 * extension with `status: "provisional"` — protocol cataloging
 * trigger (Section 3.2: "When the facilitator receives a PaymentPayload
 * carrying the discovery extension, it validates `info` against the
 * supplied `schema` and catalogs the resource with no separate registration
 * step"), which ties cataloging to a *validated payload receipt*, not
 * settlement.
 *
 * This project's earlier design gated cataloging entirely on settlement,
 * for a real reason: `verify()` never moves funds or submits anything
 * on-chain, so cataloging unconditionally here once let anyone with a
 * validly-signed-but-never-settled payment authorization (costless against
 * a self-controlled token) inject arbitrary resource metadata into the
 * search index for free, repeatedly. That reasoning wasn't wrong, but it
 * also wasn't what protocol requirements describes, and protocol requirements
 * catalog-integrity defense (Section 3.2: soft-drop validation, strict
 * `routeTemplate` handling) is about validating *content*, not gating on
 * settlement. `status: "provisional"` reconciles both: the resource is
 * cataloged immediately, matching the protocol trigger, but only
 * visible for `DEFAULT_PROVISIONAL_TTL_MS` unless `createBazaarCatalogingHook`
 * promotes it to `"confirmed"` first — bounding, rather than eliminating,
 * the free-spam window a settlement-blind trigger otherwise has no defense
 * against. See "Automatic cataloging: provisional at receipt, confirmed at
 * settlement" in docs/architecture.md for the full rationale.
 *
 * @param catalog - The Bazaar catalog to write discovered resources into
 * @returns An `onAfterVerify` hook suitable for `x402Facilitator`
 */
export function createBazaarVerifyPreviewHook(catalog: BazaarCatalog) {
  return async (context: FacilitatorVerifyResultContext): Promise<void> => {
    if (!context.result.isValid) return;

    try {
      const catalogInput = extractCatalogInput(context.paymentPayload);
      if (!catalogInput) {
        // Not an error: the client simply didn't echo a bazaar extension.
        return;
      }

      await catalog.upsert(catalogInput, {
        status: "provisional",
        provisionalExpiresAt: new Date(Date.now() + DEFAULT_PROVISIONAL_TTL_MS).toISOString(),
      });

      lastExtensionStatus.set(context.paymentPayload, { status: "processing" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`Bazaar extension validation failed: ${reason}`);
      lastExtensionStatus.set(context.paymentPayload, { status: "rejected", rejectedReason: reason });
    }
  };
}

/**
 * Builds the `onAfterSettle` hook that promotes a resource's catalog entry
 * to `status: "confirmed"` — gated on `context.result.success`, so
 * promotion (and the resulting permanent, non-expiring visibility) only
 * happens once a real settlement (funds actually moved, or the `upto`
 * zero-amount case which still finalizes on-chain) has happened, not merely
 * on a costless `verify()`. See `createBazaarVerifyPreviewHook` for the
 * provisional-at-receipt half of this and why both halves are needed.
 *
 * For a direct caller of this facilitator's own public `/settle` route
 * (bypassing the upstream `@x402/express` deep-equality check),
 * `accepted` is cross-checked against the witness commitment directly —
 * `UptoStellarScheme._verify` binds
 * `accepted.payTo`/`asset`/`extra.feeBps`/`extra.settlementContract`/
 * `extra.facilitatorAddress`/`amount`, not just settle-phase
 * `requirements`'s — closing the direct-caller version of "publish
 * fabricated economics for a real, settled resource"
 * (`packages/stellar-upto/src/facilitator/scheme.ts`). That check alone
 * wasn't sufficient, though: `UptoStellarScheme.settle()` has its own
 * idempotency cache, and a *cache hit* skips `_verify` entirely — so a
 * replay carrying the same witness+amount but a mutated `accepted` used to
 * ride a prior real settlement's cached `success: true` straight past
 * validation. Fixed by widening the cache key to fingerprint the entire
 * request, not just the witness and amount, so a cache hit can now only
 * ever replay a byte-identical request (see `computeSettlementCacheKey`).
 * The residual that's left, and is *accepted* rather than fixed: any
 * witness holder can still choose which real (unmutated) settlement to
 * trigger via this public route at all — see "public `/settle`" in
 * `docs/architecture.md`.
 *
 * @param catalog - The Bazaar catalog to write discovered resources into
 * @returns An `onAfterSettle` hook suitable for `x402Facilitator`
 */
export function createBazaarCatalogingHook(catalog: BazaarCatalog) {
  return async (context: FacilitatorSettleResultContext): Promise<void> => {
    if (!context.result.success) return;

    try {
      const catalogInput = extractCatalogInput(context.paymentPayload);
      if (!catalogInput) {
        // Not an error: the client simply didn't echo a bazaar extension.
        return;
      }

      // Re-verify ownership only when this settlement would actually change
      // who a cataloged URL says it pays — a resource re-confirming the same
      // payTo it already has doesn't need a fresh outbound fetch on every
      // single settlement; a brand-new URL, or an existing one whose payTo
      // is about to change, is exactly the URL-squatting/impersonation
      // signature `verifyResourceOwnership` exists to catch. See
      // `resource-ownership.ts` for the full threat this closes.
      const existing = await catalog.getById(resourceId(catalogInput));
      if (!existing || existing.payTo !== catalogInput.payTo) {
        const ownership = await verifyResourceOwnership(catalogInput);
        if (ownership.outcome === "failed") {
          const reason = `resource-ownership check failed: ${ownership.reason}`;
          console.warn(`Bazaar cataloging refused for ${catalogInput.resourceUrl}: ${reason}`);
          lastExtensionStatus.set(context.paymentPayload, { status: "rejected", rejectedReason: reason });
          return;
        }
      }

      // Durable-outbox pattern (see "pending_catalog" in
      // packages/discovery/src/catalog.ts): write the full catalog payload
      // to disk, keyed by this settlement's transaction hash, BEFORE
      // attempting the actual upsert. If the process dies between here and
      // `resolvePending` below — the crash window this closes — the row
      // survives and packages/facilitator/src/indexer.ts can find and retry
      // it independently, instead of that resource staying permanently
      // un-confirmed with nothing left to notice. Only possible when a real
      // transaction hash exists (always true for a successful settlement).
      const transactionHash = context.result.transaction;
      if (transactionHash) await catalog.enqueuePending(transactionHash, catalogInput);

      await catalog.upsert(catalogInput, { status: "confirmed" });

      if (transactionHash) await catalog.resolvePending(transactionHash);

      lastExtensionStatus.set(context.paymentPayload, { status: "success" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`Bazaar cataloging failed: ${reason}`);
      lastExtensionStatus.set(context.paymentPayload, { status: "rejected", rejectedReason: reason });
    }
  };
}

/**
 * Builds the `onAfterSettle` hook that records usage-based ranking signals
 * (docs/bazaar-usage-ranking-design.md §4) for a settled, cataloged
 * resource — `catalog.recordUsage`'s one atomic write, gated on the same
 * Sybil-resistance threshold (§2.3).
 *
 * **Registered as its own, later `.onAfterSettle(...)` call — never folded
 * into `createBazaarCatalogingHook`.** Two concrete reasons, not a style
 * preference:
 *
 * 1. **Foreign-key ordering.** `resource_usage_daily`/`resource_buyers` both
 *    reference `resources(id)`, so this must run strictly after
 *    `createBazaarCatalogingHook`'s `upsert` has actually landed.
 *    `@x402/core`'s `afterSettleHooks` is a plain array awaited in
 *    registration order (`for (const hook of this.afterSettleHooks) { await
 *    hook(resultContext); }`), so registering this hook after the
 *    cataloging hook gets that ordering for free — see `server.ts`.
 * 2. **Failure isolation.** A transient usage-write failure must never be
 *    reported as a cataloging failure for a settlement that actually
 *    succeeded — this hook has its own try/catch and never touches
 *    `lastExtensionStatus`, so it can only ever degrade usage-tracking,
 *    never the reported `/settle` outcome.
 *
 * Guarded against a resource that was never actually cataloged (no bazaar
 * extension declared, or cataloging itself was rejected — e.g. by
 * `verifyResourceOwnership`): `catalog.getById` is checked first, since
 * `recordUsage` would otherwise fail its `REFERENCES resources(id)`
 * foreign key against a resource id that doesn't exist.
 *
 * `buyer` comes from `context.result.payer` (`SettleResponse.payer`), not
 * from `extractCatalogInput` — checked directly, that helper only carries
 * `payTo` (the seller) and discovery metadata, no payer address at all.
 * The settled amount comes from `context.requirements.amount` — the
 * settle-phase requirements' amount, which `@x402/core` already builds as
 * `{ ...accepted, amount: <this request's actual metered charge> }` for
 * `upto` (see `extractCatalogInput`'s doc comment) and is the fixed charge
 * itself for `exact` — the same field the sibling billing hook in
 * `server.ts` already reads for the same reason: it's reliably present and
 * always reflects what was actually settled, unlike `result.amount`, which
 * `@x402/core` documents as present only "for schemes like `upto`."
 *
 * @param catalog - The Bazaar catalog to record usage into
 * @param options.minSettledAmountForUniqueBuyerCredit - The Sybil-resistance
 *   threshold (§2.3), either a flat atomic-unit amount or a per-seller
 *   function keyed by `payTo` — defaults to
 *   `DEFAULT_MIN_SETTLED_AMOUNT_FOR_UNIQUE_BUYER_CREDIT` for every seller
 * @returns An `onAfterSettle` hook suitable for `x402Facilitator`
 */
export function createUsageTrackingHook(
  catalog: BazaarCatalog,
  options: { minSettledAmountForUniqueBuyerCredit?: bigint | ((payTo: string) => bigint) } = {},
) {
  const resolveThreshold = (payTo: string): bigint => {
    const configured = options.minSettledAmountForUniqueBuyerCredit;
    if (typeof configured === "function") return configured(payTo);
    return configured ?? DEFAULT_MIN_SETTLED_AMOUNT_FOR_UNIQUE_BUYER_CREDIT;
  };

  return async (context: FacilitatorSettleResultContext): Promise<void> => {
    if (!context.result.success) return;

    try {
      const catalogInput = extractCatalogInput(context.paymentPayload);
      if (!catalogInput) return; // no bazaar extension declared, nothing to track

      const buyer = context.result.payer;
      if (!buyer) return; // defensive: SettleResponse.payer is optional per its type

      const id = resourceId(catalogInput);
      const cataloged = await catalog.getById(id);
      if (!cataloged) return; // cataloging itself didn't happen (or was rejected) this round

      const settledAmount = BigInt(context.requirements.amount);
      const threshold = resolveThreshold(catalogInput.payTo);
      await catalog.recordUsage(id, buyer, settledAmount, threshold);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`Bazaar usage tracking failed: ${reason}`);
      // Deliberately does not touch lastExtensionStatus — see the doc
      // comment above: this must never affect the reported /settle outcome.
    }
  };
}

/**
 * Builds the `onVerifyFailure` hook counterpart, so a rejected witness/proof
 * doesn't leave a stale "success"/"processing" status from an earlier retry
 * on the same payload object.
 *
 * @returns An `onVerifyFailure` hook suitable for `x402Facilitator`
 */
export function createBazaarFailureHook() {
  return async (context: FacilitatorVerifyFailureContext): Promise<void> => {
    lastExtensionStatus.set(context.paymentPayload, {
      status: "rejected",
      rejectedReason: context.error.message,
    });
  };
}
