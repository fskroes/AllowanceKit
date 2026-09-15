import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { base58Encode } from "../src/base58.ts";
import { createAgent, topUp, DEFAULT_AGENT_NAME } from "../src/wallet.ts";
import { ReservationStore } from "../src/reservations.ts";
import { encodeVoucher } from "../src/voucher.ts";
import { Ledger } from "../src/ledger.ts";
import {
  ChannelStore,
  CHANNEL_STATUS,
  PAYMENT_CHANNELS_PROGRAM,
  decodeChannelAccount,
  reconcileChannels,
  reconcileAndNotify,
  planReclaim,
  buildReclaimInstructions,
  solanaAccountRpc,
  type ChannelRpc,
} from "../src/channels.ts";
import * as kit from "@solana/kit";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "allowance-channels-"));
}

/** A throwaway but valid 32-byte base58 address, so ids look like real PDAs. */
function addr(): string {
  return base58Encode(new Uint8Array(crypto.randomBytes(32)));
}

function openInput(over: Partial<Parameters<ChannelStore["add"]>[0]> = {}) {
  return {
    channelId: addr(),
    agent: "default",
    url: "https://api.example.com/meter",
    host: "api.example.com",
    network: "solana-devnet",
    depositMicro: 100_000n,
    withdrawDelay: 900,
    payer: addr(),
    mint: addr(),
    ...over,
  };
}

/** Build a 256-byte channel account with the fields `reconcile` reads (spike §2). */
function fakeAccount(f: {
  status: number;
  depositMicro?: bigint;
  settledMicro?: bigint;
  closureStartedAt?: bigint;
  payerWithdrawnAt?: bigint;
  gracePeriod?: number;
}): Uint8Array {
  const b = Buffer.alloc(256);
  b[0] = 1; // account discriminator (Channel)
  b[1] = 1; // version
  b[3] = f.status;
  b.writeBigUInt64LE(f.depositMicro ?? 0n, 12);
  b.writeBigUInt64LE(f.settledMicro ?? 0n, 20);
  b.writeBigInt64LE(f.closureStartedAt ?? 0n, 36);
  b.writeBigInt64LE(f.payerWithdrawnAt ?? 0n, 44);
  b.writeUInt32LE(f.gracePeriod ?? 900, 52);
  return new Uint8Array(b);
}

/** A ChannelRpc backed by an in-memory map — the "fake RPC" of the test surface. */
function fakeRpc(accounts: Record<string, Uint8Array | null>): ChannelRpc {
  return { async getAccountData(pubkey) { return accounts[pubkey] ?? null; } };
}

test("add records an opened channel and counts it as escrow", () => {
  const store = new ChannelStore(tmpDir());
  const rec = store.add(openInput({ depositMicro: 100_000n }));
  assert.equal(rec.status, "opened");
  assert.equal(rec.depositMicro, "100000");
  assert.equal(rec.settledMicro, "0");
  assert.equal(rec.refundMicro, "0");
  assert.equal(store.escrowedMicro("default"), 100_000n);
  assert.equal(store.get(rec.channelId)?.channelId, rec.channelId);
  assert.equal(store.list("default").length, 1);
});

test("recovery records actual spend before releasing the recovered deposit", async () => {
  const dir = tmpDir();
  const store = new ChannelStore(dir);
  const rec = store.add(openInput());
  store.markUnknown(rec.channelId);
  await reconcileChannels(fakeRpc({
    [rec.channelId]: fakeAccount({ status: CHANNEL_STATUS.DISTRIBUTED, depositMicro: 100_000n, settledMicro: 30_000n }),
  }), store);
  assert.equal(new Ledger(dir).spendTotal("default"), 30_000n);
  assert.equal(store.escrowedMicro(), 0n);
});

test("a missing channel account cannot prove that a deposit was never spent", async () => {
  const store = new ChannelStore(tmpDir());
  const rec = store.add(openInput());
  store.markUnknown(rec.channelId);
  await reconcileChannels(fakeRpc({ [rec.channelId]: null }), store);
  assert.equal(store.escrowedMicro(), 100_000n);
});

