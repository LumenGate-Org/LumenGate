/** Header name defined by `specs/extensions/bazaar.md`. */
export const EXTENSION_RESPONSES_HEADER = "EXTENSION-RESPONSES";

export type BazaarExtensionStatus = "success" | "processing" | "rejected";

/**
 * Encodes the `EXTENSION-RESPONSES` header value: base64 JSON keyed by
 * extension name, per spec.
 *
 * @param status - Cataloging outcome for this request
 * @param rejectedReason - Human-readable reason, required when status is "rejected"
 * @returns The base64-encoded header value
 */
export function encodeBazaarExtensionResponse(
  status: BazaarExtensionStatus,
  rejectedReason?: string,
): string {
  const body: Record<string, unknown> = { bazaar: { status } };
  if (status === "rejected" && rejectedReason) {
    (body.bazaar as Record<string, unknown>).rejectedReason = rejectedReason;
  }
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64");
}
