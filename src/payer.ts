import crypto from "node:crypto";
import type { AcceptsEntry, PaymentPayload, PaymentRequiredBody, SettleResult } from "./types.ts";

export interface PaidResult<T = unknown> {
  ok: boolean;
  status: number;
  body: T | null;
  raw: string;
  costMicro: bigint;
  txHash?: string;
  blockedBy?: { rule: string; detail: string; requestId?: string };
  error?: string;
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
}

export interface PayContext {
  agentName: string;
  address: string;
  chain: {
    sign(address: string, unsigned: Omit<PaymentPayload, "signature">): string;
    balance(address: string): bigint;
  };
  /**
   * Produces the base64 X-PAYMENT header value. Defaults to the flat
   * mock-ledger shape; override for real networks (e.g. EIP-3009 signed
   * x402 v1 payloads via src/live.ts).
   */
  encodePayment?(unsigned: UnsignedPayment): Promise<string>;
  authorize(amountMicro: bigint, url: string): Promise<
    | { allowed: true }
    | { allowed: false; rule: string; detail: string; requestId?: string }
  >;
  recordPayment(url: string, host: string, amountMicro: bigint, txHash: string): void;
  recordBlocked(url: string, host: string, rule: string, detail: string, amountMicro: bigint): void;
}

export async function payingFetch(ctx: PayContext, url: string, init?: RequestInit): Promise<PaidResult> {
  const host = new URL(url).host;

  const preflight = await ctx.authorize(0n, url);
  if (!preflight.allowed) {
    ctx.recordBlocked(url, host, preflight.rule, `${preflight.detail} (pre-flight)`, 0n);
    return { ok: false, status: 0, body: null, raw: "", costMicro: 0n, blockedBy: preflight };
  }

  const first = await fetch(url, { ...init, headers: { ...(init?.headers ?? {}) } });
  if (first.status !== 402) return wrapPlain(first);

  const required = (await first.json()) as PaymentRequiredBody;
  const offer = required.accepts?.[0];
  if (!offer) return { ok: false, status: 402, body: required, raw: "", costMicro: 0n, error: "seller returned 402 with no acceptable payment methods" };

  const amountMicro = BigInt(offer.maxAmountRequired);
  const decision = await ctx.authorize(amountMicro, url);
  if (!decision.allowed) {
    ctx.recordBlocked(url, host, decision.rule, decision.detail, amountMicro);
    return { ok: false, status: 402, body: null, raw: "", costMicro: 0n, blockedBy: decision };
  }

  const nonce = crypto.randomBytes(16).toString("hex");
  const unsigned: UnsignedPayment = {
    x402Version: 1,
    scheme: offer.scheme,
    network: offer.network,
    resource: offer.resource,
    from: ctx.address,
    payTo: offer.payTo,
    amount: offer.maxAmountRequired,
    nonce,
    timestamp: Date.now(),
    requirements: offer,
  };
  const encoded = ctx.encodePayment
    ? await ctx.encodePayment(unsigned)
    : Buffer.from(JSON.stringify({ ...unsigned, signature: ctx.chain.sign(ctx.address, unsigned) })).toString("base64");

  const paid = await fetch(url, {
    ...init,
    headers: { ...(init?.headers ?? {}), "X-PAYMENT": encoded },
  });

  const receiptHeader = paid.headers.get("x-payment-response");
  let txHash: string | undefined;
  if (receiptHeader) {
    try {
      const receipt = JSON.parse(Buffer.from(receiptHeader, "base64").toString("utf8")) as SettleResult & { amountMicro: string };
      txHash = receipt.txHash;
      ctx.recordPayment(url, host, BigInt(receipt.amountMicro), receipt.txHash ?? "");
    } catch {
      txHash = undefined;
    }
  }

  const raw = await paid.text();
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {}

  return { ok: paid.ok, status: paid.status, body: body as never, raw, costMicro: txHash ? amountMicro : 0n, txHash };
}

function wrapPlain(res: Response): PaidResult {
  return { ok: res.ok, status: res.status, body: null, raw: "", costMicro: 0n };
}
