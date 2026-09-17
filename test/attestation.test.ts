import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Ledger } from "../src/ledger.ts";
import {
  summarize,
  attest,
  attestFromLedger,
  verifyAttestation,
  canonicalJson,
  ATTESTATION_DOMAIN,
  ATTESTATION_TYPES,
  type BehaviorSummary,
  type SignedAttestation,
} from "../src/attestation.ts";

const AGENT = "wallie";

function tmpLedger(): { ledger: Ledger; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallie-attest-"));
  return { ledger: new Ledger(dir), dir };
}

/** A ledger with a realistic mix: two settled payments (one with a txHash), a
 * block, an approval round, and a policy change — across two hosts. */
function seed(ledger: Ledger, agent = AGENT): void {
  ledger.append({ t: "topup", at: "2026-09-01T00:00:00.000Z", agent, amountMicro: "5000000", source: "manual", balanceAfterMicro: "5000000" });
  ledger.append({ t: "payment", at: "2026-09-02T00:00:00.000Z", agent, url: "https://api.a.com/x", host: "api.a.com", amountMicro: "1000", txHash: "0xabc", balanceAfterMicro: "4999000" });
  ledger.append({ t: "payment", at: "2026-09-03T00:00:00.000Z", agent, url: "https://api.b.com/y", host: "api.b.com", amountMicro: "2000", txHash: "", balanceAfterMicro: "4997000" });
  ledger.append({ t: "blocked", at: "2026-09-04T00:00:00.000Z", agent, url: "https://api.b.com/z", host: "api.b.com", rule: "per_call_cap", detail: "over cap", attemptedMicro: "9000000" });
  ledger.append({ t: "approval_requested", at: "2026-09-05T00:00:00.000Z", agent, id: "r1", url: "https://api.a.com/big", host: "api.a.com", amountMicro: "500000" });
  ledger.append({ t: "approval_decided", at: "2026-09-05T00:01:00.000Z", agent, id: "r1", approved: true, host: "api.a.com", amountMicro: "500000" });
  ledger.append({ t: "policy_change", at: "2026-09-06T00:00:00.000Z", agent, field: "perCallMaxUsd", value: 5 });
}

async function testAccount(seedByte = "22") {
  const { privateKeyToAccount } = await import("viem/accounts");
  return privateKeyToAccount(`0x${seedByte.repeat(32)}` as `0x${string}`);
}

test("summarize compresses the ledger into counts and totals, not raw rows", () => {
  const { ledger } = tmpLedger();
  seed(ledger);
  const s = summarize(ledger, AGENT);

  assert.equal(s.agent, AGENT);
  assert.equal(s.issuer, "wallie");
  assert.equal(s.payments, 2);
  assert.equal(s.spendTotalMicro, "3000");
  assert.equal(s.verifiableTxCount, 1, "only the payment with a non-empty txHash is chain-checkable");
  assert.equal(s.blocks, 1);
  assert.equal(s.distinctHosts, 2, "api.a.com and api.b.com");
  assert.equal(s.approvalsRequested, 1);
  assert.equal(s.approvalsApproved, 1);
  assert.equal(s.policyChanges, 1);
  assert.equal(s.periodStart, "2026-09-01T00:00:00.000Z");
  assert.equal(s.periodEnd, "2026-09-06T00:00:00.000Z");
  // The summary must not carry urls or per-payment amounts (no ledger leak).
  const flat = JSON.stringify(s);
  assert.doesNotMatch(flat, /api\.a\.com\/x/, "no urls in the summary");
});

test("summarize isolates the agent: other agents' rows do not leak in", () => {
  const { ledger } = tmpLedger();
  seed(ledger, AGENT);
  seed(ledger, "other");
  const s = summarize(ledger, AGENT);
  assert.equal(s.payments, 2, "only this agent's payments are counted");
});

test("empty ledger summarizes to zeros and null period", () => {
  const { ledger } = tmpLedger();
  const s = summarize(ledger, AGENT);
  assert.equal(s.payments, 0);
  assert.equal(s.spendTotalMicro, "0");
  assert.equal(s.distinctHosts, 0);
  assert.equal(s.periodStart, null);
  assert.equal(s.periodEnd, null);
});

