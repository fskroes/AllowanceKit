import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Ledger } from "../src/ledger.ts";
import { summarize, attestFromLedger, verifyAttestation, type SignedAttestation } from "../src/attestation.ts";
import { requireAttestation, attestationOf, type AttestationPolicy } from "../src/attestation-gate.ts";
import {
  verifyAttestationOnChain,
  enforceOnChain,
  ERC20_TRANSFER_TOPIC,
  type TxReader,
} from "../src/attestation-chain.ts";

// Base Sepolia USDC — what networkInfo("base-sepolia").usdc resolves to, so an
// injected client needs no network calls but the token match is still exercised.
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wallie-chain-"));
}

async function testAccount(seedByte = "77") {
  const { privateKeyToAccount } = await import("viem/accounts");
  return privateKeyToAccount(`0x${seedByte.repeat(32)}` as `0x${string}`);
}

/** Two settled payments (txHash 0xaa, 0xbb) and one without a hash, one host. */
function seed(ledger: Ledger, agent: string): void {
  ledger.append({ t: "topup", at: "2026-09-01T00:00:00.000Z", agent, amountMicro: "5000000", source: "manual", balanceAfterMicro: "5000000" });
  ledger.append({ t: "payment", at: "2026-09-02T00:00:00.000Z", agent, url: "https://a.com/x", host: "a.com", amountMicro: "1000", txHash: "0xaa", balanceAfterMicro: "4999000" });
  ledger.append({ t: "payment", at: "2026-09-03T00:00:00.000Z", agent, url: "https://a.com/y", host: "a.com", amountMicro: "2000", txHash: "0xbb", balanceAfterMicro: "4997000" });
  ledger.append({ t: "payment", at: "2026-09-04T00:00:00.000Z", agent, url: "https://a.com/z", host: "a.com", amountMicro: "3000", txHash: "", balanceAfterMicro: "4994000" });
}

/** A signed attestation with the txHash evidence attached. */
async function evidenceAttFor(seedByte: string): Promise<{ att: SignedAttestation; agent: string }> {
  const account = await testAccount(seedByte);
  const ledger = new Ledger(tmpDir());
  seed(ledger, account.address);
  const att = await attestFromLedger(account as never, ledger, account.address, { includeEvidence: true });
  return { att, agent: account.address };
}

/** A 32-byte topic that left-pads a 20-byte address. */
function padTopic(addr: string): string {
  return "0x" + "0".repeat(24) + addr.slice(2).toLowerCase();
}

function transferLog(from: string, to: string, valueMicro: number, token = USDC) {
  return {
    address: token,
    topics: [ERC20_TRANSFER_TOPIC, padTopic(from), padTopic(to)],
    data: "0x" + valueMicro.toString(16),
  };
}

type Receipt = { status: "success" | "reverted"; logs: ReturnType<typeof transferLog>[] };

/**
 * A reader over a fixed map. A present key returns its receipt (or null); a
 * missing key throws, as viem's getTransactionReceipt does for an unknown hash.
 * `calls` records every lookup so a test can assert the client was not reached.
 */
function reader(map: Record<string, Receipt | null>): TxReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getTransactionReceipt({ hash }) {
      calls.push(hash);
      if (!(hash in map)) throw new Error(`transaction ${hash} not found`);
      return map[hash];
    },
  };
}

// --- summarize evidence -----------------------------------------------------

test("summarize attaches txHash evidence only when asked (privacy default)", () => {
  const ledger = new Ledger(tmpDir());
  seed(ledger, "agent");

  const off = summarize(ledger, "agent");
  assert.equal(off.verifiableTxCount, 2);
  assert.equal(off.verifiableTxHashes, undefined, "no evidence by default — the summary stays counts-only");

  const on = summarize(ledger, "agent", { includeEvidence: true });
  assert.deepEqual(on.verifiableTxHashes, ["0xaa", "0xbb"], "in ledger order");
  assert.equal(on.verifiableTxHashes?.length, on.verifiableTxCount, "one hash per verifiable payment");
});

test("the evidence rides inside the signed digest, so it cannot be swapped after signing", async () => {
  const { att } = await evidenceAttFor("70");
  const forged: SignedAttestation = {
    ...att,
    summary: { ...att.summary, verifiableTxHashes: ["0xdead", "0xbeef"] },
  };
  const res = await verifyAttestation(forged);
  assert.equal(res.valid, false, "changing the evidence breaks the digest");
});

// --- verifyAttestationOnChain ----------------------------------------------

