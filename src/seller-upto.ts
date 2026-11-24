import type { IncomingMessage, ServerResponse } from "node:http";
import { base58Encode, looksLikeAddress } from "./base58.ts";
import { solanaNetworkInfo, solanaSigner } from "./solana.ts";
import { signVoucher } from "./voucher.ts";
import { offerAmount, offerAsset, offerPayTo } from "./types.ts";
import type { AcceptsEntry, UptoPayload } from "./types.ts";
import { RpcError } from "./usdc.ts";
import { SellerChannelStorage } from "./seller-channels.ts";
import { sellerCleanupSigner, type CleanupSigner } from "./seller-cleanup.ts";

const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

export const DEFAULT_WITHDRAW_DELAY = 900;

export const PAYMENT_CHANNELS_TREASURY_OWNER = "Cs2zdfUNonRdRGsiZUQQLdTxzxVvJZmgiX2mpLYKuEqP";

export class Meter {
  #charged = 0n;
  readonly ceilingMicro: bigint;

  constructor(ceilingMicro: bigint) {
    if (ceilingMicro < 0n) throw new Error(`meter ceiling cannot be negative, got ${ceilingMicro}`);
    this.ceilingMicro = ceilingMicro;
  }

  charge(micro: bigint): void {
    if (micro < 0n) throw new Error(`meter.charge amount cannot be negative, got ${micro}`);
    this.#charged += micro;
  }

  get settledMicro(): bigint {
    return this.#charged > this.ceilingMicro ? this.ceilingMicro : this.#charged;
  }

  get chargedMicro(): bigint {
    return this.#charged;
  }
}

export interface UptoPaymentEnvelope {
  x402Version: number;
  accepted: AcceptsEntry;
  payload: UptoPayload;
}

export interface DepositOutcome {
  channelId: string;
  depositMicro: bigint;
  expiresAt: bigint;
  txHash?: string;
  openSlot?: number;
  payer?: string;
  payee?: string;
  authorizedSigner?: string;
  mint?: string;
}

export interface ClaimOutcome {
  txHash?: string;
  settledMicro: bigint;
}

export interface OfferExtraInput {
  network: string;
  mint: string;
  payTo: string;
  withdrawDelay: number;
  maxTimeoutSeconds: number;
}

export interface UptoOperator {
  offerExtra(input: OfferExtraInput): Promise<Record<string, unknown>>;
  openDeposit(env: UptoPaymentEnvelope): Promise<DepositOutcome>;
  settleClaim(env: UptoPaymentEnvelope, actualMicro: bigint): Promise<ClaimOutcome>;
  stop?(): Promise<void>;
}

export interface BeforeServeInfo {
  channelId: string;
  payer: string;
  ceilingMicro: bigint;
  depositMicro: bigint;
  url: string;
  host: string;
  network: string;
}

export type BeforeServeDecision = { abort: false } | { abort: true; reason?: string };

export type UptoHandler = (req: IncomingMessage, res: ServerResponse, meter: Meter) => void | Promise<void>;

export interface UptoGateOptions {
  ceilingMicro: bigint;
  description: string;
  payTo: string;
  network: string;
  operator: UptoOperator;
  handler: UptoHandler;
  withdrawDelay?: number;
  maxTimeoutSeconds?: number;
  beforeServe?: (info: BeforeServeInfo) => BeforeServeDecision | Promise<BeforeServeDecision>;
  dedupTtlMs?: number;
  now?: () => number;
}

const EXPIRY_SKEW_SECONDS = 60;