test("a corrupt channel file blocks allowance authorization", async () => {
  const dir = tmpDir();
  const rt = createAgent(dir);
  fs.writeFileSync(path.join(dir, "channels.json"), '{"channels":[');
  await assert.rejects(rt.ctx.authorize(1n, "https://api.example.com/meter"), /channels.json.*corrupt/);
  rt.stopHeartbeat?.();
});

test("a duplicate channelId is rejected as a replay", () => {
  const store = new ChannelStore(tmpDir());
  const input = openInput();
  store.add(input);
  assert.throws(() => store.add(input), /replay/);
});

test("escrowedMicro tracks a channel through every status", () => {
  const store = new ChannelStore(tmpDir());

  // opened: escrowed
  const a = store.add(openInput({ depositMicro: 100_000n }));
  assert.equal(store.escrowedMicro(), 100_000n);

  // settled: the actual is spent elsewhere, the refund is back → no longer escrow
  store.settle(a.channelId, 30_000n);
  const settled = store.get(a.channelId)!;
  assert.equal(settled.status, "settled");
  assert.equal(settled.settledMicro, "30000");
  assert.equal(settled.refundMicro, "70000");
  assert.equal(store.escrowedMicro(), 0n);

  // refunded: whole deposit back
  const b = store.add(openInput({ depositMicro: 50_000n }));
  store.refund(b.channelId);
  const refunded = store.get(b.channelId)!;
  assert.equal(refunded.status, "refunded");
  assert.equal(refunded.settledMicro, "0");
  assert.equal(refunded.refundMicro, "50000");

  // unknown then orphaned: still escrowed (money is on-chain, outcome unresolved)
  const c = store.add(openInput({ depositMicro: 20_000n }));
  store.markUnknown(c.channelId);
  assert.equal(store.escrowedMicro(), 20_000n);
  store.markOrphaned(c.channelId);
  assert.equal(store.escrowedMicro(), 20_000n);
  assert.ok(store.get(c.channelId)!.orphanedAt);

  // reclaimed: deposit − settled came back → no longer escrow
  store.markReclaimed(c.channelId);
  assert.equal(store.get(c.channelId)!.status, "reclaimed");
  assert.equal(store.get(c.channelId)!.refundMicro, "20000");
  assert.equal(store.escrowedMicro(), 0n);
});

test("escrow is summed per agent", () => {
  const store = new ChannelStore(tmpDir());
  store.add(openInput({ agent: "a", depositMicro: 10_000n }));
  store.add(openInput({ agent: "a", depositMicro: 5_000n }));
  store.add(openInput({ agent: "b", depositMicro: 99_000n }));
  assert.equal(store.escrowedMicro("a"), 15_000n);
  assert.equal(store.escrowedMicro("b"), 99_000n);
  assert.equal(store.escrowedMicro(), 114_000n);
});

test("settle rejects an amount over the deposit or below zero", () => {
  const store = new ChannelStore(tmpDir());
  const rec = store.add(openInput({ depositMicro: 100_000n }));
  assert.throws(() => store.settle(rec.channelId, 100_001n), /exceeds the deposit/);
  assert.throws(() => store.settle(rec.channelId, -1n), /negative/);
  // the whole deposit is a legal settle (zero refund)
  store.settle(rec.channelId, 100_000n);
  assert.equal(store.get(rec.channelId)!.refundMicro, "0");
});

test("dueForReclaim respects the withdraw delay and the orphan clock", () => {
  const store = new ChannelStore(tmpDir());
  const t0 = 1_000_000_000_000;
  const rec = store.add(openInput({ withdrawDelay: 5 }));
  store.markOrphaned(rec.channelId, t0);

  // one second in: not yet due
  assert.equal(store.dueForReclaim("default", t0 + 1_000).length, 0);
  // past the 5s delay: due
  assert.equal(store.dueForReclaim("default", t0 + 6_000).length, 1);
  // an opened (not orphaned) channel is never due
  store.add(openInput());
  assert.equal(store.dueForReclaim("default", t0 + 6_000).length, 1);
});

