import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NotifyStore, Notifier, deliver, type Message, type NotifyConfig } from "../src/notify.ts";
import { usd } from "../src/money.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "allowance-notify-"));
}

/** A notifier that records what it would have sent instead of reaching the network. */
function spy(dir: string, agent = "research-agent") {
  const sent: Message[] = [];
  const store = new NotifyStore(dir);
  const notifier = new Notifier(store, agent, async (_cfg, msg) => {
    sent.push(msg);
  });
  return { sent, store, notifier };
}

/** A webhook that records bodies, and can be told to fail. */
async function receiver(status = 200): Promise<{ url: string; bodies: unknown[]; close(): Promise<void> }> {
  const bodies: unknown[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    bodies,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** The notifier dispatches without awaiting, so give the microtask queue a turn. */
const settle = () => new Promise((r) => setTimeout(r, 10));

test("a spending threshold announces itself once, not on every payment after it", async () => {
  const dir = tmpDir();
  const { sent, store, notifier } = spy(dir);
  store.save({ webhookUrl: "https://example.com/hook" });

  const budget = usd(10);
  notifier.spendChanged(usd(1), budget); // 10% — below every threshold
  await settle();
  assert.equal(sent.length, 0, "no alert below the first threshold");

  notifier.spendChanged(usd(5), budget); // 50%
  notifier.spendChanged(usd(6), budget); // still 50-band
  notifier.spendChanged(usd(7), budget);
  await settle();
  assert.equal(sent.length, 1, "50% is announced once, not three times");
  assert.match(sent[0]!.subject, /spent 50% of its allowance/);
  assert.match(sent[0]!.body, /\$5\.00 of \$10\.00 spent\. \$5\.00 left\./);

  notifier.spendChanged(usd(8), budget); // 80%
  await settle();
  assert.equal(sent.length, 2);
  assert.match(sent[1]!.subject, /spent 80%/);

  notifier.spendChanged(usd(10), budget); // 100%
  await settle();
  assert.equal(sent.length, 3);
  assert.match(sent[2]!.subject, /has used its whole allowance/);
  assert.match(sent[2]!.body, /no further payments will go through/);
});

test("topping up rearms the thresholds instead of going quiet forever", async () => {
  const dir = tmpDir();
  const { sent, store, notifier } = spy(dir);
  store.save({ webhookUrl: "https://example.com/hook" });

  notifier.spendChanged(usd(5), usd(10)); // 50% of a $10 allowance
  await settle();
  assert.equal(sent.length, 1);

  // A $10 top-up doubles the budget: the same $5 is now 25%, below the mark.
  notifier.spendChanged(usd(5), usd(20));
  await settle();
  assert.equal(sent.length, 1, "falling back below a mark rearms quietly, it does not alert");
  assert.equal(store.load().highWater, 0);

  notifier.spendChanged(usd(10), usd(20)); // 50% again, of the larger allowance
  await settle();
  assert.equal(sent.length, 2, "the next 50% is announced on its own merits");
});

test("a block explains itself in plain English and says nothing moved", async () => {
  const dir = tmpDir();
  const { sent, store, notifier } = spy(dir);
  store.save({ webhookUrl: "https://example.com/hook" });

  notifier.blocked("api.example.com", "per_call_cap", "$0.90 is over your $0.50 per-payment limit", usd(0.9));
  await settle();

  assert.equal(sent.length, 1);
  assert.match(sent[0]!.subject, /was stopped: over your per-payment limit/);
  assert.match(sent[0]!.body, /Nothing moved\./);
  assert.equal(sent[0]!.data.rule, "per_call_cap");
  assert.equal(sent[0]!.data.host, "api.example.com");
});

test("an approval block does not double-alert — the approval message covers it", async () => {
  const dir = tmpDir();
  const { sent, store, notifier } = spy(dir);
  store.save({ webhookUrl: "https://example.com/hook" });

  notifier.blocked("api.example.com", "human_approval_required", "queued", usd(0.4));
  await settle();
  assert.equal(sent.length, 0);
});

test("a queued approval carries the exact commands to decide it", async () => {
  const dir = tmpDir();
  const { sent, store, notifier } = spy(dir);
  store.save({ webhookUrl: "https://example.com/hook" });

  notifier.approvalQueued("f2f16328", "api.example.com", usd(0.42), "npx wallie");
  await settle();

  assert.equal(sent.length, 1);
  assert.match(sent[0]!.subject, /waiting on you: \$0\.42 to api\.example\.com/);
  assert.match(sent[0]!.body, /Nothing has moved yet/);
  assert.match(sent[0]!.body, /npx wallie approve f2f16328/);
  assert.match(sent[0]!.body, /npx wallie deny f2f16328/);
});

test("nothing is sent when no channel is configured", async () => {
  const dir = tmpDir();
  const { sent, notifier } = spy(dir);
  notifier.spendChanged(usd(9), usd(10));
  notifier.blocked("api.example.com", "per_call_cap", "over", usd(1));
  notifier.approvalQueued("abc", "api.example.com", usd(1), "npx wallie");
  await settle();
  assert.equal(sent.length, 0);
});

test("the webhook payload is shaped for Slack and for machines at the same time", async () => {
  const hook = await receiver();
  try {
    const cfg: NotifyConfig = { thresholds: [50], onBlock: true, onApproval: true, highWater: 0, webhookUrl: hook.url };
    const results = await deliver(cfg, {
      event: "blocked",
      subject: "Agent was stopped",
      body: "It tried to pay $0.90.",
      data: { host: "api.example.com", rule: "per_call_cap" },
    });

    assert.deepEqual(results, [{ channel: "webhook", ok: true, detail: "200", attempts: 1 }]);
    const body = hook.bodies[0] as Record<string, unknown>;
    assert.equal(body.text, "Agent was stopped\nIt tried to pay $0.90.", "Slack renders `text`");
    assert.equal(body.content, body.text, "Discord renders `content`");
    assert.equal(body.event, "blocked");
    assert.equal(body.rule, "per_call_cap", "structured detail is flattened alongside");
  } finally {
    await hook.close();
  }
});

test("a webhook that errors is reported, not thrown", async () => {
  const hook = await receiver(500);
  try {
    const cfg: NotifyConfig = { thresholds: [50], onBlock: true, onApproval: true, highWater: 0, webhookUrl: hook.url };
    const [res] = await deliver(cfg, { event: "threshold", subject: "s", body: "b", data: {} });
    assert.equal(res!.ok, false);
    assert.match(res!.detail, /HTTP 500/);
  } finally {
    await hook.close();
  }
});

test("a dead webhook cannot take down the caller", async () => {
  // Bind a port, then free it, so the address is well-formed and refuses fast.
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));

  const cfg: NotifyConfig = {
    thresholds: [50],
    onBlock: true,
    onApproval: true,
    highWater: 0,
    webhookUrl: `http://127.0.0.1:${port}/hook`,
  };
  const [res] = await deliver(cfg, { event: "threshold", subject: "s", body: "b", data: {} }, {});
  assert.equal(res!.ok, false, "an unreachable host resolves as a failed channel rather than rejecting");
});