export async function advertiseUptoOffer(opts: UptoGateOptions, resource: string): Promise<AcceptsEntry> {
  const info = solanaNetworkInfo(opts.network);
  if (!info) throw new Error(`upto gate needs a Solana network, got "${opts.network}"`);
  const withdrawDelay = opts.withdrawDelay ?? DEFAULT_WITHDRAW_DELAY;
  const maxTimeoutSeconds = opts.maxTimeoutSeconds ?? 300;
  const extra = await opts.operator.offerExtra({
    network: opts.network,
    mint: info.mint,
    payTo: opts.payTo,
    withdrawDelay,
    maxTimeoutSeconds,
  });
  return {
    scheme: "upto",
    network: info.caip2,
    amount: opts.ceilingMicro.toString(),
    maxAmountRequired: opts.ceilingMicro.toString(),
    resource,
    description: opts.description,
    mimeType: "application/json",
    payTo: opts.payTo,
    asset: info.mint,
    maxTimeoutSeconds,
    extra,
  };
}

class BufferingResponse {
  statusCode = 200;
  private headers: Record<string, string> = {};
  private chunks: string[] = [];

  setHeader(k: string, v: string | number): void {
    this.headers[k.toLowerCase()] = String(v);
  }
  getHeader(k: string): string | undefined {
    return this.headers[k.toLowerCase()];
  }
  removeHeader(k: string): void {
    delete this.headers[k.toLowerCase()];
  }
  writeHead(status: number, headers?: Record<string, string>): this {
    this.statusCode = status;
    for (const [k, v] of Object.entries(headers ?? {})) this.setHeader(k, v);
    return this;
  }
  write(chunk: string | Buffer): boolean {
    this.chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }
  end(chunk?: string | Buffer): void {
    if (chunk !== undefined) this.write(chunk);
  }

  flushTo(res: ServerResponse, extra: Record<string, string>): void {
    res.writeHead(this.statusCode, { ...this.headers, ...lowerKeys(extra) });
    res.end(this.chunks.join(""));
  }
}

