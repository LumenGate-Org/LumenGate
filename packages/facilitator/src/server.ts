import "dotenv/config";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import express, { type Request, type Response } from "express";
import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  createEd25519Signer,
  getHorizonClient,
  STELLAR_PUBNET_CAIP2,
  STELLAR_TESTNET_CAIP2,
  type FacilitatorStellarSigner,
} from "@x402/stellar";
import type { Network } from "@x402/core/types";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import { UptoStellarEscrowScheme, UptoStellarScheme } from "@x402-stellar/upto/facilitator";
import { BazaarCatalog, createDiscoveryRouter, EXTENSION_RESPONSES_HEADER } from "@x402-stellar/discovery";
import { BillingLedger } from "./billing.js";
import {
  createBazaarCatalogingHook,
  createBazaarFailureHook,
  createBazaarVerifyPreviewHook,
  getBazaarExtensionStatus,
} from "./discovery-hooks.js";
import { formatPrometheusMetrics, type MetricFamily, type MetricSample } from "./metrics.js";

const PORT = Number(process.env.PORT ?? 4021);
const DISCOVERY_DB_PATH = process.env.DISCOVERY_DB_PATH ?? "./data/discovery.db";
const BILLING_DB_PATH = process.env.BILLING_DB_PATH ?? "./data/billing.db";
// Unset by default (open), matching this prototype's zero-config posture — see
// docs/architecture.md "Scope boundaries". Set it to require
// X-Billing-Admin-Token on GET /billing/usage before exposing per-seller
// volume data in a real deployment.
const BILLING_ADMIN_TOKEN = process.env.BILLING_ADMIN_TOKEN;

