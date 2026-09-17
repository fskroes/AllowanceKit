import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Ledger } from "../src/ledger.ts";
import { summarize, attestFromLedger, verifyAttestation, type SignedAttestation } from "../src/attestation.ts";
import { requireAttestation, attestationOf, type AttestationPolicy } from "../src/attestation-gate.ts";
import { createLiveAgent } from "../src/live.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wallie-gate-"));
}

/** Seed a realistic ledger under `agent`: 3 settled payments (2 with a txHash),
 * a block, an approved round, across two hosts. */
function seed(ledger: Ledger, agent: string): void {
  ledger.append({ t: "topup", at: "2026-09-01T00:00:00.000Z", agent, amountMicro: "5000000", source: "manual", balanceAfterMicro: "5000000" });
  ledger.append({ t: "payment", at: "2026-09-02T00:00:00.000Z", agent, url: "https://a.com/x", host: "a.com", amountMicro: "1000", txHash: "0xaa", balanceAfterMicro: "4999000" });
  ledger.append({ t: "payment", at: "2026-09-03T00:00:00.000Z", agent, url: "https://b.com/y", host: "b.com", amountMicro: "2000", txHash: "0xbb", balanceAfterMicro: "4997000" });
  ledger.append({ t: "payment", at: "2026-09-04T00:00:00.000Z", agent, url: "https://b.com/z", host: "b.com", amountMicro: "3000", txHash: "", balanceAfterMicro: "4994000" });
  ledger.append({ t: "blocked", at: "2026-09-05T00:00:00.000Z", agent, url: "https://c.com/w", host: "c.com", rule: "host_not_allowed", detail: "x", attemptedMicro: "9000" });
  ledger.append({ t: "approval_requested", at: "2026-09-06T00:00:00.000Z", agent, id: "r1", url: "https://a.com/big", host: "a.com", amountMicro: "800000" });
  ledger.append({ t: "approval_decided", at: "2026-09-06T00:01:00.000Z", agent, id: "r1", approved: true, host: "a.com", amountMicro: "800000" });
}

async function testAccount(seedByte = "44") {
  const { privateKeyToAccount } = await import("viem/accounts");
  return privateKeyToAccount(`0x${seedByte.repeat(32)}` as `0x${string}`);
}

/** A signed attestation from a fresh account whose ledger was seeded. */
async function signedFor(seedByte: string): Promise<{ att: SignedAttestation; agent: string }> {
  const dir = tmpDir();
  const account = await testAccount(seedByte);
  const ledger = new Ledger(dir);
  seed(ledger, account.address);
  const att = await attestFromLedger(account as never, ledger, account.address);
  return { att, agent: account.address };
}

function res() {
  const r = {
    statusCode: 0,
    headers: {} as Record<string, unknown>,
    body: "",
    ended: false,
    writeHead(code: number, hdrs?: Record<string, unknown>) { r.statusCode = code; if (hdrs) Object.assign(r.headers, hdrs); return r; },
    setHeader(k: string, v: unknown) { r.headers[k] = v; },
    end(b?: string) { r.body = b ?? ""; r.ended = true; },
  };
  return r;
}

/** A handler that records that it ran and returns 200. */
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

function headerFor(att: SignedAttestation): string {
  return Buffer.from(JSON.stringify(att), "utf8").toString("base64");
}

async function run(policy: AttestationPolicy, headers: Record<string, string>) {
  const { state, handler } = okHandler();
  const gate = requireAttestation(policy, handler);
  const r = res();
  await gate({ headers, url: "/", method: "GET" } as never, r as never);
  return { state, r };
}

test("summarize honors ledgerKey: filter by the ledger key, stamp identity as the address", () => {
  const ledger = new Ledger(tmpDir());
  seed(ledger, "agent");                        // rows keyed by the runtime agentName
  const s = summarize(ledger, "0xWALLET", { ledgerKey: "agent" });
  assert.equal(s.agent, "0xWALLET", "identity is the wallet address");
  assert.equal(s.payments, 3, "rows are still read under the ledger key");
  assert.equal(summarize(ledger, "0xWALLET").payments, 0, "without ledgerKey it filters by the address and finds nothing");
});

test("a valid attestation that clears the bar runs the handler", async () => {
  const { att, agent } = await signedFor("45");
  const { state, r } = await run({ minPayments: 2, minVerifiableTxCount: 2 }, { "x-attestation": headerFor(att) });
  assert.equal(state.served, true);
  assert.equal(r.statusCode, 200);
  const seen = attestationOf(state.req as never);
  assert.equal(seen?.signer, agent);
  assert.equal(seen?.summary.payments, 3);
});

test("a missing attestation header is refused before the handler", async () => {
  const { state, r } = await run({ minPayments: 1 }, {});
  assert.equal(state.served, false);
  assert.equal(r.statusCode, 403);
  assert.equal(JSON.parse(r.body).reason, "attestation required");
});

test("a malformed attestation header is refused", async () => {
  const { state, r } = await run({}, { "x-attestation": "@@not-base64-json@@" });
  assert.equal(state.served, false);
  assert.equal(r.statusCode, 403);
  assert.match(JSON.parse(r.body).reason, /malformed/);
});

test("a claim below the payment floor is refused", async () => {
  const { att } = await signedFor("46");
  const { state, r } = await run({ minPayments: 99 }, { "x-attestation": headerFor(att) });
  assert.equal(state.served, false);
  assert.equal(r.statusCode, 403);
  assert.match(JSON.parse(r.body).reason, /needs >= 99 payments/);
});