test("canonicalJson sorts keys at every depth so the digest is order-independent", () => {
  const a = canonicalJson({ b: 1, a: { d: 4, c: 3 } });
  const b = canonicalJson({ a: { c: 3, d: 4 }, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":{"c":3,"d":4},"b":1}');
});

test("attest then verify round-trips and recovers to the payer address", async () => {
  const { ledger } = tmpLedger();
  const acct = await testAccount();
  seed(ledger, acct.address);
  const s = summarize(ledger, acct.address);

  const att = await attest(acct as never, s);
  assert.equal(att.agent, acct.address);
  assert.ok(att.signature.startsWith("0x"));
  assert.ok(att.expiresAt > att.issuedAt);

  const res = await verifyAttestation(att);
  assert.equal(res.valid, true);
  if (res.valid) {
    assert.equal(res.signer, acct.address);
    assert.equal(res.summary.payments, 2);
  }
});

test("attestFromLedger is summarize + attest in one call", async () => {
  const { ledger } = tmpLedger();
  const acct = await testAccount("33");
  seed(ledger, acct.address);
  const att = await attestFromLedger(acct as never, ledger, acct.address);
  const res = await verifyAttestation(att);
  assert.equal(res.valid, true);
});

test("a tampered summary fails verification (digest binds the contents)", async () => {
  const { ledger } = tmpLedger();
  const acct = await testAccount();
  seed(ledger, acct.address);
  const att = await attest(acct as never, summarize(ledger, acct.address));

  // Inflate the reputation after signing.
  const forged: SignedAttestation = { ...att, summary: { ...att.summary, payments: 9999, blocks: 0 } };
  const res = await verifyAttestation(forged);
  assert.equal(res.valid, false);
  if (!res.valid) assert.match(res.reason, /digest|tamper/i);
});

test("a foreign signature fails: swapping in another agent's signature does not verify", async () => {
  const { ledger } = tmpLedger();
  const alice = await testAccount("44");
  const mallory = await testAccount("55");
  seed(ledger, alice.address);

  const attAlice = await attest(alice as never, summarize(ledger, alice.address));
  // Mallory claims Alice's numbers but the signature is Alice's over Alice's agent;
  // rewriting the agent to Mallory breaks recovery.
  const forged: SignedAttestation = { ...attAlice, agent: mallory.address, summary: { ...attAlice.summary, agent: mallory.address } };
  const res = await verifyAttestation(forged);
  assert.equal(res.valid, false);
});

test("an expired attestation is rejected", async () => {
  const { ledger } = tmpLedger();
  const acct = await testAccount();
  seed(ledger, acct.address);
  const att = await attest(acct as never, summarize(ledger, acct.address), { now: 1_000_000, ttlSecs: 60 });
  const res = await verifyAttestation(att, { now: 1_000_000 + 61 });
  assert.equal(res.valid, false);
  if (!res.valid) assert.match(res.reason, /expired/i);
});

test("attest refuses to sign a summary that is not the signer's own", async () => {
  const acct = await testAccount();
  const notMine: BehaviorSummary = {
    agent: "0x000000000000000000000000000000000000dEaD",
    issuer: "wallie",
    runtimeVersion: "test",
    periodStart: null,
    periodEnd: null,
    payments: 0,
    spendTotalMicro: "0",
    verifiableTxCount: 0,
    blocks: 0,
    distinctHosts: 0,
    approvalsRequested: 0,
    approvalsApproved: 0,
    policyChanges: 0,
  };
  await assert.rejects(() => attest(acct as never, notMine), /only attest to its own behavior/);
});

test("the signed struct verifies under viem's own verifyTypedData with the exported domain", async () => {
  // Guards the domain/types constants: a seller reconstructing the envelope from
  // the exported ATTESTATION_DOMAIN/ATTESTATION_TYPES must reach the same result.
  const { verifyTypedData } = await import("viem");
  const { ledger } = tmpLedger();
  const acct = await testAccount("66");
  seed(ledger, acct.address);
  const att = await attest(acct as never, summarize(ledger, acct.address));

  const ok = await verifyTypedData({
    address: acct.address,
    domain: ATTESTATION_DOMAIN,
    types: ATTESTATION_TYPES,
    primaryType: "Attestation",
    message: {
      agent: att.agent as `0x${string}`,
      issuer: att.summary.issuer,
      issuedAt: BigInt(att.issuedAt),
      expiresAt: BigInt(att.expiresAt),
      digest: att.digest,
    },
    signature: att.signature,
  });
  assert.equal(ok, true);
});
