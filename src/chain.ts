import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AcceptsEntry, DecodedPayment, PaymentPayload, SettleResult, VerifyResult } from "./types.ts";

/**
 * Settlement rail behind the seller's paymentGate. verify/settle receive the
 * raw decoded X-PAYMENT object plus the advertised requirements, so any
 * facilitator (mock ledger, Coinbase CDP, self-hosted) can validate whatever
 * wire shape the buyer produced.
 */
export interface Facilitator {
  verify(payment: DecodedPayment, requirements: AcceptsEntry): Promise<VerifyResult>;
  settle(payment: DecodedPayment, requirements: AcceptsEntry): Promise<SettleResult>;
}

const NETWORK = "mock-ledger";

interface Snapshot {
  balances: Record<string, string>;
  keys: Record<string, string>;
  nonces: string[];
}

export class MockChain implements Facilitator {
  private balances = new Map<string, bigint>();
  private keys = new Map<string, string>();
  private nonces = new Set<string>();
  private snapPath?: string;

  constructor(snapshotPath?: string) {
    this.snapPath = snapshotPath;
    if (snapshotPath && fs.existsSync(snapshotPath)) {
      const snap = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as Snapshot;
      for (const [k, v] of Object.entries(snap.balances ?? {})) this.balances.set(k, BigInt(v));
      for (const [k, v] of Object.entries(snap.keys ?? {})) this.keys.set(k, v);
      for (const n of snap.nonces ?? []) this.nonces.add(n);
    }
  }

  private persist(): void {
    if (!this.snapPath) return;
    const snap: Snapshot = {
      balances: Object.fromEntries([...this.balances].map(([k, v]) => [k, v.toString()])),
      keys: Object.fromEntries(this.keys),
      nonces: [...this.nonces],
    };
    fs.mkdirSync(path.dirname(this.snapPath), { recursive: true });
    fs.writeFileSync(this.snapPath, JSON.stringify(snap, null, 2));
  }

  hasAccount(address: string): boolean {
    return this.keys.has(address);
  }

  createAccount(): { address: string; secretKey: string } {
    const secretKey = crypto.randomBytes(32).toString("hex");
    const address = "0x" + crypto.createHash("sha256").update(secretKey).digest().subarray(0, 20).toString("hex");
    this.balances.set(address, 0n);
    this.keys.set(address, secretKey);
    this.persist();
    return { address, secretKey };
  }

  faucet(address: string, amountMicro: bigint): void {
    this.balances.set(address, (this.balances.get(address) ?? 0n) + amountMicro);
    this.persist();
  }

  balance(address: string): bigint {
    return this.balances.get(address) ?? 0n;
  }

  sign(address: string, unsigned: Omit<PaymentPayload, "signature">): string {
    const secretKey = this.keys.get(address);
    if (!secretKey) throw new Error(`no key registered for ${address}`);
    return crypto.createHmac("sha256", secretKey).update(canonical(unsigned)).digest("hex");
  }

  private asFlat(p: DecodedPayment): PaymentPayload | null {
    const required = ["x402Version", "scheme", "network", "resource", "from", "payTo", "amount", "nonce", "timestamp", "signature"];
    for (const k of required) if (typeof p[k] !== "string" && typeof p[k] !== "number") return null;
    if (BigInt(String(p.amount)) < 0n) return null;
    return p as unknown as PaymentPayload;
  }

  async verify(decoded: DecodedPayment): Promise<VerifyResult> {
    const p = this.asFlat(decoded);
    if (!p) return { isValid: false, invalidReason: "payload shape not supported by mock-ledger facilitator" };
    const secretKey = this.keys.get(p.from);
    if (!secretKey) return { isValid: false, invalidReason: "unknown payer account" };
    const expected = crypto.createHmac("sha256", secretKey).update(canonical(p)).digest("hex");
    if (expected !== p.signature) return { isValid: false, invalidReason: "invalid signature" };
    if ((this.balances.get(p.from) ?? 0n) < BigInt(p.amount)) return { isValid: false, invalidReason: "insufficient funds" };
    return { isValid: true, payer: p.from };
  }

  async settle(decoded: DecodedPayment): Promise<SettleResult> {
    const p = this.asFlat(decoded);
    if (!p) return { success: false, error: "payload shape not supported by mock-ledger facilitator", network: NETWORK };
    const v = await this.verify(decoded);
    if (!v.isValid) return { success: false, error: v.invalidReason ?? "verification failed", network: NETWORK };
    if (this.nonces.has(p.nonce)) return { success: false, error: "nonce replay detected", network: NETWORK };
    this.nonces.add(p.nonce);
    this.balances.set(p.from, (this.balances.get(p.from) ?? 0n) - BigInt(p.amount));
    this.balances.set(p.payTo, (this.balances.get(p.payTo) ?? 0n) + BigInt(p.amount));
    this.persist();
    const txHash = "0x" + crypto.createHash("sha256").update(JSON.stringify(p)).digest("hex");
    return { success: true, txHash, network: NETWORK };
  }
}

function canonical(p: Omit<PaymentPayload, "signature">): string {
  return [p.x402Version, p.scheme, p.network, p.resource, p.from, p.payTo, p.amount, p.nonce, p.timestamp].join("|");
}
