import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent, topUp, allowanceRemaining, type AgentRuntime } from "../src/wallet.ts";
import { payingFetch } from "../src/payer.ts";
import { paymentGate } from "../src/seller.ts";
import { PolicyValidationError, evaluatePolicy, policyWarnings, defaultPolicy, type RuntimePolicy } from "../src/policy.ts";
import { MockChain } from "../src/chain.ts";
import { ChannelStore } from "../src/channels.ts";
import { ApprovalStore } from "../src/approvals.ts";
import { usd } from "../src/money.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "allowance-rails-"));
}

/** A seller on the agent's own mock chain, so payments actually settle. */
async function seller(
  rt: AgentRuntime,
  priceMicro: bigint,
  facilitator = rt.chain,
): Promise<{ url: string; close(): Promise<void> }> {
  const payTo = facilitator.createAccount().address;
  const gate = paymentGate({ priceMicro, description: "test", payTo, network: "mock-ledger", facilitator }, (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const server = http.createServer((req, res) => void gate(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as { port: number };
  return {
    url: `http://localhost:${port}/resource`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function agentWith(patch: Record<string, unknown>, fundUsd: number): AgentRuntime {
  const rt = createAgent(tmpDir());
  topUp(rt, fundUsd);
  rt.policyStore.save(patch);
  return rt;
}

test("totalBudgetUsd is enforced even when the wallet is funded well above it", async () => {
  const rt = agentWith(
    { totalBudgetUsd: 1, perCallMaxUsd: 1, windowLimitUsd: 100, windowSeconds: 60, requireApprovalAboveUsd: 99 },
    10,
  );
  const s = await seller(rt, 200_000n); // $0.20

  let paid = 0;
  let lastRule = "";
  for (let i = 0; i < 10; i++) {
    const r = await payingFetch(rt.ctx, s.url);
    if (r.ok) paid++;
    else {
      lastRule = r.blockedBy?.rule ?? "";
      break;
    }
  }
  await s.close();

  assert.equal(paid, 5, "$1.00 budget at $0.20 a call must stop after five payments");
  assert.equal(lastRule, "budget_exhausted");
  assert.equal(allowanceRemaining(rt), 0n);
  assert.equal(rt.ledger.spendTotal(rt.agentName), usd(1));
});

test("the funded amount still caps spend when it is the smaller of the two", () => {
  const policy = { ...defaultPolicy, killSwitch: false, totalBudgetUsd: 100, perCallMaxUsd: 5, windowLimitUsd: 100 };
  const decision = evaluatePolicy(policy, {
    host: "localhost",
    amountMicro: usd(1),
    spendTotalMicro: 0n,
    topupsMicro: usd(0.5),
    windowSpendMicro: 0n,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.allowed === false && decision.rule, "budget_exhausted");
});

test("parallel calls cannot fan out past the velocity breaker", async () => {
  const rt = agentWith(
    { totalBudgetUsd: 100, windowLimitUsd: 1, windowSeconds: 60, perCallMaxUsd: 1, requireApprovalAboveUsd: 99 },
    100,
  );
  const s = await seller(rt, 50_000n); // $0.05 → ceiling of exactly 20 calls

  const results = await Promise.all(Array.from({ length: 40 }, () => payingFetch(rt.ctx, s.url)));
  await s.close();

  const settled = results.filter((r) => r.ok).length;
  assert.equal(settled, 20, `20 calls fit under a $1.00/60s limit, got ${settled}`);
  assert.equal(rt.ledger.spendTotal(rt.agentName), usd(1));
  assert.equal(rt.reservations.total(rt.agentName), 0n, "every reservation must be settled or released");
});

test("a seller-rejected payment reports an error, logs it, and spends nothing", async () => {
  const rt = agentWith({ perCallMaxUsd: 1, requireApprovalAboveUsd: 99 }, 5);
  // A facilitator on a different chain does not know this payer.
  const foreign = new MockChain();
  const s = await seller(rt, 10_000n, foreign);

  const before = allowanceRemaining(rt);
  const res = await payingFetch(rt.ctx, s.url);
  await s.close();

  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /unknown payer account/);
  assert.equal(res.blockedBy?.rule, "settlement_rejected");
  assert.equal(res.costMicro, 0n);
  assert.equal(res.quotedMicro, 10_000n);
  assert.equal(allowanceRemaining(rt), before, "a refused payment must not consume allowance");
  assert.equal(rt.reservations.total(rt.agentName), 0n, "the hold must be released");
  const blocked = rt.ledger.read().filter((e) => e.t === "blocked");
  assert.equal(blocked.length, 1, "a refused payment must leave an audit trail");
});

test("a block carries what an agent needs to correct itself", async () => {
  const rt = agentWith({ perCallMaxUsd: 0.01, requireApprovalAboveUsd: 0.005, windowLimitUsd: 10 }, 5);
  const s = await seller(rt, 370_000n); // $0.37 against a $0.01 cap
  const res = await payingFetch(rt.ctx, s.url);
  await s.close();

  assert.equal(res.blockedBy?.rule, "per_call_cap");
  assert.equal(res.blockedBy?.recoverable, false);
  assert.equal(res.blockedBy?.quotedMicro, 370_000n);
  assert.equal(res.blockedBy?.capMicro, 10_000n);
  assert.equal(res.quotedMicro, 370_000n);
});

test("a velocity block says how long to wait", () => {
  const policy = { ...defaultPolicy, killSwitch: false, windowSeconds: 30, windowLimitUsd: 1 };
  const decision = evaluatePolicy(policy, {
    host: "localhost",
    amountMicro: usd(0.5),
    spendTotalMicro: 0n,
    topupsMicro: usd(100),
    windowSpendMicro: usd(0.9),
  });
  assert.equal(decision.allowed === false && decision.rule, "velocity_circuit_breaker");
  assert.equal(decision.allowed === false && decision.retryAfterMs, 30_000);
  assert.equal(decision.allowed === false && decision.recoverable, true);
});

test("unknown, mistyped and negative policy fields are rejected, not written", () => {
  const rt = createAgent(tmpDir());
  assert.throws(() => rt.policyStore.save({ perCallMax: 0.05 } as never), PolicyValidationError);
  assert.throws(() => rt.policyStore.save({ perCallMaxUSD: 0.05 } as never), /did you mean "perCallMaxUsd"/);
  assert.throws(() => rt.policyStore.save({ totalBudgetUsd: -5 }), /cannot be negative/);
  assert.throws(() => rt.policyStore.save({ killSwitch: "yes" } as never), /must be true or false/);
  assert.throws(() => rt.policyStore.save({ allowHostSuffixes: "localhost" } as never), /list of hostnames/);

  const saved = JSON.parse(fs.readFileSync(path.join(rt.stateDir, "config.json"), "utf8")) as Record<string, unknown>;
  assert.equal("perCallMax" in saved, false);
  assert.equal("perCallMaxUSD" in saved, false);
  assert.equal(saved.perCallMaxUsd, defaultPolicy.perCallMaxUsd);
});

test("rails that shadow each other produce a warning", () => {
  const shadowed = policyWarnings({ ...defaultPolicy, killSwitch: false, perCallMaxUsd: 0.1, requireApprovalAboveUsd: 0.3 });
  assert.equal(shadowed.some((w) => w.includes("approval gate can never fire")), true);

  const wildcard = policyWarnings({ ...defaultPolicy, killSwitch: false, allowHostSuffixes: ["*"] });
  assert.equal(wildcard.some((w) => w.includes("allowlist is disabled")), true);

  const sane = policyWarnings({ ...defaultPolicy, killSwitch: false, totalBudgetUsd: 50, windowLimitUsd: 2, perCallMaxUsd: 0.5, requireApprovalAboveUsd: 0.3 });
  assert.deepEqual(sane, []);
});

test("funding without a ledger entry is impossible through the public API", () => {
  const rt = createAgent(tmpDir());
  assert.equal(allowanceRemaining(rt), 0n);
  topUp(rt, 2.5);
  assert.equal(allowanceRemaining(rt), usd(2.5));
  assert.equal(rt.chain.balance(rt.address), usd(2.5), "chain balance and ledger must agree");
  assert.throws(() => topUp(rt, 0), /positive/);
  assert.throws(() => topUp(rt, 1e9), /typo/);
});

test("the pre-flight check never queues a $0.00 approval, even at a zero threshold", async () => {
  const rt = agentWith({ requireApprovalAboveUsd: 0, perCallMaxUsd: 1 }, 5);
  const s = await seller(rt, 10_000n);
  const res = await payingFetch(rt.ctx, s.url);
  await s.close();

  const queued = rt.approvals.list();
  assert.equal(res.blockedBy?.rule, "human_approval_required", "a real price still needs approval at a zero threshold");
  assert.equal(queued.length, 1, "exactly one request, for the quoted price");
  assert.equal(queued[0].amountMicro, "10000");
});

// ---------------------------------------------------------------------------
// SOL-06: the Solana `upto` policy mapping (docs/SOLANA-ARCHITECTURE.md §5).
// One test per row of the table: the ceiling is what every rail checks, escrow
// is a third leg of the budget, and grants are drawn by the ceiling but only
// consume the actual.
// ---------------------------------------------------------------------------

/** A full runtime policy with sane rails, overridden per test. */
function pol(patch: Partial<RuntimePolicy> = {}): RuntimePolicy {
  return { ...defaultPolicy, killSwitch: false, ...patch };
}

test("§5 kill switch: a Solana `upto` open is refused like any other spend", () => {
  const decision = evaluatePolicy(pol({ killSwitch: true }), {
    host: "localhost",
    amountMicro: usd(0.1),
    spendTotalMicro: 0n,
    topupsMicro: usd(100),
    windowSpendMicro: 0n,
    scheme: "upto",
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.allowed === false && decision.rule, "kill_switch");
});

test("§5 per-call cap: the ceiling is what is measured, not the eventual charge", () => {
  const base = {
    host: "localhost",
    spendTotalMicro: 0n,
    topupsMicro: usd(100),
    windowSpendMicro: 0n,
  };
  // A $0.10 ceiling against a $0.05 cap is refused even though the seller may
  // charge far less — the buyer authorizes the whole ceiling.
  const over = evaluatePolicy(pol({ perCallMaxUsd: 0.05, windowLimitUsd: 100 }), {
    ...base,
    amountMicro: usd(0.1),
    scheme: "upto",
  });
  assert.equal(over.allowed === false && over.rule, "per_call_cap");
  assert.match(over.allowed === false ? over.detail : "", /ceiling/, "an `upto` block says ceiling, not price");

  // A ceiling at exactly the cap is allowed.
  const atCap = evaluatePolicy(pol({ perCallMaxUsd: 0.05, windowLimitUsd: 100 }), {
    ...base,
    amountMicro: usd(0.05),
    scheme: "upto",
  });
  assert.equal(atCap.allowed, true);
});

test("§5 velocity: the window sum plus this ceiling trips the breaker (counts opens)", () => {
  // windowSpendMicro carries prior opens' ceilings; this ceiling pushes over.
  const decision = evaluatePolicy(pol({ windowSeconds: 30, windowLimitUsd: 1, perCallMaxUsd: 1 }), {
    host: "localhost",
    amountMicro: usd(0.2),
    spendTotalMicro: 0n,
    topupsMicro: usd(100),
    windowSpendMicro: usd(0.9),
    scheme: "upto",
  });
  assert.equal(decision.allowed === false && decision.rule, "velocity_circuit_breaker");
  assert.equal(decision.allowed === false && decision.retryAfterMs, 30_000);
});

test("§5 budget: escrow is subtracted alongside spend and reservations", () => {
  const base = {
    host: "localhost",
    amountMicro: usd(0.5),
    spendTotalMicro: 0n,
    topupsMicro: usd(1),
    windowSpendMicro: 0n,
    scheme: "upto" as const,
  };
  // $0.70 escrowed leaves $0.30 of a $1 budget — a $0.50 ceiling will not fit.
  const over = evaluatePolicy(pol({ totalBudgetUsd: 1, perCallMaxUsd: 1, windowLimitUsd: 100 }), {
    ...base,
    escrowedMicro: usd(0.7),
  });
  assert.equal(over.allowed === false && over.rule, "budget_exhausted");
  assert.match(over.allowed === false ? over.detail : "", /locked in open channels/);

  // The same ceiling fits when nothing is escrowed.
  const ok = evaluatePolicy(pol({ totalBudgetUsd: 1, perCallMaxUsd: 1, windowLimitUsd: 100 }), {
    ...base,
    escrowedMicro: 0n,
  });
  assert.equal(ok.allowed, true);
});

test("§5 insufficient funds: the wallet must cover the whole ceiling at open", () => {
  const decision = evaluatePolicy(pol({ totalBudgetUsd: 100, perCallMaxUsd: 1, windowLimitUsd: 100 }), {
    host: "localhost",
    amountMicro: usd(0.1),
    spendTotalMicro: 0n,
    topupsMicro: usd(100),
    windowSpendMicro: 0n,
    walletBalanceMicro: usd(0.05),
    scheme: "upto",
  });
  assert.equal(decision.allowed === false && decision.rule, "insufficient_funds");
  assert.match(decision.allowed === false ? decision.detail : "", /ceiling/);
});

test("§5 approval: the ceiling is what crosses the human-approval threshold", async () => {
  const rt = agentWith(
    { requireApprovalAboveUsd: 0.05, perCallMaxUsd: 1, windowLimitUsd: 100, totalBudgetUsd: 100 },
    100,
  );
  const decision = await rt.ctx.authorize(usd(0.1), "http://localhost/x", "upto");
  assert.equal(decision.allowed, false);
  assert.equal(decision.allowed === false && decision.rule, "human_approval_required");
  assert.match(decision.allowed === false ? decision.detail : "", /ceiling/);

  const queued = rt.approvals.list();
  assert.equal(queued.length, 1, "one request, queued at the ceiling");
  assert.equal(queued[0].amountMicro, usd(0.1).toString());
});

test("§5 grant: drawn down by the ceiling, refunded by the unspent remainder", () => {
  const store = new ApprovalStore(tmpDir(), "a");
  const req = store.findOrCreate("a", "http://h/x", "h", usd(0.1));
  const grant = store.decide(req.id, true, { budgetMicro: usd(1) })!;
  const reread = () => store.list().find((r) => r.id === grant.id)!;

  // Authorize commits the whole $0.10 ceiling against a $1.00 grant.
  store.commit(grant.id, usd(0.1));
  assert.equal(store.remainingMicro(reread()), usd(0.9), "the ceiling is committed at authorize");

  // The seller charged $0.03; the $0.07 refund returns to the grant.
  store.settleCommitment(grant.id, usd(0.1), usd(0.03));
  assert.equal(store.remainingMicro(reread()), usd(0.97), "only the $0.03 actual stays committed");
});

test("§5 authorize on the live runtime subtracts open-channel escrow from the budget", async () => {
  const rt = agentWith({ totalBudgetUsd: 1, perCallMaxUsd: 1, windowLimitUsd: 100, requireApprovalAboveUsd: 99 }, 1);
  new ChannelStore(rt.stateDir).add({
    channelId: "c1",
    agent: rt.agentName,
    url: "http://localhost/x",
    host: "localhost",
    network: "solana-devnet",
    depositMicro: usd(0.7),
    withdrawDelay: 60,
  });
  const over = await rt.ctx.authorize(usd(0.4), "http://localhost/x", "upto");
  assert.equal(over.allowed, false, "$0.70 escrowed leaves only $0.30 of a $1 budget");
  assert.equal(over.allowed === false && over.rule, "budget_exhausted");
  assert.match(over.allowed === false ? over.detail : "", /locked in open channels/);
});

test("§5 an in-flight upto open is counted once, not as both a reservation and its escrow", () => {
  const rt = agentWith({ totalBudgetUsd: 1, perCallMaxUsd: 1, windowLimitUsd: 100 }, 1);
  // Mid-flight: `authorize` opened a reservation for the $0.50 ceiling, then
  // `upto.open` wrote the escrow row for the same channel, referencing it. The
  // same $0.50 must be subtracted once, not twice.
  const res = rt.reservations.open(rt.agentName, "http://h/x", "h", usd(0.5));
  const channels = new ChannelStore(rt.stateDir);
  channels.add({
    channelId: "c-inflight",
    agent: rt.agentName,
    url: "http://h/x",
    host: "h",
    network: "solana-devnet",
    depositMicro: usd(0.5),
    withdrawDelay: 60,
    reservationId: res.id,
  });
  assert.equal(allowanceRemaining(rt), usd(0.5), "reserved and escrow of one channel do not double-count");

  // Once the reservation closes (the send failed → orphan), the escrow row now
  // carries the money: still $0.50 total committed, still counted exactly once.
  rt.reservations.close(res.id);
  assert.equal(rt.escrowedMicro?.(), usd(0.5), "the deposit is now escrow");
  assert.equal(allowanceRemaining(rt), usd(0.5), "the same $0.50, now counted as escrow");
});

test("§5 done: allowanceRemaining is budget − spent − reserved − escrowed with one open channel", () => {
  const rt = agentWith({ totalBudgetUsd: 10, perCallMaxUsd: 5, windowLimitUsd: 100 }, 10);

  // spent: a settled payment row.
  rt.ledger.append({
    t: "payment",
    at: new Date().toISOString(),
    agent: rt.agentName,
    url: "http://h/a",
    host: "h",
    amountMicro: usd(0.5).toString(),
    txHash: "t",
    balanceAfterMicro: "0",
  });
  // reserved: an in-flight exact payment.
  rt.reservations.open(rt.agentName, "http://h/b", "h", usd(1));
  // escrowed: one open Solana `upto` channel.
  new ChannelStore(rt.stateDir).add({
    channelId: "chan-1",
    agent: rt.agentName,
    url: "http://h/c",
    host: "h",
    network: "solana-devnet",
    depositMicro: usd(2),
    withdrawDelay: 60,
  });

  assert.equal(rt.escrowedMicro?.(), usd(2));
  assert.equal(allowanceRemaining(rt), usd(10) - usd(0.5) - usd(1) - usd(2));
});