test("the verifiableTxCount floor counts only chain-checkable payments", async () => {
  const { att } = await signedFor("47"); // 3 payments, 2 with a txHash
  const pass = await run({ minVerifiableTxCount: 2 }, { "x-attestation": headerFor(att) });
  assert.equal(pass.state.served, true);
  const fail = await run({ minVerifiableTxCount: 3 }, { "x-attestation": headerFor(att) });
  assert.equal(fail.state.served, false);
  assert.match(JSON.parse(fail.r.body).reason, /on-chain-checkable/);
});

test("the allowlist gates by agent address", async () => {
  const { att, agent } = await signedFor("48");
  const denied = await run({ agents: ["0x000000000000000000000000000000000000dEaD"] }, { "x-attestation": headerFor(att) });
  assert.equal(denied.state.served, false);
  assert.match(JSON.parse(denied.r.body).reason, /allowlist/);
  const allowed = await run({ agents: [agent.toLowerCase()] }, { "x-attestation": headerFor(att) });
  assert.equal(allowed.state.served, true);
});

test("a stale claim is refused by maxAgeSecs", async () => {
  const account = await testAccount("49");
  const ledger = new Ledger(tmpDir());
  seed(ledger, account.address);
  // Issued an hour ago.
  const nowSecs = Math.floor(Date.now() / 1000);
  const att = await attestFromLedger(account as never, ledger, account.address, { now: nowSecs - 3600 });
  const { state, r } = await run({ maxAgeSecs: 600 }, { "x-attestation": headerFor(att) });
  assert.equal(state.served, false);
  assert.match(JSON.parse(r.body).reason, /stale/);
});

test("a tampered claim is refused (delegates to verifyAttestation)", async () => {
  const { att } = await signedFor("4a");
  const forged: SignedAttestation = { ...att, summary: { ...att.summary, payments: 9999 } };
  const { state, r } = await run({}, { "x-attestation": headerFor(forged) });
  assert.equal(state.served, false);
  assert.match(JSON.parse(r.body).reason, /tampered/);
});

test("bindToPayer requires the paying address to match the attestation agent", async () => {
  const { att, agent } = await signedFor("4b");
  const good = Buffer.from(JSON.stringify({ from: agent }), "utf8").toString("base64");
  const bad = Buffer.from(JSON.stringify({ from: "0x000000000000000000000000000000000000dEaD" }), "utf8").toString("base64");

  const match = await run({ bindToPayer: true }, { "x-attestation": headerFor(att), "x-payment": good });
  assert.equal(match.state.served, true, "same payer and attestation agent passes");

  const mismatch = await run({ bindToPayer: true }, { "x-attestation": headerFor(att), "x-payment": bad });
  assert.equal(mismatch.state.served, false);
  assert.match(JSON.parse(mismatch.r.body).reason, /does not match the paying address/);

  const noPay = await run({ bindToPayer: true }, { "x-attestation": headerFor(att) });
  assert.equal(noPay.state.served, false);
  assert.match(JSON.parse(noPay.r.body).reason, /no X-PAYMENT/);
});

test("a custom accept predicate has the last word", async () => {
  const { att } = await signedFor("4c");
  const denied = await run({ accept: (s) => s.blocks === 0 }, { "x-attestation": headerFor(att) }); // seed has 1 block
  assert.equal(denied.state.served, false);
  assert.match(JSON.parse(denied.r.body).reason, /policy predicate/);
  const allowed = await run({ accept: (s) => s.approvalsApproved >= 1 }, { "x-attestation": headerFor(att) });
  assert.equal(allowed.state.served, true);
});

test("onReject overrides the default 403 response", async () => {
  const { handler, state } = okHandler();
  const gate = requireAttestation({
    minPayments: 99,
    onReject: (reason, _req, rs) => { rs.writeHead(402, { "Content-Type": "application/json" }); rs.end(JSON.stringify({ custom: reason })); },
  }, handler);
  const { att } = await signedFor("4d");
  const r = res();
  await gate({ headers: { "x-attestation": headerFor(att) }, url: "/" } as never, r as never);
  assert.equal(state.served, false);
  assert.equal(r.statusCode, 402);
  assert.match(JSON.parse(r.body).custom, /needs >= 99/);
});

test("runtime.attest() signs from the live agent's own ledger and a seller gate accepts it", async () => {
  const dir = tmpDir();
  const runtime = await createLiveAgent({
    stateDir: dir,
    network: "base-sepolia",
    privateKey: `0x${"5e".repeat(32)}`,
    checkOnChainBalance: false,
  });
  try {
    // The rows a running agent would leave, keyed by its agentName (not the address).
    seed(runtime.ledger, runtime.agentName);

    const att = await runtime.attest();
    assert.equal(att.agent, runtime.address, "the claim identity is the wallet address, not the agentName");
    assert.equal(att.summary.payments, 3, "the summary read the ledger rows under agentName");
    assert.equal(att.summary.verifiableTxCount, 2);

    const verified = await verifyAttestation(att);
    assert.equal(verified.valid, true, "the payer key's signature recovers");

    // End to end: the seller gate accepts the agent's own attestation.
    const { state } = await run({ minPayments: 2, minVerifiableTxCount: 2 }, { "x-attestation": headerFor(att) });
    assert.equal(state.served, true);
  } finally {
    runtime.stopHeartbeat?.();
  }
});
