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
