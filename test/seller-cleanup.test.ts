import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UptoSvmScheme, UptoSvmRentCleanupManager } from "@x402/svm/upto/facilitator";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { checkTreasuryAta, createSolanaUptoOperator } from "../src/seller-upto.ts";
import { SellerChannelStorage, type SellerChannelRecord } from "../src/seller-channels.ts";
import { base58Encode, base58Decode } from "../src/base58.ts";
import { spawnSync } from "node:child_process";
import { paymentGate } from "../src/seller.ts";
import { MockChain } from "../src/chain.ts";

const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const PROGRAM = "11111111111111111111111111111111";

function address(): string { return base58Encode(crypto.randomBytes(32)); }

function record(over: Partial<SellerChannelRecord> = {}): SellerChannelRecord {
  return { channelId: address(), payTo: address(), tokenProgram: TOKEN, firstSeenAt: 1000, expiresAt: 100, network: NETWORK, ...over };
}

function temp(t: { after(fn: () => void): void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallie-seller-cleanup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function secret(): Uint8Array {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  return Buffer.concat([Buffer.from(jwk.d!, "base64url"), Buffer.from(jwk.x!, "base64url")]);
}

test("seller doctor accepts an existing SPL-token-owned treasury ATA", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({
    result: { value: { owner: TOKEN, data: [Buffer.alloc(165).toString("base64"), "base64"] } },
  }));
  const result = await checkTreasuryAta("solana-devnet", "https://rpc.example.com");
  assert.equal(result.ok, true, result.detail);
});

test("real seller operator starts the library cleanup worker and stops it on shutdown", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wallie-seller-cleanup-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  let starts = 0;
  let stops = 0;
  const manager = {
    start() { starts++; },
    async stop() { stops++; },
    async cleanup() {},
  };
  t.mock.method(UptoSvmScheme.prototype, "createRentCleanupManager", () => manager);
  const operator = await createSolanaUptoOperator({
    network: "solana-devnet",
    feePayerSecret: secret(),
    receiverAuthorizerSecret: secret(),
    stateDir,
  });
  assert.equal(starts, 1, "the seller must start rent cleanup without a separate opt-in");
  await operator.stop();
  assert.equal(stops, 1);
});

