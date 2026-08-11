import { lookup as dnsLookup } from "node:dns/promises";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/** `URL.hostname` keeps brackets around a literal IPv6 address (`"[::1]"`); strip them for set lookups. */
function bareHostname(url: string): string {
  return new URL(url).hostname.replace(/^\[|\]$/g, "");
}

/**
 * Checks a target URL's hostname against an operator-configured allowlist.
 * An empty allowlist means "no restriction" (the prototype's zero-config default).
 *
 * @param url - The resource URL `call_resource` is about to fetch
 * @param allowedHosts - Hostnames from `AGENT_ALLOWED_HOSTS`; empty = unrestricted
 * @returns Whether `url`'s hostname is permitted
 */
export function isHostAllowed(url: string, allowedHosts: readonly string[]): boolean {
  if (allowedHosts.length === 0) return true;
  return allowedHosts.includes(new URL(url).hostname);
}

/**
 * Requires HTTPS for any non-loopback target. Plain HTTP is only accepted
 * for `localhost`/`127.0.0.1`/`::1`, so the local demo flow (a seller
 * running on `http://localhost:4022`, say) keeps working without
 * configuration, while a real deployment can't be pointed at a plaintext
 * remote endpoint — payment payloads and settlement responses would
 * otherwise be interceptable/spoofable in transit.
 *
 * @param url - The resource URL `call_resource` is about to fetch
 * @returns Whether the URL's transport is acceptable
 */
export function isSecureUrl(url: string): boolean {
  return new URL(url).protocol === "https:" || LOOPBACK_HOSTNAMES.has(bareHostname(url));
}

/**
 * Whether a bare IP address literal (no brackets, no port) falls in a
 * private or link-local range (RFC 1918 / RFC 3927, and the IPv6
 * ULA/link-local equivalents) — deliberately excluding loopback
 * (`127.0.0.0/8`, `::1`), which `isSecureUrl` carves out on its own terms
 * for the local demo flow. Most notably catches cloud metadata endpoints
 * like `169.254.169.254`.
 *
 * @param ip - A bare IPv4 or IPv6 address literal
 * @returns Whether the address is private/link-local (excluding loopback)
 */
function isPrivateIpAddress(ip: string): boolean {
  const ipv4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 — cloud metadata lives here
    return false; // includes 127.0.0.0/8 (loopback) — not this function's concern
  }

  // IPv6 unique local (fc00::/7) and link-local (fe80::/10). `::1` (loopback)
  // doesn't match either pattern, so it correctly falls through as false.
  return /^f[cd][0-9a-f]{0,2}:/i.test(ip) || /^fe[89ab][0-9a-f]:/i.test(ip);
}

/**
 * Checks whether a URL's hostname is *itself* a literal private/link-local
 * IP address. Synchronous, no DNS involved — a domain name always returns
 * `false` here regardless of what it resolves to; see
 * `resolvesToPrivateNetwork` for that case.
 *
 * @param url - The resource URL `call_resource` is about to fetch
 * @returns Whether the hostname is a literal private/link-local IP (excluding loopback)
 */
export function isPrivateNetworkHost(url: string): boolean {
  return isPrivateIpAddress(bareHostname(url));
}

/**
 * Resolves a URL's hostname and checks whether *any* returned address is
 * private/link-local — closes the common SSRF case `isPrivateNetworkHost`
 * can't see on its own: a plain domain name whose DNS record simply points
 * at an internal address (e.g. a catalog entry with `resourceUrl:
 * "http://attacker-domain.example/"` where that domain resolves to
 * `169.254.169.254`). A literal IP hostname resolves to itself, so this
 * subsumes `isPrivateNetworkHost` for that case too.
 *
 * This is still not a full SSRF defense: the address checked here isn't
 * *pinned* for the actual `fetch` that follows, so a DNS answer that changes
 * between this check and the connection (DNS rebinding, precisely timed) is
 * not caught. Closing that fully means resolving and pinning the IP at the
 * socket layer for the specific request, which isn't achievable through
 * `@x402/fetch`'s wrapped global `fetch` without controlling its dispatcher
 * internals — out of scope for this prototype-level guard. This check still
 * raises the bar substantially against the common case (a static malicious
 * or misconfigured DNS record), which is what most real SSRF reports are.
 *
 * A DNS lookup failure resolves to `false` (not blocked) — an unresolvable
 * hostname isn't itself a private-network signal, and the subsequent
 * `fetch` will fail on its own with a clearer network error.
 *
 * @param url - The resource URL `call_resource` is about to fetch
 * @returns Whether any resolved address for the hostname is private/link-local
 */
