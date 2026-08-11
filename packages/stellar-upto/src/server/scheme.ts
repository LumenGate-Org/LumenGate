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

export interface UptoStellarServerOptions {
  /**
   * Fee, in basis points, this resource server wants the facilitator to take
   * on-chain at settlement time. `0` (default) = standard `upto`: full amount
   * to the seller, facilitator bills off-chain (mirrors `exact`'s billing
   * model). `> 0` = "managed upto": the client's signature commits to this
   * exact value, so it cannot be raised later. Must be `<= maxFeeBps`
   * advertised by the facilitator (and `<= MAX_FEE_BPS` enforced on-chain).
   */
  feeBps?: number;
}

/**
 * Stellar resource-server implementation for the `upto` payment scheme.
 * Declares the `feeBps` billing tier (standard vs. managed) for routes that
 * register this scheme instance; register two instances (e.g. one at
 * `feeBps: 0` and one at `feeBps: 1000`) to offer both tiers on different
 * routes of the same server.
 */
export class UptoStellarScheme implements SchemeNetworkServer {
  readonly scheme = "upto";
  private readonly feeBps: number;
  private moneyParsers: MoneyParser[] = [];

  constructor(options: UptoStellarServerOptions = {}) {
    const feeBps = options.feeBps ?? 0;
    if (feeBps < 0 || feeBps > MAX_FEE_BPS) {
      throw new Error(`feeBps must be between 0 and ${MAX_FEE_BPS}, got ${feeBps}`);
    }
    this.feeBps = feeBps;
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
        areFeesSponsored: facilitatorExtra.areFeesSponsored ?? true,
      },
    });
  }

  validateFacilitatorSupport(
    _network: Network,
    supportedKind: SupportedKind,
    _facilitatorExtensions: string[],
  ): string | void {
    const facilitatorExtra = supportedKind.extra as { maxFeeBps?: number } | undefined;
    if (facilitatorExtra?.maxFeeBps !== undefined && this.feeBps > facilitatorExtra.maxFeeBps) {
      return `Configured feeBps (${this.feeBps}) exceeds facilitator's advertised maxFeeBps (${facilitatorExtra.maxFeeBps})`;
    }
  }
}