test("decodeChannelAccount reads the spec offsets", () => {
  const data = fakeAccount({
    status: CHANNEL_STATUS.SEALED,
    depositMicro: 100_000n,
    settledMicro: 30_000n,
    closureStartedAt: 1_760_000_000n,
    payerWithdrawnAt: 0n,
    gracePeriod: 5,
  });
  const decoded = decodeChannelAccount(data);
  assert.equal(decoded.status, 1);
  assert.equal(decoded.depositMicro, 100_000n);
  assert.equal(decoded.settledMicro, 30_000n);
  assert.equal(decoded.closureStartedAt, 1_760_000_000n);
  assert.equal(decoded.gracePeriod, 5);
  assert.throws(() => decodeChannelAccount(new Uint8Array(100)), /256/);
});

test("reconcile flips unknown and opened to their true on-chain state", async () => {
  const dir = tmpDir();
  const store = new ChannelStore(dir);
  const inflight = new ReservationStore(dir).open("default", "https://api.example.com/meter", "api.example.com", 40_000n);

  const sealed = store.add(openInput({ depositMicro: 100_000n }));
  const openUnknown = store.add(openInput({ depositMicro: 40_000n }));
  const openInflight = store.add(openInput({ depositMicro: 40_000n, reservationId: inflight.id }));
  const vanished = store.add(openInput({ depositMicro: 40_000n }));
  const closing = store.add(openInput({ depositMicro: 40_000n }));
  store.markUnknown(openUnknown.channelId);
  store.markUnknown(vanished.channelId);
  store.markUnknown(closing.channelId);

  const changes = await reconcileChannels(
    fakeRpc({
      [sealed.channelId]: fakeAccount({ status: CHANNEL_STATUS.DISTRIBUTED, depositMicro: 100_000n, settledMicro: 25_000n }),
      [openUnknown.channelId]: fakeAccount({ status: CHANNEL_STATUS.OPEN, depositMicro: 40_000n }),
      [openInflight.channelId]: fakeAccount({ status: CHANNEL_STATUS.OPEN, depositMicro: 40_000n }),
      [vanished.channelId]: null,
      [closing.channelId]: fakeAccount({ status: CHANNEL_STATUS.CLOSING, depositMicro: 40_000n }),
    }),
    store,
  );

  // SEALED → settled at the on-chain watermark
  assert.equal(store.get(sealed.channelId)!.status, "settled");
  assert.equal(store.get(sealed.channelId)!.settledMicro, "25000");
  assert.equal(store.get(sealed.channelId)!.refundMicro, "75000");
  // unknown + OPEN → orphaned (open landed, nothing settled)
  assert.equal(store.get(openUnknown.channelId)!.status, "orphaned");
  // opened + OPEN → still in flight, untouched
  assert.equal(store.get(openInflight.channelId)!.status, "opened");
  // An absent PDA can have spent money; incomplete evidence keeps the hold.
  assert.equal(store.get(vanished.channelId)?.status, "unknown");
  // CLOSING → orphaned
  assert.equal(store.get(closing.channelId)!.status, "orphaned");

  const byTo = Object.fromEntries(changes.map((c) => [c.channelId, c.to]));
  assert.equal(byTo[sealed.channelId], "settled");
  assert.equal(byTo[vanished.channelId], undefined);
  assert.equal(changes.find((c) => c.channelId === openInflight.channelId), undefined);
});