function lowerKeys(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

export function uptoPaymentGate(opts: UptoGateOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const info = solanaNetworkInfo(opts.network);
  if (!info) throw new Error(`upto gate needs a Solana network, got "${opts.network}"`);
  const maxTimeoutSeconds = opts.maxTimeoutSeconds ?? 300;
  const dedupTtlMs = opts.dedupTtlMs ?? 120_000;
  const now = opts.now ?? Date.now;

  const seen = new Map<string, number>();
  const prune = (t: number) => {
    for (const [id, exp] of seen) if (t >= exp) seen.delete(id);
  };

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const host = req.headers.host ?? "localhost";
    const resource = `http://${host}${req.url ?? "/"}`;
    const header = req.headers["x-payment"];

    if (typeof header !== "string" || !header) {
      return send402(res, opts, resource, "X-PAYMENT header is required");
    }

    let env: UptoPaymentEnvelope;
    try {
      const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as UptoPaymentEnvelope;
      if (!decoded || typeof decoded !== "object" || !decoded.accepted || !decoded.payload) throw new Error("shape");
      env = decoded;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "malformed X-PAYMENT header" }));
      return;
    }

    const echo = checkEcho(env.accepted, opts, info);
    if (echo) return send402(res, opts, resource, echo);

    const p = env.payload;
    const t = now();
    const nowSec = Math.floor(t / 1000);
    const payloadError = checkPayload(p, opts.ceilingMicro, nowSec, maxTimeoutSeconds);
    if (payloadError) return send402(res, opts, resource, payloadError);

    prune(t);
    if (seen.has(p.channelId)) {
      return send402(res, opts, resource, `channel ${p.channelId} was already presented — a replayed deposit is rejected`);
    }
    seen.set(p.channelId, t + dedupTtlMs);

    let deposit: DepositOutcome;
    try {
      deposit = await opts.operator.openDeposit(env);
    } catch (e) {
      seen.delete(p.channelId);
      return send402(res, opts, resource, `deposit failed: ${errMsg(e)}`);
    }
    seen.set(p.channelId, now() + dedupTtlMs);

    if (opts.beforeServe) {
      let decision: BeforeServeDecision;
      try {
        decision = await opts.beforeServe({
          channelId: p.channelId,
          payer: p.from,
          ceilingMicro: opts.ceilingMicro,
          depositMicro: deposit.depositMicro,
          url: resource,
          host,
          network: opts.network,
        });
      } catch (e) {
        decision = { abort: true, reason: `policy hook error: ${errMsg(e)}` };
      }
      if (decision.abort) {
        const refund = await tryRefund(opts.operator, env);
        const base = `blocked by seller policy${decision.reason ? `: ${decision.reason}` : ""}`;
        return sendSettled(res, 402, {
          success: false,
          error: refund.ok ? base : `${base}; refund failed — deposit is reclaimable: ${refund.error}`,
          network: info.caip2,
          channelId: p.channelId,
          amount: "0",
          amountMicro: "0",
          depositMicro: deposit.depositMicro.toString(),
          refundMicro: refund.ok ? deposit.depositMicro.toString() : "0",
          transaction: refund.ok ? refund.txHash : undefined,
        });
      }
    }

    const meter = new Meter(opts.ceilingMicro);
    const buffered = new BufferingResponse();
    let handlerThrew: unknown;
    try {
      await opts.handler(req, buffered as unknown as ServerResponse, meter);
    } catch (e) {
      handlerThrew = e;
    }

    if (handlerThrew !== undefined) {
      const refund = await tryRefund(opts.operator, env);
      return sendSettled(res, 502, {
        success: false,
        error: refund.ok
          ? `handler failed; deposit refunded: ${errMsg(handlerThrew)}`
          : `handler failed and refund failed — deposit is reclaimable: ${errMsg(handlerThrew)}; ${refund.error}`,
        network: info.caip2,
        channelId: p.channelId,
        amount: "0",
        amountMicro: "0",
        depositMicro: deposit.depositMicro.toString(),
        refundMicro: refund.ok ? deposit.depositMicro.toString() : "0",
        transaction: refund.ok ? refund.txHash : undefined,
      });
    }

    const actual = meter.settledMicro;
    let claim: ClaimOutcome;
    try {
      claim = await opts.operator.settleClaim(env, actual);
    } catch (e) {
      return sendSettled(res, 502, {
        success: false,
        error: `settlement failed after deposit — deposit is reclaimable: ${errMsg(e)}`,
        network: info.caip2,
        channelId: p.channelId,
        amount: "0",
        amountMicro: "0",
        depositMicro: deposit.depositMicro.toString(),
        refundMicro: "0",
        transaction: undefined,
      });
    }

    const refundMicro = deposit.depositMicro - claim.settledMicro;
    const responseHeader = Buffer.from(
      JSON.stringify({
        success: true,
        network: info.caip2,
        txHash: claim.txHash,
        transaction: claim.txHash,
        amount: claim.settledMicro.toString(),
        amountMicro: claim.settledMicro.toString(),
        channelId: p.channelId,
        depositMicro: deposit.depositMicro.toString(),
        refundMicro: refundMicro.toString(),
      }),
    ).toString("base64");

    buffered.flushTo(res, { "X-PAYMENT-RESPONSE": responseHeader });
  };
}

