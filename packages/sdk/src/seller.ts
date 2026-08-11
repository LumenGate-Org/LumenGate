import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import type { DeclareDiscoveryExtensionInput } from "@x402/extensions/bazaar";
import {
  STELLAR_TESTNET_CAIP2,
  validateStellarAssetAddress,
  validateStellarDestinationAddress,
} from "@x402/stellar";
import type { Network } from "@x402/core/types";
import type { PaymentOption } from "@x402/core/http";
import type { RouteConfig } from "@x402/core/server";

/**
 * Config for one Stellar-priced, Bazaar-discoverable resource. Bundles what
 * `examples/seller-http` otherwise hand-assembles per route: a `PaymentOption`
 * (scheme, price, network, payTo) plus, optionally, the Bazaar discovery
 * extension declaration — into one call with Stellar-appropriate defaults
 * and address validation, rather than two separate pieces a seller has to
 * keep consistent by hand (network/payTo repeated per route, `declareDiscoveryExtension`
 * spread in separately).
 */
export interface DeclareStellarResourceConfig {
  /** `"exact"` for a fixed price, `"upto"` for usage-based (see `specs/schemes/upto/scheme_upto_stellar.md`). */
  scheme: "exact" | "upto";
  /** Stellar address that receives payment. */
  payTo: string;
  /** SEP-41 token contract address to price in. */
  asset: string;
  /** Atomic token units — the fixed price for `exact`, or the ceiling for `upto`. */
  amount: string;
  /** Defaults to `stellar:testnet`. */
  network?: Network;
  maxTimeoutSeconds?: number;
  description?: string;
  mimeType?: string;
  /**
   * Bazaar discovery metadata for this resource. Passed straight through to
   * upstream `@x402/extensions/bazaar`'s `declareDiscoveryExtension` — this
   * helper doesn't reimplement extension validation/encoding, only the
   * Stellar-specific pricing boilerplate around it. Omit to make the
   * resource payable but not cataloged.
   */
  discovery?: DeclareDiscoveryExtensionInput;
}

/**
 * Builds one `PaymentOption` (the `accepts` entry `paymentMiddleware` routes
 * need) for a Stellar-priced resource, with address validation and a
 * testnet default network.
 *
 * @param config - Scheme, price, and network for this payment option
 * @returns A `PaymentOption` ready to place in a route's `accepts` array
 */
export function stellarPaymentOption(
  config: Pick<DeclareStellarResourceConfig, "scheme" | "payTo" | "asset" | "amount" | "network" | "maxTimeoutSeconds">,
): PaymentOption {
  if (!validateStellarDestinationAddress(config.payTo)) {
    throw new Error(`Invalid Stellar payTo address: ${config.payTo}`);
  }
  if (!validateStellarAssetAddress(config.asset)) {
    throw new Error(`Invalid Stellar asset address: ${config.asset}`);
  }
  return {
    scheme: config.scheme,
    payTo: config.payTo,
    price: { amount: config.amount, asset: config.asset },
    network: config.network ?? STELLAR_TESTNET_CAIP2,
    maxTimeoutSeconds: config.maxTimeoutSeconds,
  };
}

/**
 * Builds a full `RouteConfig` (what `paymentMiddleware`'s route map expects
 * per path) for a Stellar-priced, optionally Bazaar-discoverable resource —
 * the seller-side equivalent of `packages/sdk`'s buyer-side helpers
 * (`createStellarPaymentClient`, `ensureUptoAllowance`). See
 * `docs/developer-guide.md`, "Integrating as a seller," for the full flow
 * this slots into, and `examples/seller-http/src/index.ts` for it in
 * context alongside `setSettlementOverrides` for usage-metered `upto` routes.
 *
 * @param config - Pricing, network, and (optional) discovery metadata for this resource
 * @returns A `RouteConfig` for `paymentMiddleware`
 */
export function declareStellarResource(config: DeclareStellarResourceConfig): RouteConfig {
  return {
    accepts: [stellarPaymentOption(config)],
    description: config.description,
    mimeType: config.mimeType,
    extensions: config.discovery ? declareDiscoveryExtension(config.discovery) : undefined,
  };
}
