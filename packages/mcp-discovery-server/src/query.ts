/**
 * Builds a URL query string from a params object, omitting any key whose
 * value is `undefined` (as opposed to `URLSearchParams`, which would
 * otherwise stringify it to the literal text `"undefined"`).
 *
 * @param params - Query parameters, where `undefined` means "omit"
 * @returns The encoded query string, without a leading `?`
 */
export function buildQuery(params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value));
  }
  return query.toString();
}
