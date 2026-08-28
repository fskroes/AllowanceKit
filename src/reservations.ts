import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Money that has been authorized but has not settled yet.
 *
 * Without this, `authorize()` reads spend from the ledger while an in-flight
 * payment has not been written to it, so N parallel calls all authorize
 * against the same stale total and the velocity and budget rails overspend.
 * A reservation is created inside the same lock as the policy decision and
 * counts as spend until it either settles into a payment or is released.
 *
 * Reservations older than `ttlMs` are ignored and pruned: a process that dies
 * mid-payment must not hold an agent's allowance hostage.
 */

export interface Reservation {
  id: string;
  at: string;
  agent: string;
  url: string;
  host: string;
  amountMicro: string;
}

interface ReservationFile {
  open: Reservation[];
}

export class ReservationStore {
  private file: string;
  private ttlMs: number;

  constructor(stateDir: string, ttlMs = 120_000) {
    fs.mkdirSync(stateDir, { recursive: true });
    this.file = path.join(stateDir, "reservations.json");
    this.ttlMs = ttlMs;
  }

  private read(): ReservationFile {
    if (!fs.existsSync(this.file)) return { open: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as ReservationFile;
      return { open: Array.isArray(parsed.open) ? parsed.open : [] };
    } catch {
      return { open: [] };
    }
  }

  private write(f: ReservationFile): void {
    fs.writeFileSync(this.file, JSON.stringify(f, null, 2));
  }

  private live(): Reservation[] {
    const cutoff = Date.now() - this.ttlMs;
    return this.read().open.filter((r) => Date.parse(r.at) >= cutoff);
  }

  /** Records an authorized-but-unsettled payment. Call inside the allowance lock. */
  open(agent: string, url: string, host: string, amountMicro: bigint): Reservation {
    const res: Reservation = {
      id: crypto.randomBytes(6).toString("hex"),
      at: new Date().toISOString(),
      agent,
      url,
      host,
      amountMicro: amountMicro.toString(),
    };
    this.write({ open: [...this.live(), res] });
    return res;
  }

  /** Drops a reservation — either it became a ledger payment, or it failed. */
  close(id: string): Reservation | undefined {
    const open = this.live();
    const found = open.find((r) => r.id === id);
    this.write({ open: open.filter((r) => r.id !== id) });
    return found;
  }

  list(agent: string): Reservation[] {
    return this.live().filter((r) => r.agent === agent);
  }

  total(agent: string): bigint {
    let sum = 0n;
    for (const r of this.list(agent)) sum += BigInt(r.amountMicro);
    return sum;
  }

  totalSince(agent: string, sinceMs: number): bigint {
    const cutoff = Date.now() - sinceMs;
    let sum = 0n;
    for (const r of this.list(agent)) if (Date.parse(r.at) >= cutoff) sum += BigInt(r.amountMicro);
    return sum;
  }
}