test("on-chain check passes when each evidence tx settled and moved USDC from the agent", async () => {
  const { att, agent } = await evidenceAttFor("71");
  const client = reader({
    "0xaa": { status: "success", logs: [transferLog(agent, "0x000000000000000000000000000000000000cafe", 1000)] },
    "0xbb": { status: "success", logs: [transferLog(agent, "0x000000000000000000000000000000000000cafe", 2000)] },
  });
  const r = await verifyAttestationOnChain(att, { client, network: "base-sepolia" });
  assert.equal(r.supported, true);
  assert.equal(r.checked, 2);
  assert.equal(r.verified, 2);
  assert.equal(r.claimed, 2);
  assert.equal(r.weak, false, "USDC token was known, so the match was strict");
  assert.deepEqual(r.failures, []);
});

test("a reverted tx and a missing tx both fail on-chain", async () => {
  const { att, agent } = await evidenceAttFor("72");
  const client = reader({
    "0xaa": { status: "reverted", logs: [transferLog(agent, "0x00000000000000000000000000000000000000ff", 1000)] },
    // 0xbb absent -> lookup throws -> "not found"
  });
  const r = await verifyAttestationOnChain(att, { client, network: "base-sepolia" });
  assert.equal(r.verified, 0);
  assert.equal(r.failures.length, 2);
  assert.match(r.failures.find((f) => f.txHash === "0xaa")!.reason, /did not succeed/);
  assert.match(r.failures.find((f) => f.txHash === "0xbb")!.reason, /lookup failed/);
});

test("a Transfer from a different address does not count as the agent's payment", async () => {
  const { att, agent } = await evidenceAttFor("73");
  const other = "0x00000000000000000000000000000000000000aa";
  const client = reader({
    "0xaa": { status: "success", logs: [transferLog(other, "0x00000000000000000000000000000000000000bb", 1000)] },
    "0xbb": { status: "success", logs: [transferLog(agent, "0x00000000000000000000000000000000000000bb", 2000)] },
  });
  const r = await verifyAttestationOnChain(att, { client, network: "base-sepolia" });
  assert.equal(r.verified, 1, "only the tx whose Transfer.from is the agent counts");
  assert.match(r.failures[0].reason, /no USDC Transfer from the agent/);
});

test("a non-USDC token fails a strict check but passes a weak one", async () => {
  const { att, agent } = await evidenceAttFor("74");
  const notUsdc = "0x1111111111111111111111111111111111111111";
  const logs = [transferLog(agent, "0x00000000000000000000000000000000000000bb", 1000, notUsdc)];
  const map = { "0xaa": { status: "success" as const, logs }, "0xbb": { status: "success" as const, logs } };

  const strict = await verifyAttestationOnChain(att, { client: reader(map), network: "base-sepolia" });
  assert.equal(strict.verified, 0, "wrong token, strict USDC match rejects");
  assert.equal(strict.weak, false);

  // No network and no usdc -> any ERC-20 Transfer from the agent counts, flagged weak.
  const weak = await verifyAttestationOnChain(att, { client: reader(map) });
  assert.equal(weak.verified, 2);
  assert.equal(weak.weak, true);
});

test("an attestation with no evidence is unsupported for on-chain checking", async () => {
  const account = await testAccount("75");
  const ledger = new Ledger(tmpDir());
  seed(ledger, account.address);
  const att = await attestFromLedger(account as never, ledger, account.address); // no includeEvidence
  const r = await verifyAttestationOnChain(att, { client: reader({}), network: "base-sepolia" });
  assert.equal(r.supported, false);
  assert.match(r.reason!, /includeEvidence/);
  assert.equal(r.claimed, 2, "it still reports how many the summary claimed");
});

// --- enforceOnChain ---------------------------------------------------------

test("enforceOnChain applies minVerified and requireAll", async () => {
  const { att, agent } = await evidenceAttFor("76");
  // Only one of the two evidence txs verifies.
  const client = reader({
    "0xaa": { status: "success", logs: [transferLog(agent, "0x00000000000000000000000000000000000000bb", 1000)] },
    "0xbb": { status: "reverted", logs: [] },
  });
  const opts = { client, network: "base-sepolia" };

  const one = await enforceOnChain(att, { ...opts, minVerified: 1 });
  assert.equal(one.ok, true);

  const two = await enforceOnChain(att, { ...opts, minVerified: 2 });
  assert.equal(two.ok, false);
  if (!two.ok) assert.match(two.reason, /1\/2 evidence txs verified, needed 2/);

  const all = await enforceOnChain(att, { ...opts, requireAll: true });
  assert.equal(all.ok, false, "requireAll needs every claimed tx");
});