test("email without a provider key names the variable instead of failing silently", async () => {
  const cfg: NotifyConfig = {
    thresholds: [50],
    onBlock: true,
    onApproval: true,
    highWater: 0,
    email: "you@example.com",
    emailProvider: "resend",
  };
  const [res] = await deliver(cfg, { event: "threshold", subject: "s", body: "b", data: {} }, {});
  assert.equal(res!.ok, false);
  assert.match(res!.detail, /RESEND_API_KEY is not set/);
});

test("a config file that no longer parses falls back to defaults instead of crashing", () => {
  const dir = tmpDir();
  const store = new NotifyStore(dir);
  fs.writeFileSync(path.join(dir, "notifications.json"), "{ not json");
  assert.deepEqual(store.load().thresholds, [50, 80, 100]);
  assert.equal(store.load().webhookUrl, undefined);
});

test("secrets never reach the config file", () => {
  const dir = tmpDir();
  const store = new NotifyStore(dir);
  store.save({ email: "you@example.com", emailProvider: "resend", emailFrom: "alerts@mine.com" });
  const raw = fs.readFileSync(path.join(dir, "notifications.json"), "utf8");
  assert.match(raw, /you@example\.com/);
  assert.doesNotMatch(raw, /API_KEY|Bearer|token/i);
});

/* ---------------------------------------------------------------------------
 * End to end: a real agent, a real seller, a real webhook.
 * These prove the wiring, not just the message text.
 * ------------------------------------------------------------------------ */

