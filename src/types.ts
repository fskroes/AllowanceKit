import crypto from "node:crypto";

export interface AcceptsEntry {
  scheme: string;
  network: string;
  maxAmountRequired?: string;
  amount?: string;
  resource?: string;
  description?: string;
  mimeType?: string;
  payTo?: string;
  asset?: string;
  recipient?: string;
  currency?: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

export function offerAmount(offer: AcceptsEntry): string | undefined {
  return offer.amount ?? offer.maxAmountRequired;
}

export function offerPayTo(offer: AcceptsEntry): string | undefined {
  return offer.payTo ?? offer.recipient;
}

export function offerAsset(offer: AcceptsEntry): string | undefined {
  return offer.asset ?? offer.currency;
}

export interface PaymentRequiredBody {
  x402Version: number;
  error?: string;
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

export interface SolanaExactPayload {
  transaction: string;
}

export interface UptoPayload {
  channelId: string;
  from: string;
  maxAmount: string;
  deposit?: string;
  expiresAt: number;
  validAfter?: number;
  openSlot?: string | number;
  openTransaction?: string;
  nonce?: string;
  type?: "deposit" | "claim";
  authorizedSigner?: string;
  voucherSignature?: string;
}

export type ChannelStatus = "opened" | "settled" | "refunded" | "unknown" | "orphaned" | "reclaimed";

export interface ChannelRecord {
  channelId: string;
  at: string;
  agent: string;
  url: string;
  host: string;
  network: string;
  status: ChannelStatus;
  depositMicro: string;
  settledMicro: string;
  refundMicro: string;
  withdrawDelay: number;
  openSlot?: number;
  payer?: string;
  payee?: string;
  authorizedSigner?: string;
  mint?: string;
  txHash?: string;
  reservationId?: string;
  grantId?: string;
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
