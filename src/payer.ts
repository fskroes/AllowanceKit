import crypto from "node:crypto";
import type { AcceptsEntry, PaymentPayload, PaymentRequiredBody, SettleResult } from "./types.ts";
import { offerAmount, offerAsset, offerPayTo } from "./types.ts";
import type { PolicyRule, RuntimePolicy } from "./policy.ts";

export interface BlockedBy {
  rule: PolicyRule;
  detail: string;
  recoverable: boolean;
  requestId?: string;
  quotedMicro?: bigint;
  capMicro?: bigint;
  retryAfterMs?: number;
}

export interface PaidResult<T = unknown> {
  ok: boolean;
  status: number;
  body: T | null;
  raw: string;
  costMicro: bigint;
  quotedMicro: bigint;
  txHash?: string;
  blockedBy?: BlockedBy;
  error?: string;
  channelId?: string;
  refundMicro?: bigint;
}

export interface PaymentAnnotations {
  scheme?: string;
  depositMicro?: bigint;
  refundMicro?: bigint;
  channelId?: string;
}

export interface UptoOpen {
  header: string;
  channelId: string;
  depositMicro: bigint;
}

export type UptoOutcome =
  | { kind: "settled"; settledMicro: bigint; txHash?: string }
  | { kind: "refunded"; txHash?: string }
  | { kind: "unknown" };

export interface UptoBuyer {
  open(unsigned: UnsignedPayment, meta: { url: string; host: string; reservationId?: string }): Promise<UptoOpen>;
  resolve(channelId: string, outcome: UptoOutcome): void | Promise<void>;
}

export interface UnsignedPayment {
  x402Version: number;
  scheme: string;
  network: string;
  resource: string;
  from: string;
  payTo: string;
  amount: string;
  nonce: string;
  timestamp: number;
  requirements: AcceptsEntry;
  acceptedOffer?: AcceptsEntry;
}

export type AuthorizeResult = { allowed: true; reservationId?: string } | ({ allowed: false } & BlockedBy);

export interface PayContext {
  agentName: string;
  address: string;
  chain: {
    sign(address: string, unsigned: Omit<PaymentPayload, "signature">): string;
    balance(address: string): bigint;
  };
  encodePayment?(unsigned: UnsignedPayment): Promise<string>;
  chooseOffer?(offers: AcceptsEntry[]): AcceptsEntry | undefined;
  policy?(): RuntimePolicy;
  authorize(amountMicro: bigint, url: string, scheme?: "exact" | "upto"): Promise<AuthorizeResult>;
  recordPayment(
    url: string,
    host: string,
    amountMicro: bigint,
    txHash: string,
    reservationId?: string,
    annotations?: PaymentAnnotations,
  ): void | Promise<void>;
  recordBlocked(
    url: string,
    host: string,
    rule: PolicyRule,
    detail: string,
    amountMicro: bigint,
  ): void | Promise<void>;
  releaseReservation?(id: string): void | Promise<void>;
  upto?: UptoBuyer;
}

function blockDetails(decision: { allowed: false } & BlockedBy): BlockedBy {
  const { allowed, ...rest } = decision;
  void allowed;
  return rest;
}

