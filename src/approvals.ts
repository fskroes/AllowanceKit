import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface ApprovalRequest {
  id: string;
  at: string;
  agent: string;
  url: string;
  host: string;
  amountMicro: string;
  status: "pending" | "approved" | "denied";
  decidedAt?: string;
}

interface ApprovalFile {
  requests: ApprovalRequest[];
}

export class ApprovalStore {
  private file: string;

  constructor(stateDir: string) {
    fs.mkdirSync(stateDir, { recursive: true });
    this.file = path.join(stateDir, "approvals.json");
    if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, JSON.stringify({ requests: [] }, null, 2));
  }

  private read(): ApprovalFile {
    return JSON.parse(fs.readFileSync(this.file, "utf8")) as ApprovalFile;
  }

  private write(f: ApprovalFile): void {
    fs.writeFileSync(this.file, JSON.stringify(f, null, 2));
  }

  list(): ApprovalRequest[] {
    return this.read().requests;
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

  decide(id: string, approve: boolean): ApprovalRequest | undefined {
    const f = this.read();
    const req = f.requests.find((r) => r.id === id && r.status === "pending");
    if (!req) return undefined;
    req.status = approve ? "approved" : "denied";
    req.decidedAt = new Date().toISOString();
    this.write(f);
    return req;
  }

  grantCovers(host: string, amountMicro: bigint): boolean {
    return this.list().some(
      (r) => r.status === "approved" && r.host === host && BigInt(r.amountMicro) >= amountMicro,
    );
  }
}