test("a live agent alerts a real webhook as it spends, is blocked, and waits", async () => {
  const { createAgent, topUp } = await import("../src/wallet.ts");
  const { payingFetch } = await import("../src/payer.ts");
  const { paymentGate } = await import("../src/seller.ts");

  const rt = createAgent(tmpDir());
  topUp(rt, 1);
  rt.policyStore.save({
    totalBudgetUsd: 1,
    perCallMaxUsd: 0.3,
    windowLimitUsd: 100,
    windowSeconds: 60,
    requireApprovalAboveUsd: 0.25,
    allowHostSuffixes: ["127.0.0.1"],
  });

  const hook = await receiver();
  rt.notifyStore.save({ webhookUrl: hook.url });

  // A seller on the agent's own mock chain, so payments really settle.
  const payTo = rt.chain.createAccount().address;
  const gate = paymentGate(
    { priceMicro: 200_000n, description: "test", payTo, network: "mock-ledger", facilitator: rt.chain },
    (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  );
  const server = http.createServer((req, res) => void gate(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/paid`;

  try {
    // $0.20 is under the $0.25 approval threshold: it settles.
    const first = await payingFetch(rt.ctx, url);
    assert.equal(first.ok, true, "the first payment should settle");
    await settle();

    // $0.20 of a $1.00 allowance is 20% — below the first threshold.
    assert.equal(hook.bodies.length, 0, "20% spent is not worth waking anyone for");

    const second = await payingFetch(rt.ctx, url);
    assert.equal(second.ok, true);
    await settle();

    // $0.40 of $1.00 is still under 50%.
    assert.equal(hook.bodies.length, 0);

    const third = await payingFetch(rt.ctx, url);
    assert.equal(third.ok, true);
    await settle();

    // $0.60 of $1.00 crosses 50%.
    const events = hook.bodies.map((b) => (b as Record<string, unknown>).event);
    assert.deepEqual(events, ["threshold"], "crossing 50% sends exactly one alert");
    const alert = hook.bodies[0] as Record<string, unknown>;
    assert.equal(alert.percent, 50);
    assert.match(String(alert.text), /spent 50% of its allowance/);
    assert.match(String(alert.text), /\$0\.60 of \$1\.00 spent/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await hook.close();
  }
});

test("a blocked payment reaches the webhook with the rule that stopped it", async () => {
  const { createAgent, topUp } = await import("../src/wallet.ts");
  const { payingFetch } = await import("../src/payer.ts");

  const rt = createAgent(tmpDir());
  topUp(rt, 5);
  rt.policyStore.save({ allowHostSuffixes: ["only-this.example.com"] });

  const hook = await receiver();
  rt.notifyStore.save({ webhookUrl: hook.url });

  const res = await payingFetch(rt.ctx, "http://127.0.0.1:1/nope");
  assert.equal(res.ok, false);
  await settle();

  assert.equal(hook.bodies.length, 1);
  const alert = hook.bodies[0] as Record<string, unknown>;
  assert.equal(alert.event, "blocked");
  assert.equal(alert.rule, "host_not_allowlisted");
  assert.match(String(alert.text), /site not on your approved list/i);
  assert.match(String(alert.text), /Nothing moved/);

  await hook.close();
});

test("a payment that needs a human reaches the webhook before anything moves", async () => {
  const { createAgent, topUp } = await import("../src/wallet.ts");
  const { payingFetch } = await import("../src/payer.ts");
  const { paymentGate } = await import("../src/seller.ts");

  const rt = createAgent(tmpDir());
  topUp(rt, 5);
  rt.policyStore.save({ requireApprovalAboveUsd: 0.1, perCallMaxUsd: 1, allowHostSuffixes: ["127.0.0.1"] });

  const hook = await receiver();
  rt.notifyStore.save({ webhookUrl: hook.url });

  const payTo = rt.chain.createAccount().address;
  const gate = paymentGate(
    { priceMicro: 200_000n, description: "test", payTo, network: "mock-ledger", facilitator: rt.chain },
    (_req, res) => res.end("{}"),
  );
  const server = http.createServer((req, res) => void gate(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/paid`;

  try {
    const res = await payingFetch(rt.ctx, url);
    assert.equal(res.ok, false);
    assert.equal(res.blockedBy?.rule, "human_approval_required");
    await settle();

    const approvals = hook.bodies.filter((b) => (b as Record<string, unknown>).event === "approval");
    assert.equal(approvals.length, 1, "exactly one alert, not one for the approval and one for the block");
    const alert = approvals[0] as Record<string, unknown>;
    assert.match(String(alert.text), /waiting on you: \$0\.20/);
    assert.match(String(alert.text), /Nothing has moved yet/);
    assert.equal(alert.requestId, res.blockedBy?.requestId);
    assert.equal(rt.ledger.spendTotal(rt.agentName), 0n, "nothing settled");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await hook.close();
  }
});
