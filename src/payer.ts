import crypto from "node:crypto";
import type { AcceptsEntry, PaymentPayload, PaymentRequiredBody, SettleResult } from "./types.ts";
import { offerAmount, offerAsset, offerPayTo } from "./types.ts";
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
  /** Solana `upto` only: the channel this request opened. */
  channelId?: string;
  /** Solana `upto` only: what came back to the wallet (`deposit − actual`). */
  refundMicro?: bigint;
}

/** Solana `upto` only: extra columns for a settled payment's ledger row. */
export interface PaymentAnnotations {
  scheme?: string;
  depositMicro?: bigint;
  refundMicro?: bigint;
  channelId?: string;
}

/** What {@link UptoBuyer.open} returns: the wire header and the escrow row it recorded. */
export interface UptoOpen {
  /** The base64 `X-PAYMENT` envelope the seller reads. */
  header: string;
  channelId: string;
  /** The escrowed ceiling, micro-dollars. */
  depositMicro: bigint;
}

/** How the seller's receipt (or its absence) resolved an `upto` channel row. */
export type UptoOutcome =
  | { kind: "settled"; settledMicro: bigint }
  | { kind: "refunded" }
  | { kind: "unknown" };

/**
 * The Solana `upto` buyer hooks. Present only on a Solana upto-capable context
 * (`createLiveAgent` on a Solana network); absent on EVM and Solana `exact`, so
 * `payingFetch` takes the exact path unchanged when this is missing.
 */
export interface UptoBuyer {
  /**
   * Build the `open` envelope AND persist the escrow row *before* returning, so
   * a crash after the send still leaves a row for reconcile (§4.3). `meta`
   * carries the request url/host and the reservation the escrow converts from.
   */
  open(unsigned: UnsignedPayment, meta: { url: string; host: string; reservationId?: string }): Promise<UptoOpen>;
  /** Resolve the channel row from the parsed receipt: settle / refund / mark unknown. */
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
  /** The offer normalized to one field set (both `amount` and `maxAmountRequired`). */
  requirements: AcceptsEntry;
  /**
   * The seller's chosen offer exactly as it arrived, before normalization. A v2
   * facilitator echoes `payload.accepted` back against what it advertised and can
   * throw on fields it never sent (our v1-compat `maxAmountRequired`, a
   * synthesized `resource`), so the v2 wire echoes this verbatim, not the
   * normalized copy.
   */
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
  /**
   * Produces the base64 X-PAYMENT header value. Defaults to the flat
   * mock-ledger shape; override for real networks (e.g. EIP-3009 signed
   * x402 v1 payloads via src/live.ts).
   */
  encodePayment?(unsigned: UnsignedPayment): Promise<string>;
  /**
   * Choose which of a seller's advertised offers to pay. A real v2 seller lists
   * several — different chains, price tiers, settlement mechanisms — and the
   * first is not always one this agent can settle. A live agent picks the
   * cheapest plain-USDC offer on its own chain (src/live.ts). The default, used
   * by the mock ctx and single-offer v1 sellers, is simply the first offer.
   */
  chooseOffer?(offers: AcceptsEntry[]): AcceptsEntry | undefined;
  /** The rails currently in force — lets a self-correcting agent read its own limits. */
  policy?(): RuntimePolicy;
  /**
   * Screen a payment against the allowance rails and reserve it. `scheme` tells
   * the rails whether `amountMicro` is a settled amount (`exact`) or a ceiling
   * the buyer escrows (`upto`), which only changes how a refusal is worded (§5).
   * Omitted on the pre-flight host screen and defaults to `exact`.
   */
  authorize(amountMicro: bigint, url: string, scheme?: "exact" | "upto"): Promise<AuthorizeResult>;
  recordPayment(
    url: string,
    host: string,
    amountMicro: bigint,
    txHash: string,
    reservationId?: string,
    /** Solana `upto` only: the scheme/deposit/refund/channel columns for the row. */
    annotations?: PaymentAnnotations,
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
  /** Solana `upto` only: build the open, record the escrow row, resolve it from the receipt. */
  upto?: UptoBuyer;
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

  // Parse the 402 challenge. A v1 seller carries it in the JSON body; a v2
  // seller carries it in the base64 `PAYMENT-REQUIRED` header and often leaves
  // the body literally `{}` (x402-compat.md §4c, §5). Read both, detect the
  // version from `x402Version`, and answer in kind. Reading only the body — as
  // v1 did — mis-reports every reference-SDK v2 seller as "no payment methods".
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

  // Prefer whichever source actually carries an `accepts[]`; the header is v2's
  // canonical location, the body is v1's.
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

  // Normalize the seller's offer into a single v1-shaped entry so everything
  // downstream (authorize, the encoder, the facilitator) reads one field set.
  // v2 puts the resource url in a top-level object, so fall back to it, then to
  // the request url. Both `amount` and `maxAmountRequired` are kept populated.
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
  // For `upto` the quoted amount is the ceiling the buyer escrows; tell the
  // rails so a block reads "ceiling" not "price" (§5).
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
    // Answer in the version the seller spoke (x402-compat.md §6.4).
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
    // Echo exactly what the seller sent on the v2 wire (see UnsignedPayment).
    acceptedOffer: rawOffer,
  };

  // A Solana `upto` offer is a payment channel, not a one-shot transfer: the
  // buyer escrows the ceiling, the seller meters and settles the actual, the
  // rest refunds. It has its own wire (X-PAYMENT / X-PAYMENT-RESPONSE), its own
  // header, and an escrow row written before the send — so it takes its own
  // path and leaves the `exact` flow below byte-identical.
  if (offer.scheme === "upto" && ctx.upto) {
    return payUpto(ctx, url, host, init, unsigned, amountMicro, reservationId, release);
  }