// --- verifyAttestation onChain opt -----------------------------------------

test("verifyAttestation folds the on-chain tally into a valid result", async () => {
  const { att, agent } = await evidenceAttFor("78");
  const client = reader({
    "0xaa": { status: "success", logs: [transferLog(agent, "0x00000000000000000000000000000000000000bb", 1000)] },
    "0xbb": { status: "success", logs: [transferLog(agent, "0x00000000000000000000000000000000000000bb", 2000)] },
  });
  const res = await verifyAttestation(att, { onChain: { client, network: "base-sepolia", minVerified: 2 } });
  assert.equal(res.valid, true);
  if (res.valid) {
    assert.equal(res.onChain?.verified, 2);
    assert.equal(res.onChain?.weak, false);
  }
});

test("verifyAttestation fails when the on-chain evidence does not clear the policy", async () => {
  const { att, agent } = await evidenceAttFor("79");
  const client = reader({
    "0xaa": { status: "success", logs: [transferLog(agent, "0x00000000000000000000000000000000000000bb", 1000)] },
    "0xbb": { status: "reverted", logs: [] },
  });
  const res = await verifyAttestation(att, { onChain: { client, network: "base-sepolia", requireAll: true } });
  assert.equal(res.valid, false);
  if (!res.valid) assert.match(res.reason, /on-chain check failed/);
});

// --- seller gate policy.onChain --------------------------------------------

function res() {
  const r = {
    statusCode: 0,
    headers: {} as Record<string, unknown>,
    body: "",
    writeHead(code: number, hdrs?: Record<string, unknown>) { r.statusCode = code; if (hdrs) Object.assign(r.headers, hdrs); return r; },
    end(b?: string) { r.body = b ?? ""; },
  };
  return r;
}

function okHandler() {
  const state = { served: false, req: undefined as unknown };
  const handler = (rq: unknown, rs: { writeHead: (c: number, h?: Record<string, unknown>) => unknown; end: (b?: string) => void }) => {
    state.served = true;
    state.req = rq;
    rs.writeHead(200, { "Content-Type": "application/json" });
    rs.end(JSON.stringify({ ok: true }));
  };
  return { state, handler };
}

async function run(policy: AttestationPolicy, att: SignedAttestation) {
  const { state, handler } = okHandler();
  const gate = requireAttestation(policy, handler);
  const r = res();
  const header = Buffer.from(JSON.stringify(att), "utf8").toString("base64");
  await gate({ headers: { "x-attestation": header }, url: "/", method: "GET" } as unknown as IncomingMessage, r as unknown as ServerResponse);
  return { state, r };
}

test("the gate runs the on-chain check and attaches the tally to the request", async () => {
  const { att, agent } = await evidenceAttFor("7a");
  const client = reader({
    "0xaa": { status: "success", logs: [transferLog(agent, "0x00000000000000000000000000000000000000bb", 1000)] },
    "0xbb": { status: "success", logs: [transferLog(agent, "0x00000000000000000000000000000000000000bb", 2000)] },
  });
  const { state, r } = await run(
    { minPayments: 2, onChain: { client, network: "base-sepolia", minVerified: 2 } },
    att,
  );
  assert.equal(state.served, true);
  assert.equal(r.statusCode, 200);
  assert.equal(attestationOf(state.req as IncomingMessage)?.onChain?.verified, 2);
});

test("the gate refuses when the on-chain evidence is short", async () => {
  const { att, agent } = await evidenceAttFor("7b");
  const client = reader({
    "0xaa": { status: "success", logs: [transferLog(agent, "0x00000000000000000000000000000000000000bb", 1000)] },
    "0xbb": { status: "reverted", logs: [] },
  });
  const { state, r } = await run({ onChain: { client, network: "base-sepolia", requireAll: true } }, att);
  assert.equal(state.served, false);
  assert.equal(r.statusCode, 403);
  assert.match(JSON.parse(r.body).reason, /on-chain check failed/);
});

test("the gate rejects on a cheap floor before ever touching the chain", async () => {
  const { att } = await evidenceAttFor("7c");
  const client = reader({}); // any lookup throws; it must never be called
  const { state, r } = await run({ minPayments: 99, onChain: { client, network: "base-sepolia" } }, att);
  assert.equal(state.served, false);
  assert.equal(r.statusCode, 403);
  assert.match(JSON.parse(r.body).reason, /needs >= 99 payments/);
  assert.equal(client.calls.length, 0, "the RPC is the last resort, not spent on a doomed request");
});
