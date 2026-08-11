import { extractDiscoveryInfo } from "@x402/extensions/bazaar";
import type {
  FacilitatorSettleResultContext,
  FacilitatorVerifyFailureContext,
  FacilitatorVerifyResultContext,
} from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { BazaarCatalog, DEFAULT_PROVISIONAL_TTL_MS, type BazaarExtensionStatus } from "@x402-stellar/discovery";

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