async function tryRefund(
  operator: UptoOperator,
  env: UptoPaymentEnvelope,
): Promise<{ ok: true; txHash?: string } | { ok: false; error: string }> {
  try {
    const out = await operator.settleClaim(env, 0n);
    return { ok: true, txHash: out.txHash };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

function checkEcho(
  accepted: AcceptsEntry,
  opts: UptoGateOptions,
  info: NonNullable<ReturnType<typeof solanaNetworkInfo>>,
): string | undefined {
  if (accepted.scheme !== "upto") return "the presented payment is not an `upto` payment";
  const acceptedInfo = solanaNetworkInfo(accepted.network);
  if (!acceptedInfo || acceptedInfo.caip2 !== info.caip2)
    return `offered network ${accepted.network} does not match this seller's ${info.caip2}`;
  if (offerAsset(accepted) !== info.mint) return "offered asset is not this seller's USDC mint";
  if (offerPayTo(accepted) !== opts.payTo) return "offered payTo does not match this seller";
  if (offerAmount(accepted) !== opts.ceilingMicro.toString())
    return `offered ceiling ${offerAmount(accepted)} does not match this seller's ${opts.ceilingMicro}`;
  return undefined;
}

function checkPayload(p: UptoPayload, ceilingMicro: bigint, nowSec: number, maxTimeoutSeconds: number): string | undefined {
  if (typeof p.channelId !== "string" || !looksLikeAddress(p.channelId)) return "payload has no valid channelId";
  if (typeof p.from !== "string" || !p.from) return "payload has no payer `from`";
  let maxAmount: bigint;
  try {
    maxAmount = BigInt(p.maxAmount);
  } catch {
    return "payload `maxAmount` is not an integer";
  }
  if (maxAmount !== ceilingMicro) return `payload ceiling ${maxAmount} does not match the offer ${ceilingMicro}`;
  if (p.deposit === undefined) return "payload has no `deposit` — an upto deposit must escrow the full ceiling";
  let deposit: bigint;
  try {
    deposit = BigInt(p.deposit);
  } catch {
    return "payload `deposit` is not an integer";
  }
  if (deposit !== maxAmount) return `deposit ${deposit} must equal the ceiling ${maxAmount}`;
  if (typeof p.openTransaction !== "string" || !p.openTransaction) return "payload has no `openTransaction`";
  if (typeof p.expiresAt !== "number" || !Number.isFinite(p.expiresAt) || p.expiresAt <= 0)
    return "payload `expiresAt` must be a non-zero unix timestamp";
  if (p.expiresAt <= nowSec) return "payload `expiresAt` is in the past";
  if (p.expiresAt > nowSec + maxTimeoutSeconds + EXPIRY_SKEW_SECONDS)
    return `payload expiresAt exceeds maxTimeoutSeconds (${maxTimeoutSeconds}s)`;
  return undefined;
}

async function send402(
  res: ServerResponse,
  opts: UptoGateOptions,
  resource: string,
  error: string,
): Promise<void> {
  const body = {
    x402Version: 2,
    error,
    accepts: [await advertiseUptoOffer(opts, resource)],
  };
  res.writeHead(402, { "Content-Type": "application/json", Accept: "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

function sendSettled(res: ServerResponse, status: number, resp: Record<string, unknown>): void {
  res.setHeader("X-PAYMENT-RESPONSE", Buffer.from(JSON.stringify(resp)).toString("base64"));
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: resp.error ?? "payment not accepted", channelId: resp.channelId }));
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface InMemoryUptoOperatorOptions {
  feePayer?: string;
  receiverAuthorizer?: string;
}

export class InMemoryUptoOperator implements UptoOperator {
  readonly feePayer: string;
  readonly receiverAuthorizer: string;
  readonly channels = new Map<string, { depositMicro: bigint; status: "open" | "sealed"; settledMicro: bigint }>();
  readonly calls = { offerExtra: 0, deposit: 0, claim: 0 };

  constructor(o: InMemoryUptoOperatorOptions = {}) {
    this.feePayer = o.feePayer ?? "FeePayer1111111111111111111111111111111111";
    this.receiverAuthorizer = o.receiverAuthorizer ?? "Authorizer11111111111111111111111111111111";
  }

  async offerExtra(input: OfferExtraInput): Promise<Record<string, unknown>> {
    this.calls.offerExtra++;
    return {
      paymentFlow: "escrow",
      feePayer: this.feePayer,
      receiverAuthorizer: this.receiverAuthorizer,
      withdrawDelay: input.withdrawDelay,
      tokenProgram: SPL_TOKEN_PROGRAM,
    };
  }

  async openDeposit(env: UptoPaymentEnvelope): Promise<DepositOutcome> {
    this.calls.deposit++;
    const p = env.payload;
    if (this.channels.has(p.channelId)) throw new Error(`channel ${p.channelId} is already open`);
    const depositMicro = BigInt(p.maxAmount);
    this.channels.set(p.channelId, { depositMicro, status: "open", settledMicro: 0n });
    return {
      channelId: p.channelId,
      depositMicro,
      expiresAt: BigInt(p.expiresAt),
      txHash: `open-${p.channelId}`,
      openSlot: p.openSlot === undefined ? undefined : Number(p.openSlot),
      payer: p.from,
      payee: this.feePayer,
      authorizedSigner: this.receiverAuthorizer,
      mint: offerAsset(env.accepted),
    };
  }

  async settleClaim(env: UptoPaymentEnvelope, actualMicro: bigint): Promise<ClaimOutcome> {
    this.calls.claim++;
    const ch = this.channels.get(env.payload.channelId);
    if (!ch) throw new Error(`no open channel ${env.payload.channelId} to settle`);
    if (ch.status === "sealed") throw new Error(`channel ${env.payload.channelId} already settled`);
    if (actualMicro > ch.depositMicro) throw new Error(`claim ${actualMicro} exceeds the deposit ${ch.depositMicro}`);
    ch.status = "sealed";
    ch.settledMicro = actualMicro;
    return { txHash: `${actualMicro === 0n ? "refund" : "claim"}-${env.payload.channelId}`, settledMicro: actualMicro };
  }
}

export interface SolanaUptoOperatorOptions {
  network: string;
  feePayerSecret: Uint8Array;
  receiverAuthorizerSecret: Uint8Array;
  rpcUrl?: string;
  withdrawDelay?: number;
  maxChannelLifetimeSecs?: number;
  stateDir?: string;
  cleanupIntervalSecs?: number | false;
  onCleanupError?: (error: unknown, context?: { channelId?: string }) => void;
}

export interface SellerCleanupReport {
  closed: Array<{ channelId: string; transaction: string; action: "abandon_close" | "distribute" }>;
  reclaimed: Array<{ channelIds: string[]; transaction: string }>;
  errors: Array<{ channelId?: string; error: string }>;
  pending: number;
}

interface RentCleanupOptions {
  onClose?: (result: SellerCleanupReport["closed"][number]) => void;
  onReclaim?: (result: SellerCleanupReport["reclaimed"][number]) => void;
  onError?: (error: unknown, context?: { channelId?: string }) => void;
}

export interface SellerRentCleanupManager {
  start(options: RentCleanupOptions & { intervalSecs: number }): void;
  cleanup(options?: RentCleanupOptions): Promise<void>;
  stop(): Promise<void>;
}

export interface SolanaUptoOperator extends UptoOperator {
  rentCleanupManager(): SellerRentCleanupManager;
  sweep(): Promise<SellerCleanupReport>;
  stop(): Promise<void>;
}

interface FacilitatorSettleResponse {
  success: boolean;
  transaction?: string;
  errorReason?: string;
  errorMessage?: string;
}
interface UptoFacilitator {
  getExtra(network: string): { feePayer?: string } | undefined;
  settle(
    payload: Record<string, unknown>,
    requirements: Record<string, unknown>,
  ): Promise<FacilitatorSettleResponse>;
  createRentCleanupManager(network: string, options?: { signer: unknown }): SellerRentCleanupManager;
}

export function toFacilitatorUptoPayload(
  p: UptoPayload,
  type: "deposit" | "claim",
  authorizerAddress: string,
  voucherSignature?: string,
): Record<string, unknown> {
  if (p.openSlot === undefined || p.nonce === undefined || !p.openTransaction)
    throw new Error("buyer upto payload is missing openSlot, nonce or openTransaction");
  const out: Record<string, unknown> = {
    from: p.from,
    maxAmount: String(p.maxAmount),
    deposit: String(p.deposit ?? p.maxAmount),
    channelId: p.channelId,
    authorizedSigner: type === "claim" ? authorizerAddress : p.authorizedSigner ?? authorizerAddress,
    openTransaction: p.openTransaction,
    openSlot: String(p.openSlot),
    expiresAt: Number(p.expiresAt),
    validAfter: Number(p.validAfter ?? 0),
    nonce: String(p.nonce),
    type,
  };
  if (voucherSignature !== undefined) out.voucherSignature = voucherSignature;
  return out;
}

export async function createSolanaUptoOperator(
  opts: SolanaUptoOperatorOptions,
): Promise<SolanaUptoOperator> {
  const info = solanaNetworkInfo(opts.network);
  if (!info) throw new Error(`createSolanaUptoOperator needs a Solana network, got "${opts.network}"`);
  const rpcUrl = opts.rpcUrl ?? info.defaultRpc;
  const withdrawDelay = opts.withdrawDelay ?? DEFAULT_WITHDRAW_DELAY;
  const cleanupIntervalSecs = opts.cleanupIntervalSecs ?? 60;
  if (cleanupIntervalSecs !== false && (!Number.isFinite(cleanupIntervalSecs) || cleanupIntervalSecs <= 0))
    throw new Error("cleanupIntervalSecs must be positive, or false for a one-shot worker");
  const storage = new SellerChannelStorage(opts.stateDir);
  await storage.list();

  let kit: typeof import("@solana/kit");
  let svm: { toFacilitatorSvmSigner: (s: unknown, cfg?: unknown) => unknown };
  let facCtor: new (signer: unknown, config?: unknown) => UptoFacilitator;
  try {
    kit = (await import("@solana/kit")) as typeof import("@solana/kit");
    svm = (await import("@x402/svm")) as never;
    ({ UptoSvmScheme: facCtor } = (await import("@x402/svm/upto/facilitator")) as never);
  } catch {
    throw new Error("Solana upto seller needs @x402/svm and @solana/kit: npm i @x402/svm @solana/kit");
  }

  const feeKp = await kit.createKeyPairSignerFromBytes(opts.feePayerSecret);
  const feePayerAddress = feeKp.address as unknown as string;
  const facSigner = svm.toFacilitatorSvmSigner(feeKp, { defaultRpcUrl: rpcUrl });
  const facilitator = new facCtor(facSigner, {
    maxChannelLifetimeSecs: opts.maxChannelLifetimeSecs,
    channelStorage: storage,
  });

  const authorizerAddress = deriveAddress(opts.receiverAuthorizerSecret);
  const cleanup = facilitator.createRentCleanupManager(info.caip2, {
    signer: sellerCleanupSigner(facSigner as CleanupSigner, storage, rpcUrl),
  });
  if (cleanupIntervalSecs !== false) cleanup.start({
    intervalSecs: cleanupIntervalSecs,
    onError: opts.onCleanupError ?? ((error, context) => {
      console.warn(`seller cleanup failed${context?.channelId ? ` for ${context.channelId}` : ""}: ${errMsg(error)}`);
    }),
  });

  const requirementsFor = (accepted: AcceptsEntry, amountMicro: bigint): Record<string, unknown> => ({
    scheme: "upto",
    network: info.caip2,
    amount: amountMicro.toString(),
    maxAmountRequired: amountMicro.toString(),
    asset: info.mint,
    payTo: offerPayTo(accepted),
    maxTimeoutSeconds: accepted.maxTimeoutSeconds ?? 300,
    extra: {
      paymentFlow: "escrow",
      feePayer: feePayerAddress,
      receiverAuthorizer: authorizerAddress,
      withdrawDelay,
      tokenProgram: info.tokenProgram,
    },
  });

  return {
    async offerExtra(input: OfferExtraInput): Promise<Record<string, unknown>> {
      const chosen = facilitator.getExtra(info.caip2)?.feePayer ?? feePayerAddress;
      return {
        paymentFlow: "escrow",
        feePayer: chosen,
        receiverAuthorizer: authorizerAddress,
        withdrawDelay: input.withdrawDelay,
        tokenProgram: info.tokenProgram,
      };
    },

    async openDeposit(env: UptoPaymentEnvelope): Promise<DepositOutcome> {
      const p = env.payload;
      const payload = { x402Version: env.x402Version, accepted: env.accepted, payload: toFacilitatorUptoPayload(p, "deposit", authorizerAddress) };
      const resp = await storage.withDeposit(p.channelId, Number(p.openSlot), () =>
        facilitator.settle(payload, requirementsFor(env.accepted, BigInt(p.maxAmount))));
      if (!resp.success) throw new Error(`open rejected: ${resp.errorReason ?? "unknown"} ${resp.errorMessage ?? ""}`.trim());
      return {
        channelId: p.channelId,
        depositMicro: BigInt(p.maxAmount),
        expiresAt: BigInt(p.expiresAt),
        txHash: resp.transaction,
        openSlot: p.openSlot === undefined ? undefined : Number(p.openSlot),
        payer: p.from,
        payee: feePayerAddress,
        authorizedSigner: authorizerAddress,
        mint: info.mint,
      };
    },

    async settleClaim(env: UptoPaymentEnvelope, actualMicro: bigint): Promise<ClaimOutcome> {
      const p = env.payload;
      const voucherSignature = base58Encode(
        signVoucher(opts.receiverAuthorizerSecret, {
          channelId: p.channelId,
          cumulativeAmount: actualMicro,
          expiresAt: BigInt(p.expiresAt),
        }),
      );
      const payload = {
        x402Version: env.x402Version,
        accepted: env.accepted,
        payload: toFacilitatorUptoPayload(p, "claim", authorizerAddress, voucherSignature),
      };
      const resp = await facilitator.settle(payload, requirementsFor(env.accepted, actualMicro));
      if (!resp.success)
        throw new Error(`settle rejected: ${resp.errorReason ?? "unknown"} ${resp.errorMessage ?? ""}`.trim());
      return { txHash: resp.transaction, settledMicro: actualMicro };
    },

    rentCleanupManager(): SellerRentCleanupManager {
      return cleanup;
    },
    async sweep(): Promise<SellerCleanupReport> {
      const report: SellerCleanupReport = { closed: [], reclaimed: [], errors: [], pending: 0 };
      await cleanup.cleanup({
        onClose: result => report.closed.push(result),
        onReclaim: result => report.reclaimed.push(result),
        onError: (error, context) => report.errors.push({ channelId: context?.channelId, error: errMsg(error) }),
      });
      report.pending = (await storage.list()).filter(r => r.network === info.caip2).length;
      return report;
    },
    stop: () => cleanup.stop(),
  };
}

function deriveAddress(secret: Uint8Array): string {
  return solanaSigner(secret).address;
}

export interface TreasuryAtaCheck {
  ok: boolean;
  detail: string;
  ata?: string;
}

export async function checkTreasuryAta(network: string, rpcUrl?: string): Promise<TreasuryAtaCheck> {
  const info = solanaNetworkInfo(network);
  if (!info) return { ok: false, detail: `not a Solana network: ${network}` };
  const rpc = rpcUrl ?? info.defaultRpc;

  let kit: typeof import("@solana/kit");
  let token: typeof import("@solana-program/token");
  try {
    kit = await import("@solana/kit");
    token = await import("@solana-program/token");
  } catch {
    return { ok: false, detail: "install @solana/kit and @solana-program/token to check the treasury ATA" };
  }

  let ata: string;
  try {
    const [pda] = await token.findAssociatedTokenPda({
      owner: kit.address(PAYMENT_CHANNELS_TREASURY_OWNER),
      mint: kit.address(info.mint),
      tokenProgram: kit.address(info.tokenProgram),
    });
    ata = String(pda);
  } catch (e) {
    return { ok: false, detail: `could not derive the treasury ATA: ${errMsg(e)}` };
  }

  try {
    const { solanaAccountRpc } = await import("./channels.ts");
    const data = await solanaAccountRpc(rpc, 8000, info.tokenProgram).getAccountData(ata);
    if (data === null) return { ok: false, detail: `treasury ATA ${ata} does not exist — \`distribute\` will fail for this mint`, ata };
    return { ok: true, detail: `treasury ATA ${ata} exists`, ata };
  } catch (e) {
    if (e instanceof RpcError) return { ok: false, detail: `could not reach ${rpc}: ${e.message}`, ata };
    return { ok: false, detail: errMsg(e), ata };
  }
}
