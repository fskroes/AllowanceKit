import type { IncomingMessage, ServerResponse } from "node:http";
import type { Facilitator } from "./chain.ts";
import type { AcceptsEntry, DecodedPayment, PaymentRequiredBody } from "./types.ts";
import { flatAmount, payeeOf } from "./types.ts";
import { NETWORKS, family } from "./live.ts";
import { solanaNetworkInfo, normalizeSolanaKey } from "./solana.ts";
import {
  advertiseUptoOffer,
  createSolanaUptoOperator,
  uptoPaymentGate,
  type BeforeServeDecision,
  type BeforeServeInfo,
  type Meter,
  type UptoGateOptions,
  type UptoOperator,
} from "./seller-upto.ts";

/**
 * The self-facilitated `upto` scheme this gate also advertises for a Solana
 * network (docs/SOLANA-ARCHITECTURE.md §4.4). Give a ceiling and either a ready
 * `operator` (tests/demo) or `solanaOperator` env-var names (production), and
 * the gate lists a metered `upto` offer beside `exact` and settles a channel
 * per request.
 */
export interface UptoConfig {
  /** The authorised ceiling a buyer deposits, micro-dollars. */
  ceilingMicro: bigint;
  /** Channel `grace_period` in seconds (the payer's reclaim wait). Default 900. */
  withdrawDelay?: number;
  /** The offer's `maxTimeoutSeconds` and voucher-expiry ceiling. Default 300. */
  maxTimeoutSeconds?: number;
  /** A ready operator (tests/demo). Omit to build one from {@link GateOptions.solanaOperator}. */
  operator?: UptoOperator;
  /** Policy hook between the deposit and the handler; abort refunds the deposit. */
  beforeServe?: (info: BeforeServeInfo) => BeforeServeDecision | Promise<BeforeServeDecision>;
}

/** Self-facilitation keys by env-var name (never values). Read once, never stored. */
export interface SolanaOperatorEnv {
  /** Env var holding the feePayer secret (SOL for fees/rent, channel payee). */
  feePayerKeyEnv: string;
  /** Env var holding the receiver-authorizer secret (voucher signer). */
  receiverAuthorizerKeyEnv: string;
  rpcUrl?: string;
  maxChannelLifetimeSecs?: number;
  /** Durable seller cleanup index. Default ALLOWANCE_SELLER_STATE_DIR or .allowance-seller. */
  stateDir?: string;
  cleanupIntervalSecs?: number | false;
}

export interface GateOptions {
  priceMicro: bigint;
  description: string;
  payTo: string;
  facilitator: Facilitator;
  /** e.g. "mock-ledger", "base-sepolia", "base", or a Solana id ("solana", "solana-devnet", CAIP-2). */
  network?: string;
  /** Advertise a metered `upto` offer too (Solana only). */
  upto?: UptoConfig;
  /** Build the `upto` operator from these env-var names when `upto.operator` is absent. */
  solanaOperator?: SolanaOperatorEnv;
}

/** A protected handler; the optional `meter` is passed only on the `upto` path. */
export type GateHandler = (req: IncomingMessage, res: ServerResponse, meter?: Meter) => void | Promise<void>;

/**
 * The x402 protocol version the gate advertises for a network. EVM stays v1 so
 * the Base 402 body is byte-identical to what it always emitted. Solana `exact`
 * is a v2-era scheme (CAIP-2 network, mint asset, an unsigned fee-payer slot),
 * so a Solana gate advertises v2.
 */
function versionFor(network: string): number {
  return family(network) === "solana" ? 2 : 1;
}

/**
 * The offers this gate advertises for `resource`. Returned as an array because a
 * v2 seller may list several and the buyer's `selectOffer` takes a list; a gate
 * is single-network today, so the array holds one offer.
 *
 * EVM: the asset is the USDC contract address and `extra` carries that
 * contract's exact EIP-712 domain — facilitators reconstruct the signing domain
 * from these and reject any mismatch.
 *
 * Solana: the asset is the USDC mint, the network is the canonical CAIP-2 id
 * (so the facilitator's v2 body carries CAIP-2, whatever alias the caller
 * passed), and `extra.feePayer` is the facilitator's fee payer from
 * `/supported` — left unsigned for the buyer to build its transaction around.
 * There is no EIP-712 `extra` on this rail.
 */
