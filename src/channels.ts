import fs from "node:fs";
import path from "node:path";
import { base58Decode, looksLikeAddress } from "./base58.ts";
import { decodeVoucher } from "./voucher.ts";
import { Ledger } from "./ledger.ts";
import { ReservationStore } from "./reservations.ts";
import { ApprovalStore } from "./approvals.ts";
import { writeStateFile } from "./state-file.ts";
import { solanaNetworkInfo, type SolanaSigner } from "./solana.ts";
import { readMode } from "./mode.ts";
import type { ChannelRecord, ChannelStatus } from "./types.ts";
import { RpcError } from "./usdc.ts";

export const PAYMENT_CHANNELS_PROGRAM = "CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX";

const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

export const CHANNEL_STATUS = { OPEN: 0, SEALED: 1, CLOSING: 2, DISTRIBUTED: 3 } as const;

const ESCROWED_STATUSES: ReadonlySet<ChannelStatus> = new Set(["opened", "unknown", "orphaned"]);

const TERMINAL_STATUSES: ReadonlySet<ChannelStatus> = new Set(["settled", "refunded", "reclaimed"]);

interface ChannelFile {
  channels: ChannelRecord[];
}

export interface OpenChannelInput {
  channelId: string;
  agent: string;
  url: string;
  host: string;
  network: string;
  depositMicro: bigint;
  withdrawDelay: number;
  openSlot?: number;
  payer?: string;
  payee?: string;
  authorizedSigner?: string;
  mint?: string;
  txHash?: string;
  reservationId?: string;
}

