import crypto from "node:crypto";
import type { AcceptsEntry, PaymentPayload, PaymentRequiredBody, SettleResult } from "./types.ts";
import type { PolicyRule, RuntimePolicy } from "./policy.ts";

/**
 * Why a payment was refused. `rule` is a closed union so a consumer can switch
 * exhaustively; the extra fields exist so an agent can act on the block instead
 * of just logging it — retry cheaper (`quotedMicro` vs `capMicro`), wait
 * (`retryAfterMs`), escalate (`requestId`), or give up (`recoverable: false`).
 */
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
  /** What was actually spent. Zero for anything that did not settle. */
  costMicro: bigint;
  /** What the seller asked for, even when the payment was refused. Zero if never quoted. */
  quotedMicro: bigint;
  txHash?: string;
  blockedBy?: BlockedBy;
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

export type AuthorizeResult = { allowed: true; reservationId?: string } | ({ allowed: false } & BlockedBy);

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
  /** The rails currently in force — lets a self-correcting agent read its own limits. */
  policy?(): RuntimePolicy;
  authorize(amountMicro: bigint, url: string): Promise<AuthorizeResult>;
  recordPayment(
    url: string,
    host: string,
    amountMicro: bigint,
    txHash: string,
    reservationId?: string,
  ): void | Promise<void>;
  recordBlocked(
    url: string,
    host: string,
    rule: PolicyRule,
    detail: string,
    amountMicro: bigint,
  ): void | Promise<void>;
  /** Frees an authorized-but-unsettled amount when a payment does not go through. */
  releaseReservation?(id: string): void | Promise<void>;
}

function blockDetails(decision: { allowed: false } & BlockedBy): BlockedBy {
  const { allowed, ...rest } = decision;
  void allowed;
  return rest;
}

export async function payingFetch(ctx: PayContext, url: string, init?: RequestInit): Promise<PaidResult> {
  const host = new URL(url).host;

  // Pre-flight: screen the destination before the seller ever sees a request.
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
    // The seller was unreachable. No money was involved, so this is a
    // transport error the caller can retry — not a policy block.
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

  const required = (await first.json()) as PaymentRequiredBody;
  const offer = required.accepts?.[0];
  if (!offer)
    return {
      ok: false,
      status: 402,
      body: required,
      raw: "",
      costMicro: 0n,
      quotedMicro: 0n,
      error: "seller returned 402 with no acceptable payment methods",
    };

  const amountMicro = BigInt(offer.maxAmountRequired);
  const decision = await ctx.authorize(amountMicro, url);
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

  let encoded: string;
  let paid: Response;
  try {
    encoded = ctx.encodePayment
      ? await ctx.encodePayment(unsigned)
      : Buffer.from(
          JSON.stringify({ ...unsigned, signature: ctx.chain.sign(ctx.address, unsigned) }),
        ).toString("base64");
    paid = await fetch(url, { ...init, headers: { ...(init?.headers ?? {}), "X-PAYMENT": encoded } });
  } catch (e) {
    // Signing or the network failed — the money never left, so free the hold.
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

  const receiptHeader = paid.headers.get("x-payment-response");
  let txHash: string | undefined;
  let settledMicro = 0n;
  if (receiptHeader) {
    try {
      const receipt = JSON.parse(Buffer.from(receiptHeader, "base64").toString("utf8")) as SettleResult & {
        amountMicro: string;
      };
      txHash = receipt.txHash;
      settledMicro = BigInt(receipt.amountMicro);
      await ctx.recordPayment(url, host, settledMicro, receipt.txHash ?? "", reservationId);
    } catch {
      txHash = undefined;
    }
  }

  if (!txHash) {
    // No receipt: the seller took the payment attempt and refused it, or
    // answered without settling. Either way nothing was spent — release the
    // hold and leave a trace, because a silent failure in a spend-control
    // audit log is worse than no audit log.
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

async function wrapPlain(res: Response): Promise<PaidResult> {
  const raw = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {}
  return { ok: res.ok, status: res.status, body: body as never, raw, costMicro: 0n, quotedMicro: 0n };
}