export async function resolvesToPrivateNetwork(url: string): Promise<boolean> {
  const hostname = bareHostname(url);
  try {
    const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
    return addresses.some(({ address }) => isPrivateIpAddress(address));
  } catch {
    return false;
  }
}

/**
 * Finds the first payment requirement whose atomic `amount` exceeds a
 * configured spending cap, if any. Compares raw atomic units directly — the
 * cap and every requirement it's checked against are assumed to share one
 * asset's decimals, same caveat as `ensureUptoAllowance`'s default sizing.
 *
 * `requirements` comes from `inspectPaymentRequirements`, i.e. whatever the
 * remote resource server's `402` response said — not validated input. A
 * non-digit `amount` fails closed (treated as over-cap, refusing payment)
 * rather than letting `BigInt(r.amount)` throw an uncaught `SyntaxError`
 * that would crash the whole `call_resource` invocation.
 *
 * @param requirements - Payment requirements returned by `inspectPaymentRequirements`
 * @param maxPaymentAmount - The cap from `AGENT_MAX_PAYMENT_AMOUNT`, or `undefined` to skip the check
 * @returns The first over-cap (or malformed) requirement, or `undefined` if none exceed it (or no cap is set)
 */
export function findRequirementOverCap(
  requirements: readonly PaymentRequirements[] | null | undefined,
  maxPaymentAmount: bigint | undefined,
): PaymentRequirements | undefined {
  if (maxPaymentAmount === undefined || !requirements) return undefined;
  return requirements.find(r => !/^\d+$/.test(r.amount) || BigInt(r.amount) > maxPaymentAmount);
}

/**
 * Decodes a live `402 Payment Required` HTTP response's advertised
 * requirements and checks them against the spending cap, in one step.
 *
 * This exists specifically so the cap check runs against the *exact*
 * response that a payment will actually be constructed from — not a
 * separate probe request. `inspectPaymentRequirements` (`@x402-stellar/sdk`)
 * does its own independent `fetch`, and `wrapFetchWithPayment`
 * (`@x402/fetch`) does *another* independent `fetch` internally to get the
 * quote it actually pays; nothing before this fix connected the two, so a
 * resource server could quote a low, in-cap price on the probe and a
 * different, over-cap price on the real request, and the cap check would
 * never see it. See `e2e/conformance/CONFORMANCE_REPORT.md`,
 * "AGENT_MAX_PAYMENT_AMOUNT can be bypassed by changing the quote between
 * probe and payment." The intended caller is a `fetch`-compatible wrapper
 * passed into `wrapFetchWithPayment` itself, so this runs on the one
 * response that flow will actually pay against — see `call_resource` in
 * `src/index.ts`.
 *
 * @param response - The HTTP response to inspect (only read if status is 402)
 * @param maxPaymentAmount - The cap from `AGENT_MAX_PAYMENT_AMOUNT`, or `undefined` to skip the check
 * @returns The decoded requirements (`null` if not a decodable payment-required response) and the first over-cap requirement, if any
 */
export function checkPaymentRequiredResponse(
  response: Response,
  maxPaymentAmount: bigint | undefined,
): { requirements: readonly PaymentRequirements[] | null; overCap: PaymentRequirements | undefined } {
  if (response.status !== 402) return { requirements: null, overCap: undefined };
  const header = response.headers.get("PAYMENT-REQUIRED");
  if (!header) return { requirements: null, overCap: undefined };
  let requirements: PaymentRequirements[];
  try {
    requirements = decodePaymentRequiredHeader(header).accepts;
  } catch {
    // Malformed header: not this function's job to report — the normal
    // wrapFetchWithPayment flow will attempt its own parse next and
    // surface a clearer, protocol-level error for it.
    return { requirements: null, overCap: undefined };
  }
  return { requirements, overCap: findRequirementOverCap(requirements, maxPaymentAmount) };
}
