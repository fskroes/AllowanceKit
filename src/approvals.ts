import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeStateFile } from "./state-file.ts";

export interface ApprovalRequest {
  id: string;
  at: string;
  agent: string;
  url: string;
  host: string;
  amountMicro: string;
  status: "pending" | "approved" | "denied";
  decidedAt?: string;
  expiresAt?: string;
  grantBudgetMicro?: string;
  usedMicro?: string;
  settledChannels?: string[];
}

interface ApprovalFile {
  requests: ApprovalRequest[];
}

export interface DecideOptions {
  expiresInMs?: number | null;
  budgetMicro?: bigint;
}

export const DEFAULT_GRANT_TTL_MS = 24 * 60 * 60 * 1000;

export class ApprovalStore {
  private file: string;
  private agentName?: string;

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
    writeStateFile(this.file, f);
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

  private expired(r: ApprovalRequest, now = Date.now()): boolean {
    return r.expiresAt !== undefined && Date.parse(r.expiresAt) <= now;
  }

  remainingMicro(r: ApprovalRequest): bigint {
    const budget = BigInt(r.grantBudgetMicro ?? r.amountMicro);
    const used = BigInt(r.usedMicro ?? "0");
    const left = budget - used;
    return left > 0n ? left : 0n;
  }

  grantFor(host: string, amountMicro: bigint): ApprovalRequest | undefined {
    return this.list().find(
      (r) => r.status === "approved" && r.host === host && !this.expired(r) && this.remainingMicro(r) >= amountMicro,
    );
  }

  grantCovers(host: string, amountMicro: bigint): boolean {
    return this.grantFor(host, amountMicro) !== undefined;
  }

  commit(id: string, amountMicro: bigint): void {
    this.adjust(id, amountMicro);
  }

  refund(id: string, amountMicro: bigint): void {
    this.adjust(id, -amountMicro);
  }

  settleCommitment(id: string, committedMicro: bigint, actualMicro: bigint): void {
    const back = committedMicro - actualMicro;
    if (back > 0n) this.refund(id, back);
  }

  settleChannel(id: string, channelId: string, committedMicro: bigint, actualMicro: bigint): void {
    const f = this.read();
    const req = f.requests.find((r) => r.id === id && this.mine(r));
    if (!req || req.settledChannels?.includes(channelId)) return;
    const used = BigInt(req.usedMicro ?? "0") - (committedMicro - actualMicro);
    req.usedMicro = (used > 0n ? used : 0n).toString();
    req.settledChannels = [...(req.settledChannels ?? []), channelId];
    this.write(f);
  }

  private adjust(id: string, deltaMicro: bigint): void {
    const f = this.read();
    const req = f.requests.find((r) => r.id === id);
    if (!req) return;
    const used = BigInt(req.usedMicro ?? "0") + deltaMicro;
    req.usedMicro = (used > 0n ? used : 0n).toString();
    this.write(f);
  }

  activeGrants(): ApprovalRequest[] {
    return this.list().filter((r) => r.status === "approved" && !this.expired(r) && this.remainingMicro(r) > 0n);
  }
}
