import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";

/**
 * Fetches a URL and, if it returns `402 Payment Required`, decodes and
 * returns its `PaymentRequirements` without paying — so a caller can inspect
 * what a resource wants (token, settlement contract, price ceiling) before
 * committing to anything, e.g. to size an `upto` allowance appropriately
 * ahead of the real paid request.
 *
 * @param url - The resource URL to probe
 * @param init - Optional fetch init (method/headers/body), mirrored on the probe request
 * @returns The accepted `PaymentRequirements`, or `null` if the resource isn't payment-gated
 */
export async function inspectPaymentRequirements(
  url: string,
  init?: RequestInit,
): Promise<PaymentRequirements[] | null> {
  const response = await fetch(url, init);
  if (response.status !== 402) return null;
  const header = response.headers.get("PAYMENT-REQUIRED");
  if (!header) return null;
  return decodePaymentRequiredHeader(header).accepts;
}