export class ChannelStore {
  private file: string;
  readonly stateDir: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    fs.mkdirSync(stateDir, { recursive: true });
    this.file = path.join(stateDir, "channels.json");
  }

  private read(): ChannelFile {
    if (!fs.existsSync(this.file)) return { channels: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as ChannelFile;
      if (!parsed || !Array.isArray(parsed.channels)) throw new Error("expected channels array");
      const ids = new Set<string>();
      for (const c of parsed.channels) {
        if (!c || typeof c !== "object" ||
          ![c.channelId, c.agent, c.url, c.host, c.network, c.at].every((v) => typeof v === "string" && v.length > 0) ||
          !Number.isFinite(Date.parse(c.at)) || ids.has(c.channelId) ||
          !["opened", "unknown", "orphaned", "settled", "refunded", "reclaimed"].includes(c.status) ||
          ![c.depositMicro, c.settledMicro, c.refundMicro].every((v) => typeof v === "string" && /^\d+$/.test(v)) ||
          !Number.isSafeInteger(c.withdrawDelay) || c.withdrawDelay < 0 ||
          BigInt(c.settledMicro) + BigInt(c.refundMicro) > BigInt(c.depositMicro) ||
          (TERMINAL_STATUSES.has(c.status) && BigInt(c.settledMicro) + BigInt(c.refundMicro) !== BigInt(c.depositMicro)))
          throw new Error("invalid or duplicate channel record");
        ids.add(c.channelId);
      }
      return parsed;
    } catch (e) {
      throw new Error(`${this.file} is corrupt or unreadable; escrow accounting is blocked`, { cause: e });
    }
  }

  private write(f: ChannelFile): void {
    writeStateFile(this.file, f);
  }

  add(input: OpenChannelInput): ChannelRecord {
    if (input.depositMicro < 0n) throw new Error(`channel deposit cannot be negative, got ${input.depositMicro}`);
    const all = this.read().channels;
    if (all.some((c) => c.channelId === input.channelId))
      throw new Error(`channel ${input.channelId} is already recorded — a PDA is unique per incarnation, this is a replay`);

    const reservation = input.reservationId
      ? new ReservationStore(this.stateDir).list(input.agent).find((r) => r.id === input.reservationId)
      : undefined;
    const rec: ChannelRecord = {
      channelId: input.channelId,
      at: new Date().toISOString(),
      agent: input.agent,
      url: input.url,
      host: input.host,
      network: input.network,
      status: "opened",
      depositMicro: input.depositMicro.toString(),
      settledMicro: "0",
      refundMicro: "0",
      withdrawDelay: input.withdrawDelay,
      ...(input.openSlot !== undefined ? { openSlot: input.openSlot } : {}),
      ...(input.payer ? { payer: input.payer } : {}),
      ...(input.payee ? { payee: input.payee } : {}),
      ...(input.authorizedSigner ? { authorizedSigner: input.authorizedSigner } : {}),
      ...(input.mint ? { mint: input.mint } : {}),
      ...(input.txHash ? { txHash: input.txHash } : {}),
      ...(input.reservationId ? { reservationId: input.reservationId } : {}),
      ...(reservation?.grantId ? { grantId: reservation.grantId } : {}),
    };
    this.write({ channels: [...all, rec] });
    return rec;
  }

  get(channelId: string): ChannelRecord | undefined {
    return this.read().channels.find((c) => c.channelId === channelId);
  }

  list(agent?: string): ChannelRecord[] {
    const all = this.read().channels;
    return agent ? all.filter((c) => c.agent === agent) : all;
  }

  active(agent?: string): ChannelRecord[] {
    return this.list(agent).filter((c) => ESCROWED_STATUSES.has(c.status));
  }

  private mutate(channelId: string, fn: (c: ChannelRecord) => ChannelRecord): ChannelRecord {
    const all = this.read().channels;
    const idx = all.findIndex((c) => c.channelId === channelId);
    if (idx === -1) throw new Error(`no channel ${channelId} in the store`);
    if (TERMINAL_STATUSES.has(all[idx].status))
      throw new Error(`channel ${channelId} is already ${all[idx].status} — a terminal state cannot change`);
    const next = fn(all[idx]);
    if (TERMINAL_STATUSES.has(next.status)) this.account(next);
    all[idx] = next;
    this.write({ channels: all });
    return next;
  }

  private account(c: ChannelRecord): void {
    const ledger = new Ledger(this.stateDir);
    const existing = ledger.read().find((e) => e.t === "payment" && e.channelId === c.channelId);
    if (existing?.t === "payment") {
      if (existing.agent !== c.agent || existing.amountMicro !== c.settledMicro)
        throw new Error(`channel ${c.channelId} settlement conflicts with its audit payment`);
    } else {
      ledger.append({ t: "payment", at: new Date().toISOString(), agent: c.agent, url: c.url, host: c.host,
        amountMicro: c.settledMicro, txHash: c.txHash ?? "", balanceAfterMicro:
          (ledger.topups(c.agent) - ledger.spendTotal(c.agent) - BigInt(c.settledMicro)).toString(),
        scheme: "upto", depositMicro: c.depositMicro, refundMicro: c.refundMicro, channelId: c.channelId });
    }
    if (c.grantId) new ApprovalStore(this.stateDir, c.agent).settleChannel(c.grantId, c.channelId,
      BigInt(c.depositMicro), BigInt(c.settledMicro));
    if (c.reservationId) new ReservationStore(this.stateDir).close(c.reservationId);
  }

  repairAccounting(agent?: string): void {
    const paid = new Map(new Ledger(this.stateDir).read().flatMap((e) => e.t === "payment" && e.channelId ? [[e.channelId, e] as const] : []));
    for (const c of this.list(agent)) {
      if (TERMINAL_STATUSES.has(c.status) && !paid.has(c.channelId)) this.account(c);
      else if (ESCROWED_STATUSES.has(c.status)) {
        const payment = paid.get(c.channelId);
        if (!payment) continue;
        if (payment.agent !== c.agent || payment.depositMicro !== c.depositMicro ||
            BigInt(payment.amountMicro) + BigInt(payment.refundMicro ?? "-1") !== BigInt(c.depositMicro))
          throw new Error(`channel ${c.channelId} audit payment cannot establish its refund`);
        if (payment.amountMicro === "0") this.refund(c.channelId, payment.txHash);
        else this.settle(c.channelId, BigInt(payment.amountMicro), payment.txHash);
      }
    }
  }

  settle(channelId: string, settledMicro: bigint, txHash?: string): ChannelRecord {
    return this.mutate(channelId, (c) => {
      const deposit = BigInt(c.depositMicro);
      if (settledMicro < 0n) throw new Error(`settled amount cannot be negative, got ${settledMicro}`);
      if (settledMicro > deposit)
        throw new Error(`settled ${settledMicro} exceeds the deposit ${deposit} on channel ${channelId}`);
      return {
        ...c,
        status: "settled",
        settledMicro: settledMicro.toString(),
        refundMicro: (deposit - settledMicro).toString(),
        ...(txHash ? { txHash } : {}),
      };
    });
  }

  refund(channelId: string, txHash?: string): ChannelRecord {
    return this.mutate(channelId, (c) => ({
      ...c,
      status: "refunded",
      settledMicro: "0",
      refundMicro: c.depositMicro,
      ...(txHash ? { txHash } : {}),
    }));
  }

  markUnknown(channelId: string): ChannelRecord {
    return this.mutate(channelId, (c) => ({ ...c, status: "unknown" }));
  }

  markOrphaned(channelId: string, nowMs = Date.now()): ChannelRecord {
    return this.mutate(channelId, (c) => ({
      ...c,
      status: "orphaned",
      orphanedAt: c.orphanedAt ?? new Date(nowMs).toISOString(),
    }));
  }

  markReclaimed(channelId: string, refundMicro?: bigint): ChannelRecord {
    const existing = this.get(channelId);
    if (existing && TERMINAL_STATUSES.has(existing.status) && refundMicro !== undefined && BigInt(existing.refundMicro) === refundMicro)
      return existing;
    return this.mutate(channelId, (c) => {
      const deposit = BigInt(c.depositMicro);
      if (refundMicro === undefined) {
        return { ...c, status: "reclaimed", refundMicro: (deposit - BigInt(c.settledMicro)).toString() };
      }
      if (refundMicro < 0n || refundMicro > deposit)
        throw new Error(`reclaim refund ${refundMicro} is outside the deposit ${deposit} on channel ${channelId}`);
      return {
        ...c,
        status: "reclaimed",
        settledMicro: (deposit - refundMicro).toString(),
        refundMicro: refundMicro.toString(),
      };
    });
  }

  drop(channelId: string): ChannelRecord | undefined {
    const all = this.read().channels;
    const found = all.find((c) => c.channelId === channelId);
    if (found && ESCROWED_STATUSES.has(found.status)) throw new Error(`channel ${channelId} has unresolved escrow and cannot be dropped`);
    if (found) this.write({ channels: all.filter((c) => c.channelId !== channelId) });
    return found;
  }

  escrowedMicro(agent?: string, opts: { excludeReservationIds?: ReadonlySet<string> } = {}): bigint {
    const exclude = opts.excludeReservationIds;
    let sum = 0n;
    for (const c of this.active(agent)) {
      if (exclude && c.reservationId !== undefined && exclude.has(c.reservationId)) continue;
      sum += BigInt(c.depositMicro);
    }
    return sum;
  }

  dueForReclaim(agent?: string, nowMs = Date.now()): ChannelRecord[] {
    return this.list(agent).filter((c) => {
      if (c.status !== "orphaned" || !c.orphanedAt) return false;
      return nowMs >= Date.parse(c.orphanedAt) + c.withdrawDelay * 1000;
    });
  }
}

