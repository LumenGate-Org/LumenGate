import { x402Client } from "@x402/core/client";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { UptoStellarScheme } from "@x402-stellar/upto/client";
import { STELLAR_WILDCARD_CAIP2, type ClientStellarSigner, type RpcConfig } from "@x402/stellar";

/**
 * Builds an `x402Client` with both Stellar schemes (`exact` and `upto`)
 * registered for the same signer — the boilerplate every buyer/agent
 * integration needs, factored out once. Pass the result to
 * `wrapFetchWithPayment` (from `@x402/fetch`) to get a payable `fetch`.
 *
 * @param signer - The buyer/agent's Stellar signer
 * @param options - Optional RPC configuration, shared by both schemes
 * @returns A configured `x402Client`
 */
export function createStellarPaymentClient(
  signer: ClientStellarSigner,
  options: { rpcConfig?: RpcConfig } = {},
): x402Client {
  const client = new x402Client();
  client.register(STELLAR_WILDCARD_CAIP2, new ExactStellarScheme(signer, options.rpcConfig));
  client.register(STELLAR_WILDCARD_CAIP2, new UptoStellarScheme(signer, options));
  return client;
}