async function advertise(opts: GateOptions, resource: string): Promise<AcceptsEntry[]> {
  const network = opts.network ?? "mock-ledger";

  if (family(network) === "solana") {
    const sinfo = solanaNetworkInfo(network)!;
    const feePayer = await solanaFeePayer(opts.facilitator, network);
    return [{
      scheme: "exact",
      network: sinfo.caip2,
      maxAmountRequired: opts.priceMicro.toString(),
      resource,
      description: opts.description,
      mimeType: "application/json",
      payTo: opts.payTo,
      asset: sinfo.mint,
      maxTimeoutSeconds: 30,
      extra: feePayer ? { feePayer } : {},
    }];
  }

  const info = NETWORKS[network];
  return [{
    scheme: "exact",
    network,
    maxAmountRequired: opts.priceMicro.toString(),
    resource,
    description: opts.description,
    mimeType: "application/json",
    payTo: opts.payTo,
    asset: info?.usdc ?? "USDC",
    maxTimeoutSeconds: 30,
    extra: info ? { name: info.domainName, version: info.domainVersion } : { name: "USDC", version: "1" },
  }];
}

/**
 * The facilitator's fee payer for a Solana network, read from its x402 v2
 * `/supported` advertisement. `undefined` when the facilitator has no
 * `/supported` (e.g. the mock ledger) or lists no matching Solana `exact` kind —
 * the offer then carries no feePayer and the buyer's encoder fails loudly rather
 * than signing a one-signature transaction the facilitator cannot co-pay.
 */
async function solanaFeePayer(fac: Facilitator, network: string): Promise<string | undefined> {
  if (!fac.supported) return undefined;
  const sinfo = solanaNetworkInfo(network)!;
  const kinds = await fac.supported();
  const match = kinds.find(
    (k) => k.scheme === "exact" && (k.network === sinfo.caip2 || k.network === sinfo.v1Name),
  );
  return match?.extra?.feePayer;
}

/**
 * The scheme of a decoded x402 payment: `payload.accepted.scheme` (v2 envelope)
 * or the top-level `payload.scheme` (v1). Used to route an `upto` payment to the
 * self-facilitated channel gate.
 */
function schemeOf(payload: DecodedPayment): string | undefined {
  const accepted = payload.accepted as { scheme?: unknown } | undefined;
  if (accepted && typeof accepted.scheme === "string") return accepted.scheme;
  return typeof payload.scheme === "string" ? payload.scheme : undefined;
}

