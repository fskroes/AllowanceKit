import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * The queue of payments parked for a human, and the grants those decisions
 * produce.
 *
 * A decision is not a permanent exemption. An approved grant carries an expiry
 * and a spend budget, and every payment it covers draws that budget down, so
 * "yes, pay Reuters $0.40" cannot silently become "pay Reuters $0.40 forever".
 * The budget is committed when a payment is authorized and returned if that
 * payment never settles, which keeps the grant and the reservation ledger in
 * step.
 */

export interface ApprovalRequest {
  id: string;
  at: string;
  agent: string;
  url: string;
  host: string;
  amountMicro: string;
  status: "pending" | "approved" | "denied";
  decidedAt?: string;
  /** Approved grants only: when this grant stops covering payments. Absent means it never expires. */
  expiresAt?: string;
  /** Approved grants only: total spend the grant may cover. Defaults to the amount that was approved. */
  grantBudgetMicro?: string;
  /** How much of that budget is already committed to settled or in-flight payments. */
  usedMicro?: string;
}

interface ApprovalFile {
  requests: ApprovalRequest[];
}

export interface DecideOptions {
  /** How long the grant stays usable. `null` means it never expires. Defaults to 24 hours. */
  expiresInMs?: number | null;
  /** Total spend the grant may cover. Defaults to the amount that was requested. */
  budgetMicro?: bigint;
}

/** Grants are single-payment permissions unless a human deliberately widens them. */
export const DEFAULT_GRANT_TTL_MS = 24 * 60 * 60 * 1000;

export class ApprovalStore {
  private file: string;
  private agentName?: string;

  /** Pass `agentName` to scope every read to one agent sharing this directory. */
  constructor(stateDir: string, agentName?: string) {
    fs.mkdirSync(stateDir, { recursive: true });
    this.file = path.join(stateDir, "approvals.json");
    this.agentName = agentName;
    if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, JSON.stringify({ requests: [] }, null, 2));
  }

  private read(): ApprovalFile {
    return JSON.parse(fs.readFileSync(this.file, "utf8")) as ApprovalFile;
  }

  private write(f: ApprovalFile): void {
    fs.writeFileSync(this.file, JSON.stringify(f, null, 2));
  }

  private mine(r: ApprovalRequest): boolean {
    return this.agentName === undefined || r.agent === this.agentName;
  }

  list(): ApprovalRequest[] {
    return this.read().requests.filter((r) => this.mine(r));
  }

  pending(): ApprovalRequest[] {
    return this.list().filter((r) => r.status === "pending");
  }

  findOrCreate(agent: string, url: string, host: string, amountMicro: bigint): ApprovalRequest {
    const f = this.read();
    const existing = f.requests.find(
      (r) => r.status === "pending" && r.agent === agent && r.host === host && r.amountMicro === amountMicro.toString(),
    );
    if (existing) return existing;
    const req: ApprovalRequest = {
      id: crypto.randomBytes(4).toString("hex"),
      at: new Date().toISOString(),
      agent,
      url,
      host,
      amountMicro: amountMicro.toString(),
      status: "pending",
    };
    f.requests.push(req);
    this.write(f);
    return req;
  }

  decide(id: string, approve: boolean, opts: DecideOptions = {}): ApprovalRequest | undefined {
    const f = this.read();
    const req = f.requests.find((r) => r.id === id && r.status === "pending" && this.mine(r));
    if (!req) return undefined;
    req.status = approve ? "approved" : "denied";
    req.decidedAt = new Date().toISOString();
    if (approve) {
      const ttl = opts.expiresInMs === undefined ? DEFAULT_GRANT_TTL_MS : opts.expiresInMs;
      if (ttl !== null) req.expiresAt = new Date(Date.now() + ttl).toISOString();
      const budget = opts.budgetMicro ?? BigInt(req.amountMicro);
      req.grantBudgetMicro = budget.toString();
      req.usedMicro = "0";
    }
    this.write(f);
    return req;
  }

  /** True once the grant's window has closed. Undated grants never expire. */
  private expired(r: ApprovalRequest, now = Date.now()): boolean {
    return r.expiresAt !== undefined && Date.parse(r.expiresAt) <= now;
  }

  /** What is left on a grant: its budget minus everything already committed. */
  remainingMicro(r: ApprovalRequest): bigint {
    const budget = BigInt(r.grantBudgetMicro ?? r.amountMicro);
    const used = BigInt(r.usedMicro ?? "0");
    const left = budget - used;
    return left > 0n ? left : 0n;
  }

  /** The live grant that can pay for this call, if any. */
  grantFor(host: string, amountMicro: bigint): ApprovalRequest | undefined {
    return this.list().find(
      (r) => r.status === "approved" && r.host === host && !this.expired(r) && this.remainingMicro(r) >= amountMicro,
    );
  }

  grantCovers(host: string, amountMicro: bigint): boolean {
    return this.grantFor(host, amountMicro) !== undefined;
  }

  /** Draws down a grant when a payment is authorized against it. */
  commit(id: string, amountMicro: bigint): void {
    this.adjust(id, amountMicro);
  }

  /** Returns budget to a grant when the payment it covered never settled. */
  refund(id: string, amountMicro: bigint): void {
    this.adjust(id, -amountMicro);
  }

  private adjust(id: string, deltaMicro: bigint): void {
    const f = this.read();
    const req = f.requests.find((r) => r.id === id);
    if (!req) return;
    const used = BigInt(req.usedMicro ?? "0") + deltaMicro;
    req.usedMicro = (used > 0n ? used : 0n).toString();
    this.write(f);
  }

  /** Approved grants that can still cover a payment right now. */
  activeGrants(): ApprovalRequest[] {
    return this.list().filter((r) => r.status === "approved" && !this.expired(r) && this.remainingMicro(r) > 0n);
  }
}
