import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { x402Client } from "@x402/core/client";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { UptoStellarScheme } from "@x402-stellar/upto/client";
import { STELLAR_WILDCARD_CAIP2, type ClientStellarSigner } from "@x402/stellar";
import { createStellarPaymentClient } from "../src/client.js";

function stubSigner(): ClientStellarSigner {
  return {
    address: Keypair.random().publicKey(),
    signAuthEntry: async () => {
      throw new Error("not expected to sign in this test");
    },
  };
}

describe("createStellarPaymentClient", () => {
  it("returns an x402Client instance", () => {
    const client = createStellarPaymentClient(stubSigner());
    expect(client).toBeInstanceOf(x402Client);
  });

  it("registers both exact and upto schemes for the Stellar wildcard network", () => {
    const registerSpy = vi.spyOn(x402Client.prototype, "register");
    createStellarPaymentClient(stubSigner());

    expect(registerSpy).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = registerSpy.mock.calls;
    expect(firstCall[0]).toBe(STELLAR_WILDCARD_CAIP2);
    expect(firstCall[1]).toBeInstanceOf(ExactStellarScheme);
    expect(secondCall[0]).toBe(STELLAR_WILDCARD_CAIP2);
    expect(secondCall[1]).toBeInstanceOf(UptoStellarScheme);

    registerSpy.mockRestore();
  });

  it("passes the same signer to both schemes", () => {
    const signer = stubSigner();
    const registerSpy = vi.spyOn(x402Client.prototype, "register");
    createStellarPaymentClient(signer);

    // Both scheme instances close over the same signer object — checked
    // indirectly via its address, since the scheme classes don't expose the
    // signer they were constructed with directly.
    const [[, exactScheme], [, uptoScheme]] = registerSpy.mock.calls as [
      [unknown, ExactStellarScheme],
      [unknown, UptoStellarScheme],
    ];
    expect((exactScheme as unknown as { signer: ClientStellarSigner }).signer.address).toBe(
      signer.address,
    );
    expect((uptoScheme as unknown as { signer: ClientStellarSigner }).signer.address).toBe(
      signer.address,
    );

    registerSpy.mockRestore();
  });

  it("forwards rpcConfig to both schemes without throwing", () => {
    expect(() =>
      createStellarPaymentClient(stubSigner(), {
        rpcConfig: { url: "https://soroban-testnet.stellar.org" },
      }),
    ).not.toThrow();
  });
});
