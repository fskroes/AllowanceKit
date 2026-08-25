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
