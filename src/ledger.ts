import fs from "node:fs";
import path from "node:path";

export type LedgerEvent =
  | { t: "topup"; at: string; agent: string; amountMicro: string; source: string; balanceAfterMicro: string }
  | { t: "payment"; at: string; agent: string; url: string; host: string; amountMicro: string; txHash: string; balanceAfterMicro: string }
  | { t: "blocked"; at: string; agent: string; url: string; host: string; rule: string; detail: string; attemptedMicro: string }
  | { t: "policy_change"; at: string; agent: string; field: string; value: unknown };

export class Ledger {
  private file: string;

  constructor(stateDir: string) {
    fs.mkdirSync(stateDir, { recursive: true });
    this.file = path.join(stateDir, "ledger.jsonl");
    if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, "");
  }

  append(event: LedgerEvent): void {
    fs.appendFileSync(this.file, JSON.stringify(event) + "\n");
  }

  read(): LedgerEvent[] {
    const raw = fs.readFileSync(this.file, "utf8").trim();
    if (!raw) return [];
    return raw.split("\n").map((line) => JSON.parse(line) as LedgerEvent);
  }

  spendTotal(agent: string): bigint {
    let sum = 0n;
    for (const e of this.read()) if (e.t === "payment" && e.agent === agent) sum += BigInt(e.amountMicro);
    return sum;
  }

  spendSince(agent: string, sinceMs: number): bigint {
    const cutoff = new Date(Date.now() - sinceMs).toISOString();
    let sum = 0n;
    for (const e of this.read())
      if (e.t === "payment" && e.agent === agent && e.at >= cutoff) sum += BigInt(e.amountMicro);
    return sum;
  }

  topups(agent: string): bigint {
    let sum = 0n;
    for (const e of this.read()) if (e.t === "topup" && e.agent === agent) sum += BigInt(e.amountMicro);
    return sum;
  }
}