export async function payingFetch(ctx: PayContext, url: string, init?: RequestInit): Promise<PaidResult> {
  const host = new URL(url).host;

  const preflight = await ctx.authorize(0n, url);
  if (!preflight.allowed) {
    const blockedBy = blockDetails(preflight);
    await ctx.recordBlocked(url, host, blockedBy.rule, `${blockedBy.detail} (pre-flight)`, 0n);
    return { ok: false, status: 0, body: null, raw: "", costMicro: 0n, quotedMicro: 0n, blockedBy };
  }

  let first: Response;
  try {
    first = await fetch(url, { ...init, headers: { ...(init?.headers ?? {}) } });
  } catch (e) {
    return {
      ok: false,
      status: 0,
      body: null,
      raw: "",
      costMicro: 0n,
      quotedMicro: 0n,
      error: `could not reach ${host}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (first.status !== 402) return wrapPlain(first);

  const bodyText = await first.text();
  let bodyJson: PaymentRequiredBody | undefined;
  try {
    bodyJson = bodyText ? (JSON.parse(bodyText) as PaymentRequiredBody) : undefined;
  } catch {}

  let headerJson: PaymentRequiredBody | undefined;
  const challengeHeader = first.headers.get("payment-required");
  if (challengeHeader) {
    try {
      headerJson = JSON.parse(Buffer.from(challengeHeader, "base64").toString("utf8")) as PaymentRequiredBody;
    } catch {}
  }

  const challenge =
    (headerJson?.accepts?.length ? headerJson : undefined) ??
    (bodyJson?.accepts?.length ? bodyJson : undefined) ??
    headerJson ??
    bodyJson;
  const isV2 = Number(headerJson?.x402Version ?? bodyJson?.x402Version ?? 1) >= 2;

  const offers = challenge?.accepts ?? [];
  const rawOffer = ctx.chooseOffer ? ctx.chooseOffer(offers) : offers[0];
  if (!rawOffer)
    return {
      ok: false,
      status: 402,
      body: (bodyJson ?? headerJson ?? null) as never,
      raw: bodyText,
      costMicro: 0n,
      quotedMicro: 0n,
      error: "seller returned 402 with no acceptable payment methods",
    };

  const amountStr = offerAmount(rawOffer);
  if (amountStr === undefined || !/^\d+$/.test(amountStr))
    return {
      ok: false,
      status: 402,
      body: (bodyJson ?? headerJson ?? null) as never,
      raw: bodyText,
      costMicro: 0n,
      quotedMicro: 0n,
      error: "seller returned 402 with no usable amount",
    };

  const topResource = challenge?.resource;
  const topResourceUrl = typeof topResource === "string" ? topResource : topResource?.url;
  const offer: AcceptsEntry = {
    ...rawOffer,
    amount: amountStr,
    maxAmountRequired: amountStr,
    payTo: offerPayTo(rawOffer),
    asset: offerAsset(rawOffer),
    resource: rawOffer.resource ?? topResourceUrl ?? url,
  };

  const amountMicro = BigInt(amountStr);
  const decision = await ctx.authorize(amountMicro, url, offer.scheme === "upto" ? "upto" : "exact");
  if (!decision.allowed) {
    const blockedBy = blockDetails(decision);
    await ctx.recordBlocked(url, host, blockedBy.rule, blockedBy.detail, amountMicro);
    return { ok: false, status: 402, body: null, raw: "", costMicro: 0n, quotedMicro: amountMicro, blockedBy };
  }
  const reservationId = decision.reservationId;

  const release = async (): Promise<void> => {
    if (reservationId) await ctx.releaseReservation?.(reservationId);
  };

  const nonce = crypto.randomBytes(16).toString("hex");
  const unsigned: UnsignedPayment = {
    x402Version: isV2 ? 2 : 1,
    scheme: offer.scheme,
    network: offer.network,
    resource: offer.resource ?? url,
    from: ctx.address,
    payTo: offer.payTo ?? "",
    amount: amountStr,
    nonce,
    timestamp: Date.now(),
    requirements: offer,
    acceptedOffer: rawOffer,
  };

  if (offer.scheme === "upto" && ctx.upto) {
    return payUpto(ctx, url, host, init, unsigned, amountMicro, reservationId, release);
  }

  const paymentHeaderName = isV2 ? "PAYMENT-SIGNATURE" : "X-PAYMENT";

  let encoded: string;
  let paid: Response;
  try {
    encoded = ctx.encodePayment
      ? await ctx.encodePayment(unsigned)
      : encodeDefaultPayment(unsigned, ctx.chain.sign(ctx.address, unsigned));
    paid = await fetch(url, { ...init, headers: { ...(init?.headers ?? {}), [paymentHeaderName]: encoded } });
  } catch (e) {
    await release();
    const detail = e instanceof Error ? e.message : String(e);
    await ctx.recordBlocked(url, host, "settlement_rejected", detail, amountMicro);
    return {
      ok: false,
      status: 0,
      body: null,
      raw: "",
      costMicro: 0n,
      quotedMicro: amountMicro,
      error: detail,
      blockedBy: { rule: "settlement_rejected", detail, recoverable: true, quotedMicro: amountMicro },
    };
  }

  const raw = await paid.text();
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {}

  const receiptHeader = paid.headers.get(isV2 ? "payment-response" : "x-payment-response");
  let txHash: string | undefined;
  let settledMicro = 0n;
  if (receiptHeader) {
    try {
      const receipt = JSON.parse(Buffer.from(receiptHeader, "base64").toString("utf8")) as SettleResult & {
        amountMicro?: string;
        transaction?: string;
      };
      txHash = receipt.transaction ?? receipt.txHash;
      settledMicro = receipt.amountMicro !== undefined ? BigInt(receipt.amountMicro) : amountMicro;
      await ctx.recordPayment(url, host, settledMicro, txHash ?? "", reservationId);
    } catch {
      txHash = undefined;
    }
  }

  if (!txHash) {
    await release();
    if (!paid.ok) {
      const detail =
        (body as { error?: string } | null)?.error ??
        `seller returned HTTP ${paid.status} with no payment receipt`;
      await ctx.recordBlocked(url, host, "settlement_rejected", detail, amountMicro);
      return {
        ok: false,
        status: paid.status,
        body,
        raw,
        costMicro: 0n,
        quotedMicro: amountMicro,
        error: detail,
        blockedBy: { rule: "settlement_rejected", detail, recoverable: false, quotedMicro: amountMicro },
      };
    }
  }

  return {
    ok: paid.ok,
    status: paid.status,
    body: body as never,
    raw,
    costMicro: settledMicro,
    quotedMicro: amountMicro,
    txHash,
  };
}

function encodeDefaultPayment(unsigned: UnsignedPayment, signature: string): string {
  if (unsigned.x402Version >= 2) {
    const payloadV2 = {
      x402Version: 2,
      accepted: unsigned.acceptedOffer ?? unsigned.requirements,
      payload: {
        signature,
        authorization: { from: unsigned.from, to: unsigned.payTo, value: unsigned.amount },
      },
    };
    return Buffer.from(JSON.stringify(payloadV2)).toString("base64");
  }
  return Buffer.from(JSON.stringify({ ...unsigned, signature })).toString("base64");
}

interface UptoReceipt {
  success: boolean;
  actualMicro?: bigint;
  refundMicro?: bigint;
  txHash?: string;
  transaction?: string;
  channelId?: string;
  error?: string;
}

function bigintOrUndef(v: unknown): bigint | undefined {
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return BigInt(v);
  return undefined;
}

function parseUptoReceipt(header: string | null): UptoReceipt | undefined {
  if (!header) return undefined;
  try {
    const r = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Record<string, unknown>;
    return {
      success: r.success === true,
      actualMicro: bigintOrUndef(r.amountMicro ?? r.amount),
      refundMicro: bigintOrUndef(r.refundMicro),
      txHash: (typeof r.transaction === "string" ? r.transaction : undefined) ?? (typeof r.txHash === "string" ? r.txHash : undefined),
      transaction: typeof r.transaction === "string" ? r.transaction : undefined,
      channelId: typeof r.channelId === "string" ? r.channelId : undefined,
      error: typeof r.error === "string" ? r.error : undefined,
    };
  } catch {
    return undefined;
  }
}

async function payUpto(
  ctx: PayContext,
  url: string,
  host: string,
  init: RequestInit | undefined,
  unsigned: UnsignedPayment,
  ceilingMicro: bigint,
  reservationId: string | undefined,
  release: () => Promise<void>,
): Promise<PaidResult> {
  const upto = ctx.upto!;

  let open: UptoOpen;
  try {
    open = await upto.open(unsigned, { url, host, reservationId });
  } catch (e) {
    await release();
    const detail = e instanceof Error ? e.message : String(e);
    await ctx.recordBlocked(url, host, "settlement_rejected", detail, ceilingMicro);
    return {
      ok: false,
      status: 0,
      body: null,
      raw: "",
      costMicro: 0n,
      quotedMicro: ceilingMicro,
      error: detail,
      blockedBy: { rule: "settlement_rejected", detail, recoverable: true, quotedMicro: ceilingMicro },
    };
  }
  const { header, channelId, depositMicro } = open;

  let paid: Response;
  try {
    paid = await fetch(url, { ...init, headers: { ...(init?.headers ?? {}), "X-PAYMENT": header } });
  } catch (e) {
    await upto.resolve(channelId, { kind: "unknown" });
    await release();
    const detail = `could not reach ${host}: ${e instanceof Error ? e.message : String(e)}`;
    await ctx.recordBlocked(url, host, "settlement_rejected", detail, ceilingMicro);
    return {
      ok: false,
      status: 0,
      body: null,
      raw: "",
      costMicro: 0n,
      quotedMicro: ceilingMicro,
      channelId,
      error: detail,
      blockedBy: { rule: "settlement_rejected", detail, recoverable: true, quotedMicro: ceilingMicro },
    };
  }

  const raw = await paid.text();
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {}

  const receipt = parseUptoReceipt(paid.headers.get("x-payment-response"));

  if (receipt?.success) {
    const claimed = receipt.actualMicro ?? 0n;
    const actual = claimed > depositMicro ? depositMicro : claimed;
    const refundMicro = depositMicro - actual;
    await upto.resolve(channelId, { kind: "settled", settledMicro: actual, txHash: receipt.txHash });
    await ctx.recordPayment(url, host, actual, receipt.txHash ?? "", reservationId, {
      scheme: "upto",
      depositMicro,
      refundMicro,
      channelId,
    });
    return {
      ok: paid.ok,
      status: paid.status,
      body: body as never,
      raw,
      costMicro: actual,
      quotedMicro: ceilingMicro,
      txHash: receipt.txHash,
      channelId,
      refundMicro,
    };
  }

  if (receipt?.transaction && (receipt.refundMicro ?? 0n) > 0n) {
    await upto.resolve(channelId, { kind: "refunded", txHash: receipt.txHash });
    await release();
    await ctx.recordPayment(url, host, 0n, receipt.txHash ?? "", undefined, {
      scheme: "upto",
      depositMicro,
      refundMicro: depositMicro,
      channelId,
    });
    const detail = receipt.error ?? (body as { error?: string } | null)?.error ?? "seller refunded the deposit";
    return {
      ok: false,
      status: paid.status,
      body: body as never,
      raw,
      costMicro: 0n,
      quotedMicro: ceilingMicro,
      channelId,
      refundMicro: depositMicro,
      txHash: receipt.txHash,
      error: detail,
      blockedBy: { rule: "settlement_rejected", detail, recoverable: true, quotedMicro: ceilingMicro },
    };
  }

  await upto.resolve(channelId, { kind: "unknown" });
  await release();
  const detail =
    receipt?.error ??
    (body as { error?: string } | null)?.error ??
    `seller returned HTTP ${paid.status} with no upto receipt`;
  await ctx.recordBlocked(url, host, "settlement_rejected", detail, ceilingMicro);
  return {
    ok: false,
    status: paid.status,
    body: body as never,
    raw,
    costMicro: 0n,
    quotedMicro: ceilingMicro,
    channelId,
    error: detail,
    blockedBy: { rule: "settlement_rejected", detail, recoverable: false, quotedMicro: ceilingMicro },
  };
}

async function wrapPlain(res: Response): Promise<PaidResult> {
  const raw = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {}
  return { ok: res.ok, status: res.status, body: body as never, raw, costMicro: 0n, quotedMicro: 0n };
}