test("SOL-08: reconcileAndNotify emits resolved phases once and runs writes under the lock", async () => {
  const store = new ChannelStore(tmpDir());
  const sealed = store.add(openInput({ depositMicro: 100_000n }));
  const closing = store.add(openInput({ depositMicro: 40_000n }));
  const vanished = store.add(openInput({ depositMicro: 40_000n }));
  store.markUnknown(closing.channelId);
  store.markUnknown(vanished.channelId);

  const phases: Array<{ phase: string; channelId: string }> = [];
  let locked = 0;
  const changes = await reconcileAndNotify(
    fakeRpc({
      [sealed.channelId]: fakeAccount({ status: CHANNEL_STATUS.DISTRIBUTED, depositMicro: 100_000n, settledMicro: 25_000n }),
      [closing.channelId]: fakeAccount({ status: CHANNEL_STATUS.CLOSING, depositMicro: 40_000n }),
      [vanished.channelId]: null,
    }),
    store,
    (phase, rec) => phases.push({ phase, channelId: rec.channelId }),
    {
      lock: async (fn) => {
        locked++;
        return fn();
      },
    },
  );

  assert.equal(locked, 2, "legacy accounting repair and new resolution both hold the allowance lock");
  assert.equal(changes.length, 2);
  // settled and orphaned are emitted with the freshly-mutated record; dropped is not a phase.
  assert.deepEqual(
    phases.map((p) => p.phase).sort(),
    ["orphaned", "settled"],
  );
  const settledEvt = phases.find((p) => p.phase === "settled")!;
  assert.equal(settledEvt.channelId, sealed.channelId);
  assert.equal(store.get(sealed.channelId)!.settledMicro, "25000");
  assert.equal(store.get(vanished.channelId)?.status, "unknown", "unverified escrow remains held");
});

test("reconcile leaves terminal channels untouched", async () => {
  const store = new ChannelStore(tmpDir());
  const rec = store.add(openInput());
  store.settle(rec.channelId, 10_000n);
  // Even if the chain would answer, a settled row is not re-read.
  const changes = await reconcileChannels(
    fakeRpc({ [rec.channelId]: fakeAccount({ status: CHANNEL_STATUS.OPEN }) }),
    store,
  );
  assert.equal(changes.length, 0);
  assert.equal(store.get(rec.channelId)!.status, "settled");
});

test("a terminal channel cannot transition again", () => {
  const store = new ChannelStore(tmpDir());
  const rec = store.add(openInput({ depositMicro: 100_000n }));
  store.settle(rec.channelId, 30_000n);
  assert.throws(() => store.settle(rec.channelId, 40_000n), /terminal/);
  assert.throws(() => store.refund(rec.channelId), /terminal/);
  assert.throws(() => store.markReclaimed(rec.channelId), /terminal/);
});

test("markReclaimed persists the live on-chain refund, not the stale local one", () => {
  const store = new ChannelStore(tmpDir());
  const rec = store.add(openInput({ depositMicro: 100_000n }));
  store.markOrphaned(rec.channelId);
  // The chain says only 20_000 was ever settled, so 80_000 came back — even
  // though the local row still shows settledMicro "0" (never synced a settle).
  store.markReclaimed(rec.channelId, 80_000n);
  const done = store.get(rec.channelId)!;
  assert.equal(done.status, "reclaimed");
  assert.equal(done.refundMicro, "80000");
  assert.equal(done.settledMicro, "20000"); // back-computed deposit − refund
  assert.equal(store.escrowedMicro(), 0n);
});

