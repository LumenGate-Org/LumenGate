import { convertToTokenAmount, numberToDecimalString, parseMoneyString } from "@x402/core/utils";
import { DEFAULT_TOKEN_DECIMALS, getUsdcAddress } from "@x402/stellar";
import type {
  AssetAmount,
  MoneyParser,
  Network,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SupportedKind,
} from "@x402/core/types";
import { MAX_FEE_BPS } from "../constants.js";
import { UptoFeeMode } from "../types.js";

export interface UptoStellarServerOptions {
  /**
   * Percentage-component fee, in basis points, this resource server wants
   * the facilitator to take on-chain at settlement time. `0` (default,
   * with `feeMode: Percentage`) = standard `upto`: full amount to the
   * seller, facilitator bills off-chain (mirrors `exact`'s billing model).
   * `> 0` = "managed upto": the client's signature commits to this exact
   * value, so it cannot be raised later. The effective fee (however
   * `feeMode` computes it) is always `<= MAX_FEE_BPS` of the settled
   * amount, enforced on-chain.
   */
  feeBps?: number;
  /**
   * Fixed-component fee, in the settlement asset's own atomic units (not
   * USD — the settlement contract has no price oracle). Used when
   * `feeMode` is `Fixed`, `CombinedMin`, or `CombinedMax`. Default `0n`.
   */
  feeFixed?: bigint;
  /**
   * How `feeBps`/`feeFixed` combine into the effective on-chain fee,
   * mirroring `BillingFeeConfig`'s fixed/percentage/combined shape
   * (`packages/facilitator/src/billing.ts`) so the same configurable
   * business model applies to managed `upto`, not only the off-chain-billed
   * tiers. Default `UptoFeeMode.Percentage`.
   */
  feeMode?: UptoFeeMode;
}

/**
 * Stellar resource-server implementation for the `upto` payment scheme.
 * Declares the fee tier (standard vs. managed, and which fee mode) for
 * routes that register this scheme instance; register multiple instances
 * (e.g. one at `feeBps: 0` and one at `feeBps: 1000`) to offer several
 * tiers on different routes of the same server.
 */
export class UptoStellarScheme implements SchemeNetworkServer {
  readonly scheme = "upto";
  private readonly feeBps: number;
  private readonly feeFixed: bigint;
  private readonly feeMode: UptoFeeMode;
  private moneyParsers: MoneyParser[] = [];

  constructor(options: UptoStellarServerOptions = {}) {
    const feeBps = options.feeBps ?? 0;
    if (feeBps < 0 || feeBps > MAX_FEE_BPS) {
      throw new Error(`feeBps must be between 0 and ${MAX_FEE_BPS}, got ${feeBps}`);
    }
    const feeFixed = options.feeFixed ?? 0n;
    if (feeFixed < 0n) {
      throw new Error(`feeFixed must be non-negative, got ${feeFixed}`);
    }
    this.feeBps = feeBps;
    this.feeFixed = feeFixed;
    this.feeMode = options.feeMode ?? UptoFeeMode.Percentage;
  }

  /**
   * Register a custom money parser, tried in registration order before the
   * default USDC conversion. See `@x402/stellar`'s `ExactStellarScheme` for
   * the identical pattern this mirrors.
   *
   * @param parser - Custom function to convert a decimal amount to an AssetAmount
   * @returns The service instance for chaining
   */
  registerMoneyParser(parser: MoneyParser): UptoStellarScheme {
    this.moneyParsers.push(parser);
    return this;
  }

  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (typeof price === "object" && price !== null && "amount" in price) {
      if (!price.asset) {
        throw new Error(`Asset address must be specified for AssetAmount on network ${network}`);
      }
      return { amount: price.amount, asset: price.asset, extra: price.extra || {} };
    }

    const amount = typeof price === "number" ? price : parseMoneyString(price);
    for (const parser of this.moneyParsers) {
      const result = await parser(amount, network);
      if (result !== null) return result;
    }

    const tokenAmount = convertToTokenAmount(numberToDecimalString(amount), DEFAULT_TOKEN_DECIMALS);
    return { amount: tokenAmount, asset: getUsdcAddress(network), extra: {} };
  }

  enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    supportedKind: SupportedKind,
    _extensionKeys: string[],
  ): Promise<PaymentRequirements> {
    const facilitatorExtra = supportedKind.extra as
      | { settlementContract?: string; facilitatorAddress?: string; areFeesSponsored?: boolean }
      | undefined;
    if (!facilitatorExtra?.settlementContract || !facilitatorExtra.facilitatorAddress) {
      throw new Error(
        "upto: facilitator did not advertise settlementContract/facilitatorAddress via /supported",
      );
    }

    return Promise.resolve({
      ...paymentRequirements,
      extra: {
        ...paymentRequirements.extra,
        settlementContract: facilitatorExtra.settlementContract,
        facilitatorAddress: facilitatorExtra.facilitatorAddress,
        feeBps: this.feeBps,
        feeFixed: this.feeFixed.toString(),
        feeMode: this.feeMode,
        areFeesSponsored: facilitatorExtra.areFeesSponsored ?? true,
      },
    });
  }

  validateFacilitatorSupport(
    _network: Network,
    supportedKind: SupportedKind,
    _facilitatorExtensions: string[],
  ): string | void {
    // Only a static pre-check for Percentage mode: the effective fee in
    // Fixed/Combined modes depends on the settled amount, which isn't known
    // here, so it can't be validated statically — the contract's own
    // percentage-of-actual-amount ceiling is the real enforcement point for
    // every mode, checked at settlement time regardless.
    if (this.feeMode !== UptoFeeMode.Percentage) return;
    const facilitatorExtra = supportedKind.extra as { maxFeeBps?: number } | undefined;
    if (facilitatorExtra?.maxFeeBps !== undefined && this.feeBps > facilitatorExtra.maxFeeBps) {
      return `Configured feeBps (${this.feeBps}) exceeds facilitator's advertised maxFeeBps (${facilitatorExtra.maxFeeBps})`;
    }
  }
}
