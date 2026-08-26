import crypto from "node:crypto";
import type { Facilitator } from "./chain.ts";
import type { AcceptsEntry, DecodedPayment, SettleResult, VerifyResult } from "./types.ts";

/**
 * Facilitator backed by the Coinbase Developer Platform (CDP) x402 API — the
 * facilitator used by most live x402 sellers on Base.
 *
 *   verify → POST {baseUrl}/platform/v2/x402/verify
 *   settle → POST {baseUrl}/platform/v2/x402/settle
 *
 * Auth is a short-lived ES256 JWT signed with the EC private key of a CDP
 * API key (portal.cdp.coinbase.com → Keys). Credentials come from options or
 * the CDP_API_KEY_ID / CDP_API_KEY_SECRET environment variables. The secret
 * is the full EC private key in PEM ("-----BEGIN EC PRIVATE KEY-----").
 *
 * Wire format follows the x402 v1 facilitator contract: the decoded
 * X-PAYMENT object plus the advertised PaymentRequirements are posted as
 * { x402Version, paymentPayload, paymentRequirements }; responses are
 * { isValid?, invalidReason? } and { success, txHash?, network?, error? }.
 */
export interface CdpFacilitatorOptions {
  apiKeyId?: string;
  apiKeySecret?: string;
  baseUrl?: string;
  /** x402Version advertised to the facilitator (default 1) */
  x402Version?: number;
}

interface CdpVerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

interface CdpSettleResponse {
  success: boolean;
  errorReason?: string;
  error?: string;
  txHash?: string;
  network?: string;
  payer?: string;
}

export class CdpFacilitator implements Facilitator {
  readonly apiKeyId: string;
  private readonly privateKey: string;
  private readonly baseUrl: string;
  private readonly x402Version: number;

  constructor(opts: CdpFacilitatorOptions = {}) {
    this.apiKeyId = opts.apiKeyId ?? process.env.CDP_API_KEY_ID ?? "";
    const secret = opts.apiKeySecret ?? process.env.CDP_API_KEY_SECRET ?? "";
    if (!this.apiKeyId || !secret)
      throw new Error(
        "CdpFacilitator requires an EC API key: pass apiKeyId/apiKeySecret or set CDP_API_KEY_ID and CDP_API_KEY_SECRET",
      );
    this.privateKey = normalizePem(secret);
    this.baseUrl = (opts.baseUrl ?? "https://api.cdp.coinbase.com").replace(/\/+$/, "");
    this.x402Version = opts.x402Version ?? 1;
  }

  async verify(payment: DecodedPayment, requirements: AcceptsEntry): Promise<VerifyResult> {
    const res = await this.call("verify", payment, requirements);
    return { isValid: Boolean(res.isValid), invalidReason: res.invalidReason, payer: res.payer };
  }

  async settle(payment: DecodedPayment, requirements: AcceptsEntry): Promise<SettleResult> {
    const res = await this.call("settle", payment, requirements);
    return {
      success: Boolean(res.success),
      error: res.error ?? res.errorReason,
      txHash: res.txHash,
      network: res.network ?? requirements.network,
    };
  }

  private async call(action: "verify" | "settle", payment: DecodedPayment, requirements: AcceptsEntry): Promise<CdpVerifyResponse & CdpSettleResponse> {
    const path = `/platform/v2/x402/${action}`;
    const token = this.jwt("POST", path);
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        x402Version: this.x402Version,
        paymentPayload: payment,
        paymentRequirements: stripUndefined(requirements),
      }),
    });
    if (!res.ok) throw new Error(`cdp ${action} failed: HTTP ${res.status} ${truncate(await res.text())}`);
    return await res.json() as CdpVerifyResponse & CdpSettleResponse;
  }

  /** Short-lived ES256 JWT per Coinbase CDP request-signing spec. */
  jwt(method: string, urlPath: string, now = Math.floor(Date.now() / 1000)): string {
    const header = b64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid: this.apiKeyId, nonce: crypto.randomUUID() }));
    const claims = b64url(JSON.stringify({
      sub: this.apiKeyId,
      iss: "cdp",
      aud: ["cdp-service"],
      nbf: now,
      exp: now + 120,
      uris: [method.toUpperCase(), `${new URL(this.baseUrl).host}${urlPath}`],
    }));
    const der = crypto.createSign("SHA256").update(`${header}.${claims}`).sign(this.privateKey);
    return `${header}.${claims}.${b64url(derToRawEs256(der))}`;
  }
}

function normalizePem(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.includes("-----BEGIN")) return trimmed.replace(/\\n/g, "\n");
  // Raw base64 body without armor — wrap it as PKCS#8 EC key.
  const lines = trimmed.match(/.{1,64}/g)?.join("\n") ?? trimmed;
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/** Convert ASN.1 DER ECDSA sig to the raw r||s (64 bytes) form JWTs require. */
export function derToRawEs256(der: Buffer): Buffer {
  if (der[0] !== 0x30) throw new Error("bad DER sequence");
  let i = 2;
  if (der[i++] !== 0x02) throw new Error("bad DER integer r");
  const rLen = der[i++];
  const r = stripLeadingZero(der.subarray(i, i + rLen));
  i += rLen;
  if (der[i++] !== 0x02) throw new Error("bad DER integer s");
  const sLen = der[i++];
  const s = stripLeadingZero(der.subarray(i, i + sLen));
  if (r.length > 32 || s.length > 32) throw new Error("ES256 component exceeds 32 bytes");
  const out = Buffer.alloc(64);
  r.copy(out, 32 - r.length);
  s.copy(out, 64 - s.length);
  return out;
}

function stripLeadingZero(b: Buffer): Buffer {
  // DER may prepend 0x00 when the positive integer's high bit is set.
  return b.length > 1 && b[0] === 0x00 ? b.subarray(1) : b;
}

function stripUndefined(obj: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

function truncate(s: string, max = 300): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