test("planReclaim returns the right steps for each on-chain state", () => {
  const now = 1_000n;
  // absent → nothing
  assert.deepEqual(planReclaim(null, 900, now).steps, []);
  // OPEN → the full four-step dance
  assert.deepEqual(
    planReclaim({ status: CHANNEL_STATUS.OPEN, closureStartedAt: 0n, payerWithdrawnAt: 0n }, 5, now, 2).steps.map((s) => s.kind),
    ["requestClose", "wait", "seal", "withdrawPayer"],
  );
  // CLOSING with grace already elapsed → no wait step
  const elapsed = planReclaim({ status: CHANNEL_STATUS.CLOSING, closureStartedAt: 0n, payerWithdrawnAt: 0n }, 5, 1_000n, 0);
  assert.deepEqual(elapsed.steps.map((s) => s.kind), ["seal", "withdrawPayer"]);
  // CLOSING mid-grace → a positive wait
  const midGrace = planReclaim({ status: CHANNEL_STATUS.CLOSING, closureStartedAt: 1_000n, payerWithdrawnAt: 0n }, 60, 1_000n, 0);
  assert.equal(midGrace.steps[0].kind, "wait");
  assert.equal((midGrace.steps[0] as { ms: number }).ms, 60_000);
  // SEALED, not yet withdrawn → withdrawPayer only
  assert.deepEqual(
    planReclaim({ status: CHANNEL_STATUS.SEALED, closureStartedAt: 0n, payerWithdrawnAt: 0n }, 5, now).steps.map((s) => s.kind),
    ["withdrawPayer"],
  );
  // SEALED, already withdrawn → nothing
  assert.equal(planReclaim({ status: CHANNEL_STATUS.SEALED, closureStartedAt: 0n, payerWithdrawnAt: 42n }, 5, now).steps.length, 0);
  // DISTRIBUTED → nothing
  assert.equal(planReclaim({ status: CHANNEL_STATUS.DISTRIBUTED, closureStartedAt: 0n, payerWithdrawnAt: 0n }, 5, now).steps.length, 0);
});

test("buildReclaimInstructions encodes the spec discriminators and account roles", () => {
  const a = { payer: addr(), channel: addr(), channelAta: addr(), payerAta: addr(), mint: addr(), tokenProgram: addr() };
  const { requestClose, seal, withdrawPayer } = buildReclaimInstructions(kit, a);

  // Discriminators from spike §1: requestClose 5, seal 6, withdrawPayer 8.
  assert.deepEqual([...requestClose.data], [5]);
  assert.deepEqual([...seal.data], [6]);
  assert.deepEqual([...withdrawPayer.data], [8]);

  for (const ix of [requestClose, seal, withdrawPayer]) assert.equal(String(ix.programAddress), PAYMENT_CHANNELS_PROGRAM);

  const RO = kit.AccountRole.READONLY;
  const W = kit.AccountRole.WRITABLE;
  const ROS = kit.AccountRole.READONLY_SIGNER;

  // requestClose: [payer signer, channel writable]
  assert.deepEqual(requestClose.accounts.map((x) => [String(x.address), x.role]), [
    [a.payer, ROS],
    [a.channel, W],
  ]);
  // seal: [channel writable]
  assert.deepEqual(seal.accounts.map((x) => [String(x.address), x.role]), [[a.channel, W]]);
  // withdrawPayer: exact order and roles from spike §1
  assert.deepEqual(withdrawPayer.accounts.map((x) => [String(x.address), x.role]), [
    [a.payer, ROS],
    [a.channel, W],
    [a.channelAta, W],
    [a.payerAta, W],
    [a.mint, RO],
    [a.tokenProgram, RO],
  ]);
});

// --- CLI surface: `channels list` and the audit escrow columns ---------------

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI, ...args], {
      env: { ...process.env, AGENT_PRIVATE_KEY: undefined },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("`channels list` shows escrow, and audit prints the deposit and refund columns", async () => {
  const dir = tmpDir();
  createAgent(dir); // materialise the state dir the CLI reads

  const store = new ChannelStore(dir);
  store.add(openInput({ depositMicro: 100_000n, agent: DEFAULT_AGENT_NAME }));

  const list = await run(["channels", "list", "--state", dir]);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /opened/);
  assert.match(list.stdout, /in escrow/);

  const empty = await run(["channels", "list", "--state", tmpDir()]);
  assert.match(empty.stdout, /no Solana payment channels yet/);

  // A settled upto payment row must render its escrow columns in `audit`.
  new Ledger(dir).append({
    t: "payment",
    at: new Date().toISOString(),
    agent: DEFAULT_AGENT_NAME,
    url: "https://api.example.com/meter",
    host: "api.example.com",
    amountMicro: "30000",
    txHash: "5xSolanaSig1111111111111111111111111111111111",
    balanceAfterMicro: "0",
    scheme: "upto",
    depositMicro: "100000",
    refundMicro: "70000",
    channelId: addr(),
  });
  const audit = await run(["audit", "--state", dir]);
  assert.equal(audit.code, 0, audit.stderr);
  assert.match(audit.stdout, /deposit/);
  assert.match(audit.stdout, /refund/);
});