export function paymentGate(opts: GateOptions, handler: GateHandler) {
  const network = opts.network ?? "mock-ledger";
  const isSolana = family(network) === "solana";
  const version = versionFor(network);
  const uptoEnabled = Boolean(opts.upto) && isSolana;

  // Build the operator once. Configured Solana sellers start it at boot so
  // persisted cleanup runs even if no new buyer arrives after a restart.
  // Other networks and gates without upto never load a Solana library.
  let uptoGate: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined;
  let uptoOptions: UptoGateOptions | undefined;
  let uptoBuild: Promise<UptoGateOptions> | undefined;

  const buildUpto = async (): Promise<UptoGateOptions> => {
    const cfg = opts.upto!;
    let operator = cfg.operator;
    if (!operator) {
      if (!opts.solanaOperator)
        throw new Error("upto gate needs either `upto.operator` or `solanaOperator` env-var names");
      const { feePayerKeyEnv, receiverAuthorizerKeyEnv, rpcUrl, maxChannelLifetimeSecs, stateDir, cleanupIntervalSecs } = opts.solanaOperator;
      const feeRaw = process.env[feePayerKeyEnv]?.trim();
      const authRaw = process.env[receiverAuthorizerKeyEnv]?.trim();
      if (!feeRaw) throw new Error(`${feePayerKeyEnv} is not set — the upto feePayer key`);
      if (!authRaw) throw new Error(`${receiverAuthorizerKeyEnv} is not set — the upto receiver-authorizer key`);
      operator = await createSolanaUptoOperator({
        network,
        feePayerSecret: normalizeSolanaKey(feeRaw),
        receiverAuthorizerSecret: normalizeSolanaKey(authRaw),
        rpcUrl,
        withdrawDelay: cfg.withdrawDelay,
        maxChannelLifetimeSecs,
        stateDir,
        cleanupIntervalSecs,
      });
    }
    return {
      ceilingMicro: cfg.ceilingMicro,
      description: opts.description,
      payTo: opts.payTo,
      network,
      operator,
      handler,
      withdrawDelay: cfg.withdrawDelay,
      maxTimeoutSeconds: cfg.maxTimeoutSeconds,
      beforeServe: cfg.beforeServe,
    };
  };

  const ensureUpto = async (): Promise<UptoGateOptions> => {
    if (uptoOptions) return uptoOptions;
    if (!uptoBuild) uptoBuild = buildUpto();
    uptoOptions = await uptoBuild;
    uptoGate ??= uptoPaymentGate(uptoOptions);
    return uptoOptions;
  };

  if (uptoEnabled && opts.solanaOperator && !opts.upto?.operator) {
    // Preserve the exact-only fallback for bad upto configuration; callers can
    // await ready() during startup when upto availability is required.
    void ensureUpto().catch(() => undefined);
  }

  const allOffers = async (resource: string): Promise<AcceptsEntry[]> => {
    const offers = await advertise(opts, resource);
    if (uptoEnabled) {
      try {
        offers.push(await advertiseUptoOffer(await ensureUpto(), resource));
      } catch {
        // A misconfigured operator must not blank the exact 402; list exact only.
      }
    }
    return offers;
  };

  const serve = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const host = req.headers.host ?? "localhost";
    const resource = `http://${host}${req.url ?? "/"}`;
    const header = req.headers["x-payment"];

    if (typeof header !== "string" || !header) {
      const body: PaymentRequiredBody = {
        x402Version: version,
        error: "X-PAYMENT header is required",
        accepts: await allOffers(resource),
      };
      res.writeHead(402, { "Content-Type": "application/json", "Accept": "application/json" });
      res.end(JSON.stringify(body, null, 2));
      return;
    }

    let payload: DecodedPayment;
    try {
      payload = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as DecodedPayment;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "malformed X-PAYMENT header" }));
      return;
    }

    // An `upto` payment goes to the self-facilitated channel gate: open the
    // deposit, run the handler with a meter, settle the metered amount.
    if (uptoEnabled && schemeOf(payload) === "upto") {
      try {
        await ensureUpto();
      } catch (e) {
        res.writeHead(402, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ x402Version: 2, error: `upto gate unavailable: ${e instanceof Error ? e.message : String(e)}`, accepts: [] }));
        return;
      }
      await uptoGate!(req, res);
      return;
    }

    // Local sanity check before hitting the facilitator; works for the flat mock
    // shape and the nested x402 v1 EVM shape. A Solana payment hides its amount
    // and payee inside the signed v0 transaction — there is nothing to read from
    // JSON here, so the facilitator verifies the transfer's amount and
    // destination instead.
    let presented: string | null = null;
    if (!isSolana) {
      presented = flatAmount(payload);
      const payee = payeeOf(payload);
      if (presented === null || BigInt(presented) !== opts.priceMicro || payee !== opts.payTo) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "payment payload does not match advertised price/payee" }));
        return;
      }
    }

    const requirements = (await advertise(opts, resource))[0];
    const verification = await opts.facilitator.verify(payload, requirements);
    if (!verification.isValid) {
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ x402Version: version, error: `payment rejected: ${verification.invalidReason}`, accepts: [] }));
      return;
    }

    const settlement = await opts.facilitator.settle(payload, requirements);
    if (!settlement.success) {
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ x402Version: version, error: `settlement failed: ${settlement.error}`, accepts: [] }));
      return;
    }

    res.setHeader("X-PAYMENT-RESPONSE", Buffer.from(
      JSON.stringify({ success: true, network: settlement.network, txHash: settlement.txHash, amountMicro: presented ?? opts.priceMicro.toString() }),
    ).toString("base64"));
    await handler(req, res);
  };

  let stopped = false;
  let stopPromise: Promise<void> | undefined;
  const inFlight = new Set<Promise<void>>();
  return Object.assign((req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (stopped) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "seller is shutting down" }));
      return Promise.resolve();
    }
    const request = serve(req, res);
    inFlight.add(request);
    void request.then(() => inFlight.delete(request), () => inFlight.delete(request));
    return request;
  }, {
    /** Initialize the configured upto operator before accepting HTTP traffic. */
    async ready(): Promise<void> {
      if (stopped) throw new Error("seller is shutting down");
      if (uptoEnabled) await ensureUpto();
    },
    /** Stop accepting payments, drain handlers, then stop the library cleanup worker. */
    stop(): Promise<void> {
      stopped = true;
      stopPromise ??= (async () => {
        await Promise.allSettled(inFlight);
        const built = uptoOptions ?? await uptoBuild?.catch(() => undefined);
        await built?.operator.stop?.();
      })();
      return stopPromise;
    },
  });
}
