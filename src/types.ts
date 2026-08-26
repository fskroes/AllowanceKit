import crypto from "node:crypto";

export interface AcceptsEntry {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  asset: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

export interface PaymentRequiredBody {
  x402Version: number;
  error?: string;
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