  // v2 renamed the wire headers: the payment goes up in `PAYMENT-SIGNATURE`
  // (not `X-PAYMENT`) and the receipt comes back in `PAYMENT-RESPONSE` (not
  // `X-PAYMENT-RESPONSE`). See x402-compat.md §5.
  const paymentHeaderName = isV2 ? "PAYMENT-SIGNATURE" : "X-PAYMENT";

  let encoded: string;
  let paid: Response;
  try {
    encoded = ctx.encodePayment
      ? await ctx.encodePayment(unsigned)
      : encodeDefaultPayment(unsigned, ctx.chain.sign(ctx.address, unsigned));
    paid = await fetch(url, { ...init, headers: { ...(init?.headers ?? {}), [paymentHeaderName]: encoded } });
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

  const receiptHeader = paid.headers.get(isV2 ? "payment-response" : "x-payment-response");
  let txHash: string | undefined;
  let settledMicro = 0n;
  if (receiptHeader) {
    try {
      const receipt = JSON.parse(Buffer.from(receiptHeader, "base64").toString("utf8")) as SettleResult & {
        amountMicro?: string;
        transaction?: string;
      };
      // v2 SettlementResponse names the hash `transaction`; v1 uses `txHash`.
      txHash = receipt.transaction ?? receipt.txHash;
      // v1 receipts carry `amountMicro`; a v2 receipt need not, so fall back to
      // the amount we authorized and settled against.
      settledMicro = receipt.amountMicro !== undefined ? BigInt(receipt.amountMicro) : amountMicro;
      await ctx.recordPayment(url, host, settledMicro, txHash ?? "", reservationId);
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

/**
 * Fallback encoder for contexts without a real signer (the mock chain). It
 * mirrors the two wire shapes so a mock buyer can answer either seller:
 *   - v1: the flat `{ …unsigned, signature }` shape the mock ledger settles.
 *   - v2: the nested `{ x402Version:2, accepted, payload:{…} }` shape (spec
 *     §5.2.2). The mock signer yields a flat signature rather than an EIP-3009
 *     authorization, so we synthesize the `payload.authorization` fields a
 *     seller checks (`flatAmount`/`payeeOf` read `payload.authorization`).
 * A live agent overrides this via `ctx.encodePayment` (src/live.ts), which
 * signs a real EIP-712 authorization for the same two shapes.
 */
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

/** The seller's `X-PAYMENT-RESPONSE` for an `upto` request, once decoded. */
interface UptoReceipt {
  success: boolean;
  actualMicro?: bigint;
  refundMicro?: bigint;
  txHash?: string;
  /** Present when the seller broadcast a settle/refund transaction. */
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

/**
 * The Solana `upto` buyer flow (docs/SOLANA-ARCHITECTURE.md §4.3). The channel
 * row is written by `ctx.upto.open` *before* the deposit is sent, and resolved
 * from the seller's receipt afterwards:
 *
 * - success               → settle the actual, record a `payment` row annotated
 *                           with the deposit and refund, return `costMicro:actual`
 * - refund (amount 0)      → the seller declined and returned the deposit: record
 *                           a 0 `payment` row (the ledger shows the attempt), the
 *                           reservation and any grant are fully released
 * - no receipt / 5xx / a   → the deposit may be on-chain and unsettled: mark the
 *   transport error          row `unknown` for `reconcileChannels`, release the
 *                            hold, trace it as `settlement_rejected`
 *
 * The reservation stays open across the send (never converted early), so on the
 * happy path `recordPayment(actual, reservationId)` closes it while the escrow
 * row settles; on failure the hold is released and the escrow row carries the
 * money until reconcile resolves it.
 */
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

  // 1. Build the open and record the escrow row before anything is broadcast.
  let open: UptoOpen;
  try {
    open = await upto.open(unsigned, { url, host, reservationId });
  } catch (e) {
    // Signing/build failed — no row was written, nothing left the wallet.
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

  // 2. Send the deposit. The seller co-signs the feePayer slot and broadcasts.
  let paid: Response;
  try {
    paid = await fetch(url, { ...init, headers: { ...(init?.headers ?? {}), "X-PAYMENT": header } });
  } catch (e) {
    // Transport error before the seller could broadcast (§4.3 row 1): mark the
    // row `unknown` so a later reconcile drops it once it confirms no PDA.
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

  // 3a. Settled: charge the actual, refund the rest. The amount is the seller's
  // claim, so clamp it to the deposit — the on-chain program enforces
  // `cumulative <= deposit`, and a buggy or lying seller must not push a figure
  // past the ceiling into the store (which would throw) or the ledger. The
  // refund is always computed, never taken from the receipt (§4.3, §5).
  if (receipt?.success) {
    const claimed = receipt.actualMicro ?? 0n;
    const actual = claimed > depositMicro ? depositMicro : claimed;
    const refundMicro = depositMicro - actual;
    await upto.resolve(channelId, { kind: "settled", settledMicro: actual });
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

  // 3b. Refund: the seller settled with amount 0 (policy abort, handler threw,
  // declined) and the deposit came back. Record a 0 `payment` row so the ledger
  // shows the attempt (§4.3 row 2); release the hold and any grant fully.
  if (receipt?.transaction && (receipt.refundMicro ?? 0n) > 0n) {
    await upto.resolve(channelId, { kind: "refunded" });
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

  // 3c. No receipt, or success:false with no refund: the deposit may be on-chain
  // and unsettled — an orphan. Mark `unknown` for reconcile; release the hold.
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