export interface ChannelOnChain {
  status: number;
  depositMicro: bigint;
  settledMicro: bigint;
  closureStartedAt: bigint;
  payerWithdrawnAt: bigint;
  gracePeriod: number;
}

function readU64LE(b: Uint8Array, o: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]);
  return v;
}

function readI64LE(b: Uint8Array, o: number): bigint {
  const u = readU64LE(b, o);
  return u > (1n << 63n) - 1n ? u - (1n << 64n) : u;
}

export function decodeChannelAccount(data: Uint8Array): ChannelOnChain {
  if (data.length < 256) throw new RpcError(`channel account is ${data.length} bytes, expected 256`);
  if (data[0] !== 1 || data[1] !== 1 || data[3] > 3)
    throw new RpcError("invalid channel account discriminator, version or status");
  return {
    status: data[3],
    depositMicro: readU64LE(data, 12),
    settledMicro: readU64LE(data, 20),
    closureStartedAt: readI64LE(data, 36),
    payerWithdrawnAt: readI64LE(data, 44),
    gracePeriod: Number(
      data[52] | (data[53] << 8) | (data[54] << 16) | (data[55] * 0x1000000),
    ),
  };
}

export interface ChannelRpc {
  getAccountData(pubkey: string): Promise<Uint8Array | null>;
  getClosedOutcome?(record: ChannelRecord): Promise<{ settledMicro: bigint; txHash?: string } | null>;
}