test("SEALED holds the ceiling until its payer refund is finalized, and orphaned rows are rechecked", async () => {
  const dir = tmpDir();
  const store = new ChannelStore(dir);
  const rec = store.add(openInput());
  const rpc = fakeRpc({ [rec.channelId]: fakeAccount({ status: CHANNEL_STATUS.SEALED, depositMicro: 100_000n, settledMicro: 30_000n }) });
  await reconcileChannels(rpc, store);
  assert.equal(store.get(rec.channelId)?.status, "orphaned");
  assert.equal(store.escrowedMicro(), 100_000n);
  assert.equal(new Ledger(dir).spendTotal("default"), 0n);
  await reconcileChannels(fakeRpc({ [rec.channelId]: fakeAccount({ status: CHANNEL_STATUS.SEALED,
    depositMicro: 100_000n, settledMicro: 30_000n, payerWithdrawnAt: 1n }) }), store);
  assert.equal(store.escrowedMicro(), 0n);
  assert.equal(new Ledger(dir).spendTotal("default"), 30_000n);
  await reconcileChannels(rpc, store);
  assert.equal(new Ledger(dir).read().filter((e) => e.t === "payment").length, 1);
});

test("ledger failure leaves escrow held; retry cannot create duplicate spend", (t) => {
  const dir = tmpDir();
  const store = new ChannelStore(dir);
  const rec = store.add(openInput());
  const failure = t.mock.method(Ledger.prototype, "append", () => { throw new Error("disk full"); });
  assert.throws(() => store.settle(rec.channelId, 30_000n), /disk full/);
  assert.equal(store.escrowedMicro(), 100_000n);
  failure.mock.restore();
  store.settle(rec.channelId, 30_000n);
  assert.equal(new Ledger(dir).spendTotal("default"), 30_000n);
});

test("a crash after ledger append leaves a complete channel snapshot and recovers exactly once", (t) => {
  const dir = tmpDir();
  const store = new ChannelStore(dir);
  const rec = store.add(openInput());
  const original = fs.renameSync;
  const failure = t.mock.method(fs, "renameSync", (from, to) => {
    if (String(to).endsWith("channels.json")) throw new Error("crash before channel commit");
    return original(from, to);
  });
  assert.throws(() => store.settle(rec.channelId, 30_000n), /crash before channel commit/);
  assert.equal(store.escrowedMicro(), 100_000n);
  assert.equal(new Ledger(dir).spendTotal("default"), 30_000n);
  assert.equal(fs.readdirSync(dir).some((file) => file.endsWith(".tmp")), false);
  failure.mock.restore();
  store.settle(rec.channelId, 30_000n);
  assert.equal(store.escrowedMicro(), 0n);
  assert.equal(new Ledger(dir).read().filter((e) => e.t === "payment").length, 1);
});

test("valid JSON with missing, duplicate, or invalid channel rows also fails closed", () => {
  for (const value of [{}, { channels: {} }, { channels: [null] }, { channels: [{ status: "garbage" }] }]) {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "channels.json"), JSON.stringify(value));
    assert.throws(() => new ChannelStore(dir).escrowedMicro(), /corrupt/);
  }
  const dir = tmpDir();
  const store = new ChannelStore(dir);
  const rec = store.add(openInput());
  fs.writeFileSync(path.join(dir, "channels.json"), JSON.stringify({ channels: [rec, rec] }));
  assert.throws(() => store.escrowedMicro(), /corrupt/);
});

