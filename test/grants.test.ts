import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent, topUp, decideApproval, listAgents, type AgentRuntime } from "../src/wallet.ts";
import { ApprovalStore, DEFAULT_GRANT_TTL_MS } from "../src/approvals.ts";
import { usd } from "../src/money.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "allowance-grants-"));
}

/** An agent whose approval gate fires at $0.10 and whose other rails stay out of the way. */
function agentWithGate(dir = tmpDir(), name?: string): AgentRuntime {
  const rt = createAgent(dir, name);
  topUp(rt, 20);
  rt.policyStore.save({
    allowHostSuffixes: ["api.example.com", "other.example.com"],
    requireApprovalAboveUsd: 0.1,
    perCallMaxUsd: 5,
    windowLimitUsd: 20,
    totalBudgetUsd: 20,
  });
  return rt;
}

const URL_A = "https://api.example.com/story";

/** Queues an approval by trying to pay, and hands back the request id. */
async function queue(rt: AgentRuntime, amount: bigint, url = URL_A): Promise<string> {
  const decision = await rt.ctx.authorize(amount, url);
  assert.equal(decision.allowed, false, "the gate should have parked this");
  assert.equal(decision.allowed === false && decision.rule, "human_approval_required");
  return decision.allowed === false ? decision.requestId! : "";
}

test("an approval covers the payment it was asked about, then stops", async () => {
  const rt = agentWithGate();
  const id = await queue(rt, usd(0.4));

  assert.equal(decideApproval(rt, id, true), true);

  const first = await rt.ctx.authorize(usd(0.4), URL_A);
  assert.equal(first.allowed, true, "the payment the human said yes to goes through");
  await rt.ctx.recordPayment(URL_A, "api.example.com", usd(0.4), "0xabc", first.allowed ? first.reservationId : undefined);

  const second = await rt.ctx.authorize(usd(0.4), URL_A);
  assert.equal(second.allowed, false, "one yes is not a standing licence");
  assert.equal(second.allowed === false && second.rule, "human_approval_required");
  assert.notEqual(second.allowed === false && second.requestId, id, "it is asked again, as a new request");
});

test("a grant with a budget covers repeat payments until the budget runs out", async () => {
  const rt = agentWithGate();
  const id = await queue(rt, usd(0.4));
  assert.equal(decideApproval(rt, id, true, { budgetMicro: usd(1) }), true);

  for (const attempt of [1, 2]) {
    const d = await rt.ctx.authorize(usd(0.4), URL_A);
    assert.equal(d.allowed, true, `payment ${attempt} of $0.40 fits inside the $1.00 grant`);
    await rt.ctx.recordPayment(URL_A, "api.example.com", usd(0.4), "0xabc", d.allowed ? d.reservationId : undefined);
  }

  const third = await rt.ctx.authorize(usd(0.4), URL_A);
  assert.equal(third.allowed, false, "$1.20 does not fit in $1.00");
  assert.equal(third.allowed === false && third.rule, "human_approval_required");

  const grant = rt.approvals.list().find((r) => r.id === id)!;
  assert.equal(rt.approvals.remainingMicro(grant), usd(0.2));
});

test("a payment that never settles hands its budget back to the grant", async () => {
  const rt = agentWithGate();
  const id = await queue(rt, usd(0.4));
  decideApproval(rt, id, true, { budgetMicro: usd(0.8) });

  const first = await rt.ctx.authorize(usd(0.4), URL_A);
  assert.equal(first.allowed, true);
  await rt.ctx.releaseReservation!(first.allowed ? first.reservationId! : "");

  const grant = rt.approvals.list().find((r) => r.id === id)!;
  assert.equal(rt.approvals.remainingMicro(grant), usd(0.8), "a failed payment is not a spent approval");

  const retry = await rt.ctx.authorize(usd(0.4), URL_A);
  assert.equal(retry.allowed, true, "so the retry still goes through");
});

test("an expired grant stops covering payments", async () => {
  const rt = agentWithGate();
  const id = await queue(rt, usd(0.4));
  decideApproval(rt, id, true, { expiresInMs: -1_000, budgetMicro: usd(5) });

  const blocked = await rt.ctx.authorize(usd(0.4), URL_A);
  assert.equal(blocked.allowed, false, "yesterday's yes is not today's");
  assert.equal(blocked.allowed === false && blocked.rule, "human_approval_required");
  assert.equal(rt.approvals.activeGrants().length, 0);
});

test("approvals expire in a day unless a human says otherwise", () => {
  const store = new ApprovalStore(tmpDir(), "research-agent");
  const req = store.findOrCreate("research-agent", URL_A, "api.example.com", usd(0.4));
  const decided = store.decide(req.id, true)!;

  const life = Date.parse(decided.expiresAt!) - Date.now();
  assert.ok(Math.abs(life - DEFAULT_GRANT_TTL_MS) < 5_000, "a day, not forever");
  assert.equal(decided.grantBudgetMicro, usd(0.4).toString(), "and only for what was asked");

  const forever = store.decide(store.findOrCreate("research-agent", URL_A, "api.example.com", usd(0.5)).id, true, {
    expiresInMs: null,
  })!;
  assert.equal(forever.expiresAt, undefined, "a standing grant is available, but only on request");
});

test("a grant for one host does not pay another", async () => {
  const rt = agentWithGate();
  const id = await queue(rt, usd(0.4));
  decideApproval(rt, id, true, { budgetMicro: usd(5) });

  const elsewhere = await rt.ctx.authorize(usd(0.4), "https://other.example.com/story");
  assert.equal(elsewhere.allowed, false);
  assert.equal(elsewhere.allowed === false && elsewhere.rule, "human_approval_required");
});

test("two agents in one directory keep separate limits, allowances and approvals", async () => {
  const dir = tmpDir();
  const research = agentWithGate(dir);
  const writer = createAgent(dir, "writer");
  topUp(writer, 3);
  writer.policyStore.save({ perCallMaxUsd: 0.02, allowHostSuffixes: ["api.example.com"] });

  assert.equal(research.policy().perCallMaxUsd, 5, "the second agent's limits do not leak into the first");
  assert.equal(writer.policy().perCallMaxUsd, 0.02);
  assert.equal(research.ledger.totals("research-agent", 0).topupsMicro, usd(20));
  assert.equal(writer.ledger.totals("writer", 0).topupsMicro, usd(3), "allowances are per agent, not per directory");

  await queue(research, usd(0.4));
  assert.equal(research.approvals.pending().length, 1);
  assert.equal(writer.approvals.pending().length, 0, "one agent's queue is not the other's");

  assert.deepEqual(listAgents(dir), ["research-agent", "writer"]);
  assert.ok(fs.existsSync(path.join(dir, "config.json")), "the first agent keeps the original file name");
  assert.ok(fs.existsSync(path.join(dir, "config.writer.json")));
});
