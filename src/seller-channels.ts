import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { looksLikeAddress } from "./base58.ts";
import { solanaNetworkInfo } from "./solana.ts";
import { withLock } from "./lock.ts";

/** Public facts required by @x402/svm's UptoChannelStorage contract. No keys or vouchers. */
export interface SellerChannelRecord {
  channelId: string;
  payTo: string;
  tokenProgram: string;
  firstSeenAt: number;
  expiresAt: number;
  network: string;
}

export function sellerStateDir(): string {
  return path.resolve(process.env.ALLOWANCE_SELLER_STATE_DIR ?? ".allowance-seller");
}

function checked(value: unknown): SellerChannelRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid channel record");
  const r = value as Record<string, unknown>;
  if (typeof r.channelId !== "string" || !looksLikeAddress(r.channelId) ||
      typeof r.payTo !== "string" || (r.payTo !== "" && !looksLikeAddress(r.payTo)) ||
      typeof r.tokenProgram !== "string" || (r.tokenProgram !== "" && !looksLikeAddress(r.tokenProgram)) ||
      typeof r.network !== "string" || !solanaNetworkInfo(r.network) ||
      !Number.isSafeInteger(r.firstSeenAt) || Number(r.firstSeenAt) < 0 ||
      !Number.isSafeInteger(r.expiresAt) || Number(r.expiresAt) < 0) throw new Error("invalid channel facts");
  // Project onto the contract so callers cannot accidentally persist secrets.
  return {
    channelId: r.channelId, payTo: r.payTo, tokenProgram: r.tokenProgram,
    network: r.network, firstSeenAt: Number(r.firstSeenAt), expiresAt: Number(r.expiresAt),
  };
}

/**
 * Durable adapter for the library's channel index. Each mutation reloads under
 * the existing filesystem lock, then atomically replaces a mode-0600 file.
 * Missing files start empty; corrupt or unreadable files fail closed.
 */
export class SellerChannelStorage {
  readonly file: string;
  private readonly lockPath: string;

  constructor(stateDir = sellerStateDir()) {
    this.file = path.join(path.resolve(stateDir), "seller-channels.json");
    this.lockPath = `${this.file}.lock`;
  }

  private read(): SellerChannelRecord[] {
    let raw: string;
    try { raw = fs.readFileSync(this.file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    try {
      const data = JSON.parse(raw);
      if (data?.version !== 1 || !Array.isArray(data.channels)) throw new Error("invalid format");
      const rows = data.channels.map(checked) as SellerChannelRecord[];
      if (new Set(rows.map(r => r.channelId)).size !== rows.length) throw new Error("duplicate channel id");
      return rows;
    } catch {
      throw new Error(`seller channel state is corrupt at ${this.file}; restore it before accepting deposits or sweeping`);
    }
  }

  private write(channels: SellerChannelRecord[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify({ version: 1, channels }) + "\n", { mode: 0o600, flag: "wx", flush: true });
      fs.renameSync(temp, this.file);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }

  async get(channelId: string): Promise<SellerChannelRecord | undefined> {
    return this.read().find(r => r.channelId === channelId);
  }

  async list(): Promise<SellerChannelRecord[]> { return this.read(); }

  async upsert(record: SellerChannelRecord): Promise<void> {
    const next = checked(record);
    await withLock(this.lockPath, () => {
      const rows = this.read();
      const index = rows.findIndex(r => r.channelId === next.channelId);
      if (index < 0) rows.push(next);
      else {
        const old = rows[index];
        // Distribution preimages are immutable. Discovery must not erase them.
        if (old.network !== next.network || (old.payTo && next.payTo && old.payTo !== next.payTo) ||
            (old.tokenProgram && next.tokenProgram && old.tokenProgram !== next.tokenProgram)) {
          throw new Error(`seller channel ${next.channelId} has conflicting immutable facts`);
        }
        rows[index] = {
          ...next, payTo: old.payTo || next.payTo, tokenProgram: old.tokenProgram || next.tokenProgram,
          firstSeenAt: Math.min(old.firstSeenAt, next.firstSeenAt), expiresAt: Math.max(old.expiresAt, next.expiresAt),
        };
      }
      this.write(rows);
    });
  }

  async delete(channelId: string): Promise<void> {
    await withLock(this.lockPath, () => {
      const rows = this.read();
      const remaining = rows.filter(r => r.channelId !== channelId);
      if (remaining.length !== rows.length) this.write(remaining);
    });
  }
}