export function solanaAccountRpc(rpcUrl: string, timeoutMs = 8000, expectedOwner = PAYMENT_CHANNELS_PROGRAM): ChannelRpc {
  const request = async <T>(method: string, params: unknown[]): Promise<T> => {
    const res = await fetch(rpcUrl, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new RpcError(`HTTP ${res.status} from ${hostOf(rpcUrl)}`);
    const body = await res.json() as { result?: T; error?: { message?: string } };
    if (!body || body.error || !("result" in body)) throw new RpcError(body?.error?.message ?? `invalid ${method} response`);
    return body.result as T;
  };
  return {
    async getClosedOutcome(record) {
      let before: string | undefined;
      let opened = false;
      let sealed = false;
      let terminal = false;
      let txHash: string | undefined;
      let settledMicro = 0n;
      const expiredUnopened = async () => {
        if (opened || terminal || settledMicro > 0n || record.openSlot === undefined) return null;
        const first = await request<number>("getFirstAvailableBlock", []);
        const slot = await request<number>("getSlot", [{ commitment: "finalized" }]);
        return Number.isSafeInteger(first) && Number.isSafeInteger(slot) && first <= record.openSlot && slot > record.openSlot + 1500
          ? { settledMicro: 0n } : null;
      };
      for (let page = 0; page < 100; page++) {
        const signatures = await request<Array<{ signature: string; err: unknown }>>("getSignaturesForAddress",
          [record.channelId, { commitment: "finalized", limit: 100, ...(before ? { before } : {}) }]);
        if (!Array.isArray(signatures)) throw new RpcError("invalid channel signature history");
        if (!signatures.length) {
          return expiredUnopened();
        }
        for (const sig of signatures) {
          if (sig.err !== null) continue;
          const tx = await request<ChannelHistoryTransaction | null>("getTransaction", [sig.signature,
            { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 }]);
          if (!tx) return null;
          const evidence = channelTransactionEvidence(tx, record.channelId);
          if (!evidence) return null;
          if (evidence.terminal) { terminal = true; txHash ??= sig.signature; }
          if (evidence.settledMicro > settledMicro) settledMicro = evidence.settledMicro;
          opened ||= evidence.opened;
          sealed ||= evidence.sealed;
        }
        if (opened) {
          if (!terminal || !sealed || settledMicro > BigInt(record.depositMicro)) return null;
          return { settledMicro, txHash };
        }
        if (signatures.length < 100) return expiredUnopened();
        before = signatures.at(-1)!.signature;
      }
      return null;
    },
    async getAccountData(pubkey: string): Promise<Uint8Array | null> {
      if (!looksLikeAddress(pubkey)) throw new RpcError(`"${pubkey}" is not a channel address`);
      let res: Response;
      try {
        res = await fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getAccountInfo",
            params: [pubkey, { encoding: "base64", commitment: "finalized" }],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        throw new RpcError(`could not reach ${hostOf(rpcUrl)}: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!res.ok) throw new RpcError(`HTTP ${res.status} from ${hostOf(rpcUrl)}`);
      const body = (await res.json().catch(() => null)) as
        | { result?: { value?: { data?: [string, string]; owner?: string } | null }; error?: { message?: string } }
        | null;
      if (!body) throw new RpcError(`${hostOf(rpcUrl)} did not answer with JSON`);
      if (body.error) throw new RpcError(body.error.message ?? "RPC error");
      const value = body.result?.value;
      if (value === null) return null;
      if (!value || value.owner !== expectedOwner) throw new RpcError("invalid account owner or RPC result");
      const data = value.data?.[0];
      if (typeof data !== "string") throw new RpcError(`unexpected getAccountInfo result from ${hostOf(rpcUrl)}`);
      return new Uint8Array(Buffer.from(data, "base64"));
    },
  };
}

interface ChannelHistoryTransaction {
  meta: { err: unknown; innerInstructions?: Array<{ instructions: Array<{ programId?: string; data?: string }> }> } | null;
  transaction: { message: { instructions: Array<{ programId?: string; accounts?: string[]; data?: string }> } };
}

function channelTransactionEvidence(tx: ChannelHistoryTransaction, channelId: string):
  { opened: boolean; sealed: boolean; terminal: boolean; settledMicro: bigint } | null {
  if (!tx.meta || tx.meta.err !== null) return null;
  if (tx.meta.innerInstructions?.some((g) => g.instructions.some((i) =>
    i.programId === PAYMENT_CHANNELS_PROGRAM && (!i.data || base58Decode(i.data)[0] !== 228)))) return null;
  const instructions = tx.transaction?.message?.instructions;
  if (!Array.isArray(instructions)) return null;
  let opened = false;
  let sealed = false;
  let terminal = false;
  let settledMicro = 0n;
  for (let i = 0; i < instructions.length; i++) {
    const ix = instructions[i];
    if (ix.programId !== PAYMENT_CHANNELS_PROGRAM || !ix.accounts?.includes(channelId)) continue;
    if (!ix.data) return null;
    const data = base58Decode(ix.data);
    const d = data[0];
    const channelIndex = d === 1 ? 5 : [3, 4, 5, 8].includes(d) ? 1 : 0;
    if (ix.accounts[channelIndex] !== channelId) return null;
    if (d === 1) opened = true;
    if (d === 4 || d === 6) sealed = true;
    if (d === 3 || d < 1 || d > 9) return null;
    if (d === 7 || d === 8 || d === 9) terminal = true;
    if (d === 2 || (d === 4 && data[1] !== 0)) {
      const prior = instructions[i - 1];
      if (prior?.programId !== "Ed25519SigVerify111111111111111111111111111" || !prior.data) return null;
      const raw = base58Decode(prior.data);
      if (raw.length !== 162) return null;
      const voucher = decodeVoucher(raw.subarray(112));
      if (voucher.channelId !== channelId) return null;
      if (voucher.cumulativeAmount > settledMicro) settledMicro = voucher.cumulativeAmount;
    }
  }
  return { opened, sealed, terminal, settledMicro };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export interface ReconcileChange {
  channelId: string;
  from: ChannelStatus;
  to: ChannelStatus | "dropped";
}

export type ChannelLock = <T>(fn: () => T | Promise<T>) => Promise<T>;

export interface ReconcileOptions {
  agent?: string;
  nowMs?: number;
  lock?: ChannelLock;
  network?: string;
}

function sameSolanaNetwork(a: string, b: string): boolean {
  const first = solanaNetworkInfo(a);
  const second = solanaNetworkInfo(b);
  return first !== undefined && second !== undefined && first.caip2 === second.caip2;
}

export async function reconcileChannels(
  rpc: ChannelRpc,
  store: ChannelStore,
  opts: ReconcileOptions = {},
): Promise<ReconcileChange[]> {
  const nowMs = opts.nowMs ?? Date.now();
  const lock: ChannelLock = opts.lock ?? ((fn) => Promise.resolve(fn()));
  const network = opts.network ?? readMode(store.stateDir).network;

  await lock(() => store.repairAccounting(opts.agent));
  const reads: { channelId: string; data: Uint8Array | null; outcome?: { settledMicro: bigint; txHash?: string } | null }[] = [];
  for (const rec of store.active(opts.agent)) {
    if (network && !sameSolanaNetwork(rec.network, network)) continue;
    const data = await rpc.getAccountData(rec.channelId);
    reads.push({ channelId: rec.channelId, data,
      ...(data === null ? { outcome: await rpc.getClosedOutcome?.(rec) } : {}) });
  }
  if (!reads.length) return [];

  return lock(() => {
    const changes: ReconcileChange[] = [];
    const reservations = new ReservationStore(store.stateDir);
    for (const { channelId, data, outcome } of reads) {
      const cur = store.get(channelId);
      if (!cur || !ESCROWED_STATUSES.has(cur.status)) continue;
      if (data === null) {
        if (outcome) {
          if (outcome.settledMicro === 0n) store.refund(channelId, outcome.txHash);
          else store.settle(channelId, outcome.settledMicro, outcome.txHash);
          changes.push({ channelId, from: cur.status, to: outcome.settledMicro === 0n ? "refunded" : "settled" });
        }
        continue;
      }
      const onChain = decodeChannelAccount(data);
      if (onChain.depositMicro !== BigInt(cur.depositMicro) || onChain.settledMicro > onChain.depositMicro)
        throw new RpcError(`channel ${channelId} on-chain deposit/watermark does not match local accounting`);
      if (onChain.status === CHANNEL_STATUS.DISTRIBUTED ||
          (onChain.status === CHANNEL_STATUS.SEALED && onChain.payerWithdrawnAt > 0n)) {
        store.settle(channelId, onChain.settledMicro);
        changes.push({ channelId, from: cur.status, to: "settled" });
      } else if (onChain.status !== CHANNEL_STATUS.OPEN || cur.status === "unknown" ||
          (cur.status === "opened" && !reservations.list(cur.agent).some((r) => r.id === cur.reservationId))) {
        if (cur.status !== "orphaned") {
          store.markOrphaned(channelId, nowMs);
          changes.push({ channelId, from: cur.status, to: "orphaned" });
        }
      }
    }
    return changes;
  });
}

export async function reconcileAndNotify(
  rpc: ChannelRpc,
  store: ChannelStore,
  onPhase: (phase: "settled" | "refunded" | "orphaned", rec: ChannelRecord) => void,
  opts: ReconcileOptions = {},
): Promise<ReconcileChange[]> {
  const changes = await reconcileChannels(rpc, store, opts);
  for (const ch of changes) {
    if (ch.to === "settled" || ch.to === "refunded" || ch.to === "orphaned") {
      const rec = store.get(ch.channelId);
      if (rec) onPhase(ch.to, rec);
    }
  }
  return changes;
}

export interface ReclaimOptions {
  rpcUrl: string;
  network?: string;
  gracePaddingSeconds?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ReclaimResult {
  reclaimed: boolean;
  refundMicro: bigint;
  signatures: string[];
  note?: string;
}

export type ReclaimStep =
  | { kind: "requestClose" }
  | { kind: "wait"; ms: number }
  | { kind: "seal" }
  | { kind: "withdrawPayer" };

export interface ReclaimPlan {
  steps: ReclaimStep[];
  note?: string;
}

export function planReclaim(
  state: { status: number; closureStartedAt: bigint; payerWithdrawnAt: bigint } | null,
  grace: number,
  nowSeconds: bigint,
  gracePaddingSeconds = 2,
): ReclaimPlan {
  if (state === null) return { steps: [], note: "channel already closed on-chain" };
  const padMs = gracePaddingSeconds * 1000;
  switch (state.status) {
    case CHANNEL_STATUS.OPEN:
      return {
        steps: [{ kind: "requestClose" }, { kind: "wait", ms: grace * 1000 + padMs }, { kind: "seal" }, { kind: "withdrawPayer" }],
      };
    case CHANNEL_STATUS.CLOSING: {
      const waitMs = Number(state.closureStartedAt + BigInt(grace) - nowSeconds) * 1000 + padMs;
      const steps: ReclaimStep[] = [];
      if (waitMs > 0) steps.push({ kind: "wait", ms: waitMs });
      steps.push({ kind: "seal" }, { kind: "withdrawPayer" });
      return { steps };
    }
    case CHANNEL_STATUS.SEALED:
      if (state.payerWithdrawnAt !== 0n) return { steps: [], note: "payer refund was already withdrawn" };
      return { steps: [{ kind: "withdrawPayer" }] };
    default:
      return { steps: [], note: "channel already distributed" };
  }
}

export interface ChannelInstruction {
  programAddress: ReturnType<typeof import("@solana/kit").address>;
  accounts: { address: ReturnType<typeof import("@solana/kit").address>; role: number }[];
  data: Uint8Array;
}

export interface ReclaimAddresses {
  payer: string;
  channel: string;
  channelAta: string;
  payerAta: string;
  mint: string;
  tokenProgram: string;
}

export function buildReclaimInstructions(
  kit: typeof import("@solana/kit"),
  a: ReclaimAddresses,
): { requestClose: ChannelInstruction; seal: ChannelInstruction; withdrawPayer: ChannelInstruction } {
  const program = kit.address(PAYMENT_CHANNELS_PROGRAM);
  const RO = kit.AccountRole.READONLY;
  const WRITABLE = kit.AccountRole.WRITABLE;
  const RO_SIGNER = kit.AccountRole.READONLY_SIGNER;
  return {
    requestClose: {
      programAddress: program,
      accounts: [
        { address: kit.address(a.payer), role: RO_SIGNER },
        { address: kit.address(a.channel), role: WRITABLE },
      ],
      data: Uint8Array.of(5),
    },
    seal: {
      programAddress: program,
      accounts: [{ address: kit.address(a.channel), role: WRITABLE }],
      data: Uint8Array.of(6),
    },
    withdrawPayer: {
      programAddress: program,
      accounts: [
        { address: kit.address(a.payer), role: RO_SIGNER },
        { address: kit.address(a.channel), role: WRITABLE },
        { address: kit.address(a.channelAta), role: WRITABLE },
        { address: kit.address(a.payerAta), role: WRITABLE },
        { address: kit.address(a.mint), role: RO },
        { address: kit.address(a.tokenProgram), role: RO },
      ],
      data: Uint8Array.of(8),
    },
  };
}

export async function reclaimChannel(
  record: ChannelRecord,
  signer: SolanaSigner,
  opts: ReclaimOptions,
): Promise<ReclaimResult> {
  if (opts.network && !sameSolanaNetwork(record.network, opts.network))
    throw new Error(`channel ${record.channelId} is on ${record.network}, not ${opts.network}; use its original network to reclaim`);
  if (!record.mint) throw new Error(`channel ${record.channelId} has no recorded mint — cannot build withdrawPayer`);
  if (record.payer && record.payer !== signer.address)
    throw new Error(
      `channel ${record.channelId} belongs to payer ${record.payer}, not the signing wallet ${signer.address}`,
    );

  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let kit: typeof import("@solana/kit");
  let token: typeof import("@solana-program/token");
  try {
    kit = await import("@solana/kit");
    token = await import("@solana-program/token");
  } catch {
    throw new Error("reclaim needs @solana/kit and @solana-program/token: npm i @solana/kit @solana-program/token");
  }

  const rpc = kit.createSolanaRpc(opts.rpcUrl);
  const chainRpc = solanaAccountRpc(opts.rpcUrl);
  const payer = signer.address;
  const channel = record.channelId;

  const raw = await chainRpc.getAccountData(channel);
  if (raw === null) {
    const outcome = await chainRpc.getClosedOutcome!(record);
    if (outcome) return { reclaimed: true, refundMicro: BigInt(record.depositMicro) - outcome.settledMicro, signatures: [], note: "refund confirmed from channel history" };
    return { reclaimed: false, refundMicro: 0n, signatures: [], note: "channel absent; outcome is unverified and escrow remains held" };
  }
  const state = decodeChannelAccount(raw);
  if (state.depositMicro !== BigInt(record.depositMicro) || state.settledMicro > state.depositMicro)
    throw new RpcError("channel deposit/watermark does not match local accounting");
  const refundMicro = state.depositMicro - state.settledMicro;
  const grace = state.gracePeriod || record.withdrawDelay;

  const [channelAta] = await token.findAssociatedTokenPda({
    owner: kit.address(channel),
    mint: kit.address(record.mint),
    tokenProgram: kit.address(SPL_TOKEN_PROGRAM),
  });
  const [payerAta] = await token.findAssociatedTokenPda({
    owner: kit.address(payer),
    mint: kit.address(record.mint),
    tokenProgram: kit.address(SPL_TOKEN_PROGRAM),
  });

  const ix = buildReclaimInstructions(kit, {
    payer,
    channel,
    channelAta: String(channelAta),
    payerAta: String(payerAta),
    mint: record.mint,
    tokenProgram: SPL_TOKEN_PROGRAM,
  });

  const signatures: string[] = [];
  const send = async (instruction: ChannelInstruction): Promise<string> => {
    const { value: blockhash } = await rpc.getLatestBlockhash().send();
    const message = kit.pipe(
      kit.createTransactionMessage({ version: 0 }),
      (m) => kit.setTransactionMessageFeePayer(kit.address(payer), m),
      (m) => kit.setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => kit.appendTransactionMessageInstruction(instruction, m),
    );
    const compiled = kit.compileTransaction(message);
    const [dict] = await signer.signTransactions([{ messageBytes: compiled.messageBytes as unknown as Uint8Array }]);
    const sig = dict[payer];
    if (!sig) throw new Error("the wallet signer did not return a signature for the reclaim transaction");
    const signed = { ...compiled, signatures: { ...compiled.signatures, [payer]: sig } };
    const wire = kit.getBase64EncodedWireTransaction(signed as never);
    const txSig = await rpc.sendTransaction(wire, { encoding: "base64", skipPreflight: false }).send();
    await confirm(rpc, txSig, opts.sleep);
    signatures.push(txSig);
    return txSig;
  };

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const plan = planReclaim(state, grace, nowSec, opts.gracePaddingSeconds ?? 2);
  if (!plan.steps.length) return { reclaimed: true, refundMicro, signatures, note: plan.note };

  for (const step of plan.steps) {
    if (step.kind === "wait") await sleep(step.ms);
    else await send(ix[step.kind]);
  }

  const finalRaw = await chainRpc.getAccountData(channel);
  if (finalRaw === null) {
    const outcome = await chainRpc.getClosedOutcome!(record);
    if (!outcome) throw new RpcError("reclaim outcome unavailable; escrow remains held until reconciliation");
    return { reclaimed: true, refundMicro: BigInt(record.depositMicro) - outcome.settledMicro, signatures };
  }
  const finalState = decodeChannelAccount(finalRaw);
  if (finalState.depositMicro !== BigInt(record.depositMicro) || finalState.settledMicro > finalState.depositMicro ||
      (finalState.status !== CHANNEL_STATUS.DISTRIBUTED && finalState.payerWithdrawnAt === 0n))
    throw new RpcError("payer refund is not finalized; escrow remains held until reconciliation");
  return { reclaimed: true, refundMicro: finalState.depositMicro - finalState.settledMicro, signatures };
}

async function confirm(
  rpc: ReturnType<typeof import("@solana/kit").createSolanaRpc>,
  signature: string,
  sleep: ((ms: number) => Promise<void>) | undefined,
  timeoutMs = 30_000,
): Promise<void> {
  const nap = sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { value } = await rpc.getSignatureStatuses([signature as never]).send();
    const st = value?.[0];
    if (st) {
      if (st.err) throw new Error(`reclaim transaction ${signature} failed on-chain: ${JSON.stringify(st.err)}`);
      if (st.confirmationStatus === "finalized") return;
    }
    if (Date.now() > deadline) throw new Error(`reclaim transaction ${signature} was not confirmed within ${timeoutMs}ms`);
    await nap(800);
  }
}