test("recovered spend still blocks the next authorization at the total budget", async () => {
  const dir = tmpDir();
  const rt = createAgent(dir);
  topUp(rt, 0.10);
  rt.policyStore.save({ allowHostSuffixes: ["api.example.com"] });
  const store = new ChannelStore(dir);
  const rec = store.add(openInput({ agent: rt.agentName }));
  await reconcileChannels(fakeRpc({ [rec.channelId]: fakeAccount({ status: CHANNEL_STATUS.DISTRIBUTED,
    depositMicro: 100_000n, settledMicro: 30_000n }) }), store);
  const over = await rt.ctx.authorize(80_000n, rec.url);
  assert.equal(over.allowed, false);
  assert.equal(!over.allowed && over.rule, "budget_exhausted");
  const within = await rt.ctx.authorize(70_000n, rec.url);
  assert.equal(within.allowed, true);
  rt.stopHeartbeat?.();
});

test("legacy terminal rows missing a payment are repaired before authorizing more spend", async () => {
  const dir = tmpDir();
  const rt = createAgent(dir);
  topUp(rt, 0.10);
  rt.policyStore.save({ allowHostSuffixes: ["api.example.com"] });
  const store = new ChannelStore(dir);
  const rec = store.add(openInput({ agent: rt.agentName }));
  fs.writeFileSync(path.join(dir, "channels.json"), JSON.stringify({ channels: [{ ...rec, status: "settled",
    settledMicro: "30000", refundMicro: "70000" }] }));
  assert.equal((await rt.ctx.authorize(80_000n, rec.url)).allowed, false);
  assert.equal(rt.ledger.spendTotal(rt.agentName), 30_000n);
  rt.stopHeartbeat?.();
});

test("a receipt that arrives during reconciliation wins without duplicate ledger rows", async () => {
  const dir = tmpDir();
  const store = new ChannelStore(dir);
  const rec = store.add(openInput());
  await reconcileChannels({ getAccountData: async () => {
    store.settle(rec.channelId, 30_000n, "receipt");
    return fakeAccount({ status: CHANNEL_STATUS.DISTRIBUTED, depositMicro: 100_000n, settledMicro: 30_000n });
  } }, store);
  assert.equal(new Ledger(dir).spendTotal("default"), 30_000n);
  assert.equal(new Ledger(dir).read().filter((e) => e.t === "payment").length, 1);
});

function historyFixture(channelId: string, actual: bigint) {
  const voucher = Buffer.alloc(162);
  voucher.set(encodeVoucher({ channelId, cumulativeAmount: actual, expiresAt: 0n }), 112);
  const ix = (data: number[], accounts: string[]) => ({ programId: PAYMENT_CHANNELS_PROGRAM, accounts, data: base58Encode(Uint8Array.from(data)) });
  return {
    claim: { meta: { err: null }, transaction: { message: { instructions: [
      { programId: "Ed25519SigVerify111111111111111111111111111", data: base58Encode(voucher) },
      ix([4, 1], [addr(), channelId, addr()]), ix([7], [channelId]),
    ] } } },
    open: { meta: { err: null }, transaction: { message: { instructions: [ix([1], [addr(), addr(), addr(), addr(), addr(), channelId])] } } },
  };
}

test("finalized transaction history recovers a successful charge after PDA deallocation", async (t) => {
  const dir = tmpDir();
  const store = new ChannelStore(dir);
  const rec = store.add(openInput());
  store.markUnknown(rec.channelId);
  const txs = historyFixture(rec.channelId, 30_000n);
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const { method, params } = JSON.parse(String(init.body));
    calls.push(method);
    const result = method === "getAccountInfo" ? { value: null }
      : method === "getSignaturesForAddress" ? [{ signature: "claim", err: null }, { signature: "open", err: null }]
      : method === "getTransaction" ? txs[params[0] as keyof typeof txs] : undefined;
    assert.notEqual(result, undefined, method);
    return Response.json({ jsonrpc: "2.0", id: 1, result });
  });
  await reconcileChannels(solanaAccountRpc("https://rpc.example.com"), store);
  assert.equal(store.escrowedMicro(), 0n);
  assert.equal(new Ledger(dir).spendTotal("default"), 30_000n);
  assert.equal(store.get(rec.channelId)?.txHash, "claim");
  assert.deepEqual(calls, ["getAccountInfo", "getSignaturesForAddress", "getTransaction", "getTransaction"]);
});

