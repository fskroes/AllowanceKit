import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeStateFile } from "./state-file.ts";

export interface Reservation {
  id: string;
  at: string;
  agent: string;
  url: string;
  host: string;
  amountMicro: string;
  grantId?: string;
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
    writeStateFile(this.file, f);
  }

  private live(): Reservation[] {
    const cutoff = Date.now() - this.ttlMs;
    return this.read().open.filter((r) => Date.parse(r.at) >= cutoff);
  }

  open(agent: string, url: string, host: string, amountMicro: bigint, grantId?: string): Reservation {
    const res: Reservation = {
      id: crypto.randomBytes(6).toString("hex"),
      at: new Date().toISOString(),
      agent,
      url,
      host,
      amountMicro: amountMicro.toString(),
      ...(grantId ? { grantId } : {}),
    };
    this.write({ open: [...this.live(), res] });
    return res;
  }

  close(id: string): Reservation | undefined {
    const open = this.read().open;
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
