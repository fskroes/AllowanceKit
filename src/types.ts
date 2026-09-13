import crypto from "node:crypto";

export interface AcceptsEntry {
  scheme: string;
  network: string;
  /**
   * v1 price field. x402 v2 sellers name it `amount` instead and omit this
   * (x402-compat.md §5; §4b/4c/4d emit `amount` only) — read via `offerAmount`.
   */
  maxAmountRequired?: string;
  /** v2 price field (x402-compat.md §5). Preferred over `maxAmountRequired`. */
  amount?: string;
  /** Present on v1 offers; v2 carries the resource in a top-level object instead. */
  resource?: string;
  description?: string;
  mimeType?: string;
  payTo?: string;
  asset?: string;
  /** v2 aliases the CDP bazaar dual-populates (x402-compat.md §4a). */
  recipient?: string;
  currency?: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

/**
 * The advertised price in micro-dollars, from whichever field the seller used.
 * v2 sends `amount`, v1 sends `maxAmountRequired` (x402-compat.md §5).
 */
export function offerAmount(offer: AcceptsEntry): string | undefined {
  return offer.amount ?? offer.maxAmountRequired;
}

/** Where the money goes. v2 keeps `payTo`; the CDP bazaar also mirrors `recipient` (§4a). */
export function offerPayTo(offer: AcceptsEntry): string | undefined {
  return offer.payTo ?? offer.recipient;
}

/** The token contract. v2 keeps `asset`; the CDP bazaar also mirrors `currency` (§4a). */
export function offerAsset(offer: AcceptsEntry): string | undefined {
  return offer.asset ?? offer.currency;
}

export interface PaymentRequiredBody {
  x402Version: number;
  error?: string;
  /** v2 carries the resource metadata at the top level, beside `accepts` (spec §5.1). */
  resource?: string | { url?: string; description?: string; mimeType?: string };
  accepts: AcceptsEntry[];
}

export interface PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  resource: string;
  from: string;
  payTo: string;
  amount: string;
  nonce: string;
  timestamp: number;
  signature: string;
}

/**
 * The Solana `exact` payment body: a base64 v0 transaction, payer signed and
 * `extra.feePayer` left unsigned. It rides inside the same header envelope as
 * the EVM shapes (`payload.transaction`), so the decoded payment reads it under
 * `payload`.
 */
export interface SolanaExactPayload {
  transaction: string;
}

/**
 * Where a Solana `upto` channel is in its life, from the buyer's point of view.
 * Escrow is a third money state (docs/SOLANA-ARCHITECTURE.md §0, §3.3): a
 * deposit is neither spent nor available while it sits in an open channel.
 *
 * - `opened`    the deposit was sent; the seller has not settled yet
 * - `settled`   the seller claimed `settledMicro`; `refundMicro` came back
 * - `refunded`  the seller settled with amount 0; the whole deposit came back
 * - `unknown`   the send raced a timeout/5xx; on-chain state not yet read
 * - `orphaned`  confirmed still open with no settle; the reclaim clock is running
 * - `reclaimed` the payer took `deposit − settled` back via the escape path
 */
export type ChannelStatus = "opened" | "settled" | "refunded" | "unknown" | "orphaned" | "reclaimed";

/**
 * One Solana `upto` payment channel, as the buyer tracks it in
 * `.allowance/channels.json`. Micro-dollar amounts are strings on disk (the
 * `Reservation` convention), summed to `bigint` by the store. `depositMicro`
 * is the ceiling that left the wallet at `open`; `settledMicro` is what the
 * seller actually claimed; `refundMicro` is what returned (`deposit − settled`).
 */
export interface ChannelRecord {
  /** The channel PDA address — the primary key, unique per incarnation. */
  channelId: string;
  /** ISO timestamp when the deposit was recorded (before the open was sent). */
  at: string;
  agent: string;
  url: string;
  host: string;
  /** v1 bare name or CAIP-2 id the channel was opened on. */
  network: string;
  status: ChannelStatus;
  /** The deposit ceiling, micro-dollars. */
  depositMicro: string;
  /** What the seller claimed, micro-dollars; "0" until a settle is known. */
  settledMicro: string;
  /** What returned to the wallet, micro-dollars; "0" until settle/refund/reclaim. */
  refundMicro: string;
  /** The channel `grace_period` in seconds — also the payer's reclaim wait. */
  withdrawDelay: number;
  /** The slot the channel opened at; a PDA seed and the rent-reclaim gate. */
  openSlot?: number;
  /** The payer (this wallet) — refund destination and escape-path authority. */
  payer?: string;
  /** The seller's fee-payer, which is the channel `payee`. */
  payee?: string;
  /** The seller key that signs the voucher (`authorized_signer`). */
  authorizedSigner?: string;
  /** The USDC mint the channel escrows. */
  mint?: string;
  /** The `open` transaction signature, once broadcast. */
  txHash?: string;
  /** The reservation this escrow converted from, so a drop hands the budget back. */
  reservationId?: string;
  /** ISO timestamp the channel was marked `orphaned` — the reclaim clock's start. */
  orphanedAt?: string;
}

export type DecodedPayment = Record<string, unknown>;

export function flatAmount(payment: DecodedPayment): string | null {
  const direct = payment.amount;
  if (typeof direct === "string" && /^\d+$/.test(direct)) return direct;
  const inner = payment.payload as { authorization?: { value?: unknown } } | undefined;
  const value = inner?.authorization?.value;
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  return null;
}

export function payerOf(payment: DecodedPayment): string | null {
  if (typeof payment.from === "string") return payment.from;
  const inner = payment.payload as { authorization?: { from?: unknown } } | undefined;
  return typeof inner?.authorization?.from === "string" ? inner.authorization.from : null;
}

export function payeeOf(payment: DecodedPayment): string | null {
  if (typeof payment.payTo === "string") return payment.payTo;
  const inner = payment.payload as { authorization?: { to?: unknown } } | undefined;
  return typeof inner?.authorization?.to === "string" ? inner.authorization.to : null;
}

export interface VerifyResult {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

export interface SettleResult {
  success: boolean;
  error?: string;
  txHash?: string;
  network: string;
}

export function randomNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}