test("pruned transaction history cannot release escrow", async (t) => {
  const store = new ChannelStore(tmpDir());
  const rec = store.add(openInput());
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const { method } = JSON.parse(String(init.body));
    const result = method === "getAccountInfo" ? { value: null }
      : method === "getSignaturesForAddress" ? [{ signature: "claim", err: null }] : null;
    return Response.json({ result });
  });
  await reconcileChannels(solanaAccountRpc("https://rpc.example.com"), store);
  assert.equal(store.escrowedMicro(), 100_000n);
  assert.equal(store.get(rec.channelId)?.status, "opened");
});

test("an expired open can release its hold only with complete empty history", async (t) => {
  const store = new ChannelStore(tmpDir());
  const rec = store.add(openInput({ openSlot: 2000 }));
  let first = 2500;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const { method } = JSON.parse(String(init.body));
    const result = method === "getAccountInfo" ? { value: null } : method === "getSignaturesForAddress" ? []
      : method === "getSlot" ? 4000 : first;
    return Response.json({ result });
  });
  await reconcileChannels(solanaAccountRpc("https://rpc.example.com"), store);
  assert.equal(store.escrowedMicro(), 100_000n, "pruned open-era history cannot prove absence");
  first = 100;
  await reconcileChannels(solanaAccountRpc("https://rpc.example.com"), store);
  assert.equal(store.escrowedMicro(), 0n);
  assert.equal(store.get(rec.channelId)?.status, "refunded");
});

test("reconciliation cannot refund a devnet channel using a mainnet runtime RPC", async () => {
  const store = new ChannelStore(tmpDir());
  const rec = store.add(openInput({ network: "solana-devnet", openSlot: 1000 }));
  store.markUnknown(rec.channelId);
  let reads = 0;
  await reconcileChannels({
    getAccountData: async () => { reads++; return null; },
    getClosedOutcome: async () => ({ settledMicro: 0n }),
  }, store, { network: "solana" });
  assert.equal(store.escrowedMicro(), 100_000n);
  assert.equal(reads, 0, "the wrong cluster must not be asked for this channel's outcome");
});

for (const invalid of ["failed", "wrong program", "wrong voucher channel", "unrecognized CPI"] as const) {
  test(`history recovery holds escrow for ${invalid} evidence`, async (t) => {
    const store = new ChannelStore(tmpDir());
    const rec = store.add(openInput());
    const txs = historyFixture(rec.channelId, 30_000n);
    if (invalid === "failed") Object.assign(txs.claim.meta, { err: { InstructionError: [1, "failed"] } });
    if (invalid === "wrong program") txs.claim.transaction.message.instructions[1].programId = addr();
    if (invalid === "wrong voucher channel") {
      const bytes = Buffer.alloc(162);
      bytes.set(encodeVoucher({ channelId: addr(), cumulativeAmount: 30_000n, expiresAt: 0n }), 112);
      txs.claim.transaction.message.instructions[0].data = base58Encode(bytes);
    }
    if (invalid === "unrecognized CPI") Object.assign(txs.claim.meta, { innerInstructions: [{ instructions: [
      { programId: PAYMENT_CHANNELS_PROGRAM, data: base58Encode(Uint8Array.of(2)) },
    ] }] });
    t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
      const { method, params } = JSON.parse(String(init.body));
      const result = method === "getAccountInfo" ? { value: null }
        : method === "getSignaturesForAddress" ? [{ signature: "claim", err: null }, { signature: "open", err: null }]
        : txs[params[0] as keyof typeof txs];
      return Response.json({ result });
    });
    await reconcileChannels(solanaAccountRpc("https://rpc.example.com"), store);
    assert.equal(store.escrowedMicro(), 100_000n);
  });
}
