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

export interface UptoConfig {
  ceilingMicro: bigint;
  withdrawDelay?: number;
  maxTimeoutSeconds?: number;
  operator?: UptoOperator;
  beforeServe?: (info: BeforeServeInfo) => BeforeServeDecision | Promise<BeforeServeDecision>;
}

export interface SolanaOperatorEnv {
  feePayerKeyEnv: string;
  receiverAuthorizerKeyEnv: string;
  rpcUrl?: string;
  maxChannelLifetimeSecs?: number;
  stateDir?: string;
  cleanupIntervalSecs?: number | false;
}

export interface GateOptions {
  priceMicro: bigint;
  description: string;
  payTo: string;
  facilitator: Facilitator;
  network?: string;
  upto?: UptoConfig;
  solanaOperator?: SolanaOperatorEnv;
}

export type GateHandler = (req: IncomingMessage, res: ServerResponse, meter?: Meter) => void | Promise<void>;

function versionFor(network: string): number {
  return family(network) === "solana" ? 2 : 1;
}

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

async function solanaFeePayer(fac: Facilitator, network: string): Promise<string | undefined> {
  if (!fac.supported) return undefined;
  const sinfo = solanaNetworkInfo(network)!;
  const kinds = await fac.supported();
  const match = kinds.find(
    (k) => k.scheme === "exact" && (k.network === sinfo.caip2 || k.network === sinfo.v1Name),
  );
  return match?.extra?.feePayer;
}

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
    void ensureUpto().catch(() => undefined);
  }

  const allOffers = async (resource: string): Promise<AcceptsEntry[]> => {
    const offers = await advertise(opts, resource);
    if (uptoEnabled) {
      try {
        offers.push(await advertiseUptoOffer(await ensureUpto(), resource));
      } catch {
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
    async ready(): Promise<void> {
      if (stopped) throw new Error("seller is shutting down");
      if (uptoEnabled) await ensureUpto();
    },
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
