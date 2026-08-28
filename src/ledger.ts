import fs from "node:fs";
import path from "node:path";

export type LedgerEvent =
  | { t: "topup"; at: string; agent: string; amountMicro: string; source: string; balanceAfterMicro: string }
  | { t: "payment"; at: string; agent: string; url: string; host: string; amountMicro: string; txHash: string; balanceAfterMicro: string }
  | { t: "blocked"; at: string; agent: string; url: string; host: string; rule: string; detail: string; attemptedMicro: string }
  | { t: "policy_change"; at: string; agent: string; field: string; value: unknown }
  | { t: "approval_requested"; at: string; agent: string; id: string; url: string; host: string; amountMicro: string }
  | { t: "approval_decided"; at: string; agent: string; id: string; approved: boolean; host: string; amountMicro: string };

export interface LedgerTotals {
  topupsMicro: bigint;
  spendTotalMicro: bigint;
  windowSpendMicro: bigint;
  payments: number;
  blocks: number;
}

export class Ledger {
  private file: string;
  private cache: LedgerEvent[] | null = null;
  private cacheKey = "";

  constructor(stateDir: string) {
    fs.mkdirSync(stateDir, { recursive: true });
    this.file = path.join(stateDir, "ledger.jsonl");
    if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, "");
  }

  append(event: LedgerEvent): void {
    fs.appendFileSync(this.file, JSON.stringify(event) + "\n");
    this.cache = null;
  }

  /**
   * The whole log. Re-parsed only when the file actually changed — `authorize()`
   * needs several totals per call and the audit log is append-only, so parsing
   * it once per mutation instead of once per question keeps a busy agent linear.
   */
  read(): LedgerEvent[] {
    let key = "";
    try {
      const st = fs.statSync(this.file);
      key = `${st.size}:${st.mtimeMs}`;
    } catch {
      return [];
    }
    if (this.cache && key === this.cacheKey) return this.cache;

    const raw = fs.readFileSync(this.file, "utf8").trim();
    const events: LedgerEvent[] = [];
    if (raw) {
      const lines = raw.split("\n");
      for (let i = 0; i < lines.length; i++) {
        try {
          events.push(JSON.parse(lines[i]) as LedgerEvent);
        } catch {
          throw new Error(`${this.file} is corrupt at line ${i + 1} — the audit ledger could not be parsed`);
        }
      }
    }
    this.cache = events;
    this.cacheKey = key;
    return events;
  }

  /** Every figure the policy engine needs, in one pass. */
  totals(agent: string, windowMs: number): LedgerTotals {
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    let topupsMicro = 0n;
    let spendTotalMicro = 0n;
    let windowSpendMicro = 0n;
    let payments = 0;
    let blocks = 0;
    for (const e of this.read()) {
      if (e.agent !== agent) continue;
      if (e.t === "topup") topupsMicro += BigInt(e.amountMicro);
      else if (e.t === "payment") {
        payments++;
        const amount = BigInt(e.amountMicro);
        spendTotalMicro += amount;
        if (e.at >= cutoff) windowSpendMicro += amount;
      } else if (e.t === "blocked") blocks++;
    }
    return { topupsMicro, spendTotalMicro, windowSpendMicro, payments, blocks };
  }

  spendTotal(agent: string): bigint {
    return this.totals(agent, 0).spendTotalMicro;
  }

  spendSince(agent: string, sinceMs: number): bigint {
    return this.totals(agent, sinceMs).windowSpendMicro;
  }

  topups(agent: string): bigint {
    return this.totals(agent, 0).topupsMicro;
  }
}