test("seller channel index survives restart, preserves immutable facts and expiry, and stores no extra fields", async (t) => {
  const dir = temp(t);
  const first = new SellerChannelStorage(dir);
  const row = record();
  await first.upsert({ ...row, secretKey: "must never reach disk" } as SellerChannelRecord);
  const restarted = new SellerChannelStorage(dir);
  assert.deepEqual(await restarted.get(row.channelId), row);
  await restarted.upsert({ ...row, firstSeenAt: 2000, expiresAt: 50 });
  assert.deepEqual(await first.get(row.channelId), row);
  await restarted.upsert({ ...row, expiresAt: 150 });
  assert.equal((await first.get(row.channelId))?.expiresAt, 150);
  assert.equal(fs.statSync(first.file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(first.file, "utf8").includes("secretKey"), false);
  await assert.rejects(restarted.upsert({ ...row, payTo: address() }), /conflicting immutable facts/);
  await restarted.delete(row.channelId);
  assert.deepEqual(await first.list(), []);
});

test("concurrent seller index writers cannot lose channels", async (t) => {
  const dir = temp(t);
  const rows = Array.from({ length: 12 }, () => record());
  await Promise.all(rows.map(row => new SellerChannelStorage(dir).upsert(row)));
  assert.equal((await new SellerChannelStorage(dir).list()).length, rows.length);
});

test("corrupt seller state fails closed without overwriting the index", async (t) => {
  const dir = temp(t);
  const store = new SellerChannelStorage(dir);
  for (const data of ["{", "", "{}", JSON.stringify({ version: 1, channels: [{ ...record(), expiresAt: -1 }] })]) {
    fs.writeFileSync(store.file, data);
    await assert.rejects(store.list(), /seller channel state is corrupt/);
    await assert.rejects(store.upsert(record()), /seller channel state is corrupt/);
    await assert.rejects(store.delete("missing"), /seller channel state is corrupt/);
    assert.equal(fs.readFileSync(store.file, "utf8"), data);
  }
  await assert.rejects(createSolanaUptoOperator({
    network: NETWORK, feePayerSecret: secret(), receiverAuthorizerSecret: secret(), stateDir: dir,
  }), /seller channel state is corrupt/);
});

/** Valid account bytes, while all transaction submission remains mocked. */
function accountData(status: number, feePayer: string): Buffer {
  const data = Buffer.alloc(256);
  data[0] = 1;
  data[1] = 1;
  data[3] = status;
  data.writeBigUInt64LE(100_000n, 12);
  data.writeUInt32LE(900, 52);
  for (const offset of [88, 120, 152, 184, 216]) Buffer.from(base58Decode(feePayer)).copy(data, offset);
  return data;
}

test("library cleanup retries failed settlement after process restart and refunds expired abandoned deposits once", async (t) => {
  const dir = temp(t);
  const fee = secret();
  const signer = await createKeyPairSignerFromBytes(fee);
  const row = record();
  let chain: Buffer | null = accountData(0, signer.address);
  let submissions = 0;
  let failCleanup = true;
  const managers: UptoSvmRentCleanupManager[] = [];
  t.mock.method(UptoSvmScheme.prototype, "createRentCleanupManager", function (this: UptoSvmScheme) {
    const manager = new UptoSvmRentCleanupManager({
      network: NETWORK,
      storage: this.getChannelStorage(),
      signer: {
        getSigner: () => signer,
        getAddresses: () => [signer.address],
        getLatestBlockhash: async () => ({ blockhash: PROGRAM, lastValidBlockHeight: 1000n }),
        getSlot: async () => 1000n,
        getAccountInfo: async () => chain ? {
          data: [chain.toString("base64"), "base64"], executable: false, lamports: 1n, owner: PROGRAM, space: 256n,
        } : null,
      } as never,
    });
    // The library still performs the real scan, expiry checks and account decode;
    // this seam replaces only the transaction broadcast and its chain effect.
    t.mock.method(manager, "submitCloseOrDistribute" as never, async (_signer: unknown, _record: unknown, _live: unknown, status: number) => {
      submissions++;
      assert.equal(status, 0, "failed atomic claim leaves an OPEN channel");
      if (failCleanup) throw new Error("RPC temporarily unavailable");
      chain = null; // zero-charge abandon close refunded the entire deposit
      return "cleanup-signature";
    });
    managers.push(manager);
    return manager;
  });
  t.mock.method(UptoSvmScheme.prototype, "settle", async function (this: UptoSvmScheme, payload: Record<string, any>) {
    await this.getChannelStorage().upsert(row as never);
    return payload.payload.type === "deposit"
      ? { success: true, transaction: "open-signature" }
      : { success: false, errorReason: "atomic_claim_failed" };
  });
  const options = { network: NETWORK, feePayerSecret: fee, receiverAuthorizerSecret: secret(), stateDir: dir, cleanupIntervalSecs: false as const };
  const operator = await createSolanaUptoOperator(options);
  const env = {
    x402Version: 2,
    accepted: { scheme: "upto" as const, network: NETWORK, amount: "100000", payTo: row.payTo },
    payload: { channelId: row.channelId, from: address(), maxAmount: "100000", expiresAt: 100, openSlot: 1, nonce: "1", openTransaction: "signed-open", type: "deposit" as const },
  };
  await operator.openDeposit(env);
  await assert.rejects(operator.settleClaim(env, 30_000n), /atomic_claim_failed/);
  assert.equal((await new SellerChannelStorage(dir).list()).length, 1, "failed settle remains indexed");
  const failed = await operator.sweep();
  assert.equal(failed.errors.length, 1);
  assert.equal(failed.pending, 1, "failed cleanup is durable and remains retryable");
  await operator.stop();

  // A fresh operator and library manager read the old process's persisted index.
  failCleanup = false;
  const restarted = await createSolanaUptoOperator(options);
  t.after(() => restarted.stop());
  const recovered = await restarted.sweep();
  assert.equal(recovered.closed[0]?.action, "abandon_close");
  assert.equal(recovered.pending, 0);
  assert.deepEqual(recovered.errors, []);
  assert.equal(submissions, 2, "one failed attempt and one successful refund");
  await restarted.sweep();
  assert.equal(submissions, 2, "a completed cleanup is never charged or submitted again");
  assert.equal(managers.length, 2);
});

test("library cleanup leaves an unexpired channel open and resumes after expiry", async (t) => {
  const dir = temp(t);
  const storage = new SellerChannelStorage(dir);
  const signer = await createKeyPairSignerFromBytes(secret());
  let reads = 0;
  let closes = 0;
  const now = Math.floor(Date.now() / 1000);
  await storage.upsert(record({ expiresAt: now + 300 }));
  const manager = new UptoSvmRentCleanupManager({
    network: NETWORK, storage: storage as never,
    signer: {
      getSigner: () => signer, getAddresses: () => [signer.address],
      getLatestBlockhash: async () => ({}), getSlot: async () => 0n,
      getAccountInfo: async () => {
        reads++;
        return { data: [accountData(0, signer.address).toString("base64"), "base64"], executable: false, lamports: 1n, owner: PROGRAM, space: 256n };
      },
    } as never,
  });
  t.mock.method(manager, "submitCloseOrDistribute" as never, async () => { closes++; return "tx"; });
  const errors: unknown[] = [];
  await manager.cleanup({ onError: e => errors.push(e) });
  assert.equal(reads, 1);
  assert.equal(closes, 0);
  assert.deepEqual(errors, []);
  t.mock.method(Date, "now", () => (now + 421) * 1000);
  await manager.cleanup({ onError: e => errors.push(e) });
  assert.equal(closes, 1);
  assert.deepEqual(errors, []);
});

test("seller sweep requires an explicit network and mainnet confirmation before loading keys", () => {
  const missing = spawnSync(process.execPath, ["src/cli.ts", "channels", "sweep", "--seller"], { encoding: "utf8" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /explicit --network/);
  const mainnet = spawnSync(process.execPath, ["src/cli.ts", "channels", "sweep", "--seller", "--network", "solana"], { encoding: "utf8" });
  assert.notEqual(mainnet.status, 0);
  assert.match(mainnet.stderr, /--yes to confirm/);
});

test("seller CLI sweep uses its own state directory and exits after an empty one-shot pass", (t) => {
  const dir = temp(t);
  const child = spawnSync(process.execPath, [
    "src/cli.ts", "channels", "sweep", "--seller", "--network", "solana-devnet",
    `--seller-state-dir=${dir}`, "--rpc", "http://127.0.0.1:1", "--json",
  ], {
    encoding: "utf8", timeout: 5000,
    env: { ...process.env, SELLER_FEE_PAYER_KEY: JSON.stringify([...secret()]), SELLER_AUTHORIZER_KEY: JSON.stringify([...secret()]) },
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  assert.deepEqual(JSON.parse(child.stdout), { closed: [], reclaimed: [], errors: [], pending: 0 });
});

test("a configured seller starts cleanup at boot before receiving any HTTP request", async (t) => {
  const dir = temp(t);
  let starts = 0;
  let stops = 0;
  t.mock.method(UptoSvmScheme.prototype, "createRentCleanupManager", () => ({
    start() { starts++; }, async stop() { stops++; }, async cleanup() {},
  }));
  const keyNames = ["TEST_SELLER_CLEANUP_FEE", "TEST_SELLER_CLEANUP_AUTH"];
  for (const name of keyNames) {
    const previous = process.env[name];
    process.env[name] = JSON.stringify([...secret()]);
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  const gate = paymentGate({
    network: NETWORK, priceMicro: 1000n, description: "test", payTo: address(), facilitator: new MockChain(),
    upto: { ceilingMicro: 100_000n },
    solanaOperator: { feePayerKeyEnv: keyNames[0], receiverAuthorizerKeyEnv: keyNames[1], stateDir: dir },
  }, (_req, res) => res.end());
  t.after(() => gate.stop());
  // stop() must also wait for the eagerly started asynchronous construction.
  await gate.stop();
  assert.equal(starts, 1);
  assert.equal(stops, 1);
});

test("stopping the library worker waits for an in-flight background pass", async (t) => {
  const storage = new SellerChannelStorage(temp(t));
  await storage.upsert(record());
  const signer = await createKeyPairSignerFromBytes(secret());
  let entered!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const read = new Promise<null>(resolve => { release = () => resolve(null); });
  const manager = new UptoSvmRentCleanupManager({
    network: NETWORK, storage: storage as never,
    signer: {
      getSigner: () => signer, getAddresses: () => [signer.address],
      getLatestBlockhash: async () => ({}), getSlot: async () => 0n,
      getAccountInfo: async () => { entered(); return read; },
    } as never,
  });
  t.after(() => { release(); return manager.stop(); });
  const errors: unknown[] = [];
  manager.start({ intervalSecs: 0.001, onError: error => errors.push(error) });
  await reading;
  let stopped = false;
  const stopping = manager.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false, "shutdown must wait for the pass to finish");
  release();
  await stopping;
  assert.equal(stopped, true);
  assert.deepEqual(errors, []);
});