const secrets = (process.env.STELLAR_FACILITATOR_SECRETS ?? process.env.STELLAR_FACILITATOR_SECRET ?? "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

if (secrets.length === 0) {
  console.error(
    "STELLAR_FACILITATOR_SECRET(S) is required (Stellar secret key(s), comma-separated for multiple signers)",
  );
  process.exit(1);
}

// The `STELLAR_TESTNET_CAIP2` argument here only sets each signer's *default*
// network passphrase, used if a caller invokes `signTransaction`/
// `signAuthEntry` with no explicit override. Both `ExactStellarScheme.settle()`
// (upstream `@x402/stellar`) and `UptoStellarScheme.settleUnguarded()`
// (`packages/stellar-upto`) always pass an explicit `{ networkPassphrase }`
// derived from `requirements.network` at call time, and the SDK's
// `KeypairSigner.signTransaction` prefers that override over the
// construction-time default — verified directly against the SDK's signer
// implementation, since a Stellar `G...` address itself isn't network-scoped
// (the same keypair is valid on testnet and pubnet; only the passphrase used
// when computing what to sign is network-specific). So this same `signers`
// array registered for both `STELLAR_TESTNET_CAIP2` and `STELLAR_PUBNET_CAIP2`
// below produces correctly network-bound signatures on both. Per-network
// signer instances would be redundant, not a correctness requirement.
const signers: FacilitatorStellarSigner[] = secrets.map(secret =>
  createEd25519Signer(secret, STELLAR_TESTNET_CAIP2),
);
console.info(`Facilitator signer address(es): ${signers.map(s => s.address).join(", ")}`);

// Optional channel account pool for `upto`/managed-`upto` settlement only
// (see "Sequence-number bottlenecks" in docs/architecture.md; `exact` stays
// on the pre-existing multi-signer round-robin, since `ExactStellarScheme`
// is reused unmodified from `@x402/stellar` and isn't ours to extend).
// Channel accounts never need a SEP-41 trustline or token balance — fund
// them with a small amount of XLM only (they pay network fees, nothing
// else). Not required: omitting this env var falls back to the
// pre-channel-account behavior automatically.
const channelAccountSecrets = (process.env.STELLAR_CHANNEL_ACCOUNT_SECRETS ?? "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
const channelAccounts: FacilitatorStellarSigner[] = channelAccountSecrets.map(secret =>
  createEd25519Signer(secret, STELLAR_TESTNET_CAIP2),
);
if (channelAccounts.length > 0) {
  console.info(
    `Channel account address(es) for upto settlement: ${channelAccounts.map(s => s.address).join(", ")}`,
  );
}

for (const dbPath of [DISCOVERY_DB_PATH, BILLING_DB_PATH]) {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
}
const catalog = new BazaarCatalog(DISCOVERY_DB_PATH);
const billing = new BillingLedger(BILLING_DB_PATH);

const facilitator = new x402Facilitator()
  // Cataloging happens at both verify (provisional, per the protocol
  // "catalogs on receipt" trigger) and settle (confirmed, permanent) — see
  // "Automatic cataloging: provisional at receipt, confirmed at
  // settlement" in docs/architecture.md for why both stages matter and how
  // the provisional stage's TTL bounds the free-spam window a
  // settlement-blind trigger would otherwise have no defense against.
  .onAfterVerify(createBazaarVerifyPreviewHook(catalog))
  .onVerifyFailure(createBazaarFailureHook())
  .onAfterSettle(createBazaarCatalogingHook(catalog))
  .onAfterSettle(async context => {
    if (!context.result.success) return;
    const extra = context.requirements.extra as { feeBps?: number } | undefined;
    billing.record({
      payTo: context.requirements.payTo,
      scheme: context.requirements.scheme,
      network: context.requirements.network,
      feeBps: extra?.feeBps,
      amount: context.requirements.amount,
      // Makes a retried /settle call idempotent for billing too: a call
      // served from either upto scheme class's settlement cache still
      // re-fires this hook, but always with the same real transaction hash,
      // so BillingLedger.record's unique index turns the repeat into a no-op.
      transactionHash: context.result.transaction,
    });
  });

// Stellar's testnet has a free, unauthenticated public Soroban RPC baked
// into @x402/stellar as a default (DEFAULT_TESTNET_RPC_URL); mainnet has no
// equivalent — @x402/stellar's own `getRpcUrl` throws for stellar:pubnet
// unless an explicit provider URL is supplied (see
// https://developers.stellar.org/docs/data/apis/rpc/providers). `RpcConfig`
// is a single global `{ url }` override applied to *whichever* network a
// call happens to be for, not a per-network map — so a single scheme
// instance can't safely serve both networks once a pubnet URL is set (it
// would misroute testnet calls to the mainnet RPC too). Each scheme is
// therefore registered as two separate instances below, one per network,
// each carrying only the RPC config appropriate to that network. This
// mirrors the `signers` array above only in spirit — that array genuinely
// is shared across both networks (see the comment above), because Stellar
// signatures aren't network-scoped independently of the passphrase passed
// at signing time; RPC endpoints have no equivalent affordance.
const PUBNET_RPC_URL = process.env.STELLAR_PUBNET_RPC_URL;
const pubnetRpcConfig = PUBNET_RPC_URL ? { url: PUBNET_RPC_URL } : undefined;

facilitator.register([STELLAR_TESTNET_CAIP2], new ExactStellarScheme(signers));
if (pubnetRpcConfig) {
  facilitator.register(
    [STELLAR_PUBNET_CAIP2],
    new ExactStellarScheme(signers, { rpcConfig: pubnetRpcConfig }),
  );
} else {
  console.warn(
    "STELLAR_PUBNET_RPC_URL not set — stellar:pubnet is disabled for `exact`. Set it to a " +
      "mainnet Soroban RPC provider URL to enable pubnet settlement " +
      "(see https://developers.stellar.org/docs/data/apis/rpc/providers).",
  );
}

// `upto`/`managed upto` design selection. `escrow` (Design B,
// `contracts/upto-settlement-escrow`) is the default and primary path: no
// SEP-41 `approve` prerequisite, and the contract owns zero persistent
// on-chain state, keeping the default design stateless
// literally — see docs/architecture.md, "Design alternative considered".
// `allowance` (Design A, `contracts/upto-settlement`) remains fully
// implemented and tested, selectable for deployments that specifically need
// its `cancel`/`is_settled` on-chain capabilities, which the escrow design
// cannot offer (it has no contract storage to cancel or query). Only one
// design is ever registered at a time per network — `PaymentRequirements.extra
// .settlementContract` must be a single, canonical value for a given `upto`
// scheme/network, not one of two live options a client would have to guess
// between.
const uptoDesign = (process.env.UPTO_DESIGN ?? "escrow").trim().toLowerCase();
if (uptoDesign !== "escrow" && uptoDesign !== "allowance") {
  console.error(`UPTO_DESIGN must be "escrow" or "allowance", got: ${uptoDesign}`);
  process.exit(1);
}

if (uptoDesign === "escrow") {
  const testnetEscrowContract = process.env.UPTO_ESCROW_SETTLEMENT_CONTRACT_TESTNET;
  if (testnetEscrowContract) {
    facilitator.register(
      [STELLAR_TESTNET_CAIP2],
      new UptoStellarEscrowScheme(
        signers,
        { [STELLAR_TESTNET_CAIP2]: testnetEscrowContract },
        channelAccounts.length > 0 ? { channelAccounts } : undefined,
      ),
    );
  } else {
    console.warn(
      "UPTO_ESCROW_SETTLEMENT_CONTRACT_TESTNET not configured — the `upto` scheme (standard and " +
        "managed) is disabled on testnet. Deploy contracts/upto-settlement-escrow to enable it, " +
        "or set UPTO_DESIGN=allowance to use contracts/upto-settlement instead.",
    );
  }

  const pubnetEscrowContract = process.env.UPTO_ESCROW_SETTLEMENT_CONTRACT_PUBNET;
  if (pubnetEscrowContract && pubnetRpcConfig) {
    facilitator.register(
      [STELLAR_PUBNET_CAIP2],
      new UptoStellarEscrowScheme(
        signers,
        { [STELLAR_PUBNET_CAIP2]: pubnetEscrowContract },
        { rpcConfig: pubnetRpcConfig, ...(channelAccounts.length > 0 ? { channelAccounts } : {}) },
      ),
    );
  } else if (pubnetEscrowContract && !pubnetRpcConfig) {
    console.warn(
      "UPTO_ESCROW_SETTLEMENT_CONTRACT_PUBNET is set but STELLAR_PUBNET_RPC_URL is not — `upto` " +
        "on pubnet stays disabled until an RPC URL is configured.",
    );
  }
} else {
  const testnetUptoContract = process.env.UPTO_SETTLEMENT_CONTRACT_TESTNET;
  if (testnetUptoContract) {
    facilitator.register(
      [STELLAR_TESTNET_CAIP2],
      new UptoStellarScheme(
        signers,
        { [STELLAR_TESTNET_CAIP2]: testnetUptoContract },
        channelAccounts.length > 0 ? { channelAccounts } : undefined,
      ),
    );
  } else {
    console.warn(
      "UPTO_SETTLEMENT_CONTRACT_TESTNET not configured — the `upto` scheme (standard and managed) " +
        "is disabled on testnet. Deploy contracts/upto-settlement to enable it.",
    );
  }

  const pubnetUptoContract = process.env.UPTO_SETTLEMENT_CONTRACT_PUBNET;
  if (pubnetUptoContract && pubnetRpcConfig) {
    facilitator.register(
      [STELLAR_PUBNET_CAIP2],
      new UptoStellarScheme(
        signers,
        { [STELLAR_PUBNET_CAIP2]: pubnetUptoContract },
        { rpcConfig: pubnetRpcConfig, ...(channelAccounts.length > 0 ? { channelAccounts } : {}) },
      ),
    );
  } else if (pubnetUptoContract && !pubnetRpcConfig) {
    console.warn(
      "UPTO_SETTLEMENT_CONTRACT_PUBNET is set but STELLAR_PUBNET_RPC_URL is not — `upto` on " +
        "pubnet stays disabled until an RPC URL is configured.",
    );
  }
}

const activeNetworks: Network[] = pubnetRpcConfig
  ? [STELLAR_TESTNET_CAIP2, STELLAR_PUBNET_CAIP2]
  : [STELLAR_TESTNET_CAIP2];

// Cheap TTL cache for signer XLM balances (GET /metrics's most operationally
// important signal — see docs/runbook.md "Monitoring"): a depleted signer
// silently stops all settlements, but that's not a sub-30-second emergency,
// so a little staleness under repeated scraping is an acceptable trade for
// not hammering Horizon on every request.
const BALANCE_CACHE_TTL_MS = 30_000;
let balanceCache: { fetchedAt: number; samples: MetricSample[] } | null = null;

async function collectSignerBalances(): Promise<MetricSample[]> {
  if (balanceCache && Date.now() - balanceCache.fetchedAt < BALANCE_CACHE_TTL_MS) {
    return balanceCache.samples;
  }
  const samples: MetricSample[] = [];
  for (const network of activeNetworks) {
    const horizon = getHorizonClient(network);
    for (const signer of signers) {
      try {
        const account = await horizon.loadAccount(signer.address);
        const native = account.balances.find(b => b.asset_type === "native");
        samples.push({
          labels: { network, address: signer.address },
          value: native ? Number(native.balance) : 0,
        });
      } catch (error) {
        // Most commonly an unfunded signer account (404) on a network it
        // hasn't been used on yet — skip that sample rather than failing
        // the whole /metrics response over one signer/network combination.
        console.error(`metrics: failed to load balance for ${signer.address} on ${network}:`, error);
      }
    }
  }
  balanceCache = { fetchedAt: Date.now(), samples };
  return samples;
}

function setExtensionResponsesHeader(res: Response, paymentPayload?: PaymentPayload): void {
  const status = paymentPayload ? getBazaarExtensionStatus(paymentPayload) : undefined;
  const body: Record<string, unknown> = status
    ? { bazaar: { status: status.status, ...(status.rejectedReason && { rejectedReason: status.rejectedReason }) } }
    : { bazaar: { status: "processing" } };
  res.setHeader(EXTENSION_RESPONSES_HEADER, Buffer.from(JSON.stringify(body), "utf8").toString("base64"));
}

const app: express.Express = express();
// 64kb comfortably covers a real PaymentPayload/PaymentRequirements body
// (witness auth entries are a few hundred bytes base64-encoded) while
// bounding the cost of an unauthenticated caller sending an oversized one —
// /verify and /settle are necessarily public per the x402 protocol itself
// (any resource server must be able to call a facilitator with no prior
// registration), so this is the cheap, protocol-compatible mitigation
// available at this layer. See docs/architecture.md "Scope boundaries" for
// what's deliberately not added here (seller auth, rate limiting).
app.use(express.json({ limit: "64kb" }));

app.post("/verify", async (req: Request, res: Response) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body as {
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    };
    if (!paymentPayload || !paymentRequirements) {
      res.status(400).json({ error: "Missing paymentPayload or paymentRequirements" });
      return;
    }
    const response = await facilitator.verify(paymentPayload, paymentRequirements);
    setExtensionResponsesHeader(res, paymentPayload);
    res.json(response);
  } catch (error) {
    console.error("verify error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

app.post("/settle", async (req: Request, res: Response) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body as {
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    };
    if (!paymentPayload || !paymentRequirements) {
      res.status(400).json({ error: "Missing paymentPayload or paymentRequirements" });
      return;
    }
    const response = await facilitator.settle(paymentPayload, paymentRequirements);
    setExtensionResponsesHeader(res, paymentPayload);
    res.json(response);
  } catch (error) {
    console.error("settle error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

app.get("/supported", (_req: Request, res: Response) => {
  try {
    res.json(facilitator.getSupported());
  } catch (error) {
    console.error("supported error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

app.use("/discovery", createDiscoveryRouter(catalog));

app.get("/billing/usage", (req: Request, res: Response) => {
  if (BILLING_ADMIN_TOKEN && req.header("X-Billing-Admin-Token") !== BILLING_ADMIN_TOKEN) {
    res.status(401).json({ error: "Missing or invalid X-Billing-Admin-Token" });
    return;
  }
  const payTo = req.query.payTo;
  if (typeof payTo !== "string") {
    res.status(400).json({ error: "payTo query parameter is required" });
    return;
  }
  // `period` matches whatever cadence (day/month/year) that seller's own
  // billing plan uses — see `BillingLedger.planFor`/`SellerBillingPlan`.
  const period = typeof req.query.period === "string" ? req.query.period : undefined;
  res.json(billing.computeUsage(payTo, period));
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

app.get("/metrics", async (_req: Request, res: Response) => {
  try {
    const settlementCounts = billing.settlementCountsByGroup();
    const catalogTotal = (await catalog.list({ limit: 1 })).pagination.total;
    const signerBalances = await collectSignerBalances();

    const families: MetricFamily[] = [
      {
        name: "facilitator_up",
        help: "Always 1 while the process is running.",
        type: "gauge",
        samples: [{ value: 1 }],
      },
      {
        name: "facilitator_signer_balance_xlm",
        help: "Native XLM balance of a facilitator signer account, per network. A depleted " +
          "signer silently stops all settlements on that network — alert well before zero.",
        type: "gauge",
        samples: signerBalances,
      },
      {
        name: "facilitator_settlements_total",
        help: "Successful settlements processed since this database was created, by scheme and network.",
        type: "counter",
        samples: settlementCounts.map(g => ({
          labels: { scheme: g.scheme, network: g.network },
          value: g.count,
        })),
      },
      {
        name: "facilitator_discovery_resources_total",
        help: "Number of resources currently in the Bazaar catalog.",
        type: "gauge",
        samples: [{ value: catalogTotal }],
      },
    ];

    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.send(formatPrometheusMetrics(families));
  } catch (error) {
    console.error("metrics error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

app.listen(PORT, () => {
  console.log(`x402 Stellar facilitator listening on http://localhost:${PORT}`);
  console.log(`  Supported: ${facilitator.getSupported().kinds.map(k => `${k.scheme}/${k.network}`).join(", ")}`);
  console.log(`  Discovery: GET /discovery/resources, GET /discovery/search`);
  console.log(`  Monitoring: GET /health, GET /metrics`);
});

export { app, facilitator, catalog, billing };
