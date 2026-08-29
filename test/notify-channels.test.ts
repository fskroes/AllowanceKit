import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NotifyStore, Notifier, deliver, startHeartbeat, type Message, type NotifyConfig } from "../src/notify.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "allowance-channels-"));
}

const MSG: Message = {
  event: "approval",
  subject: "research-agent is waiting on you: $0.40 to api.example.com",
  body: "It wants to pay $0.40.\nNothing has moved yet.",
  data: { host: "api.example.com" },
};

/** A server that answers with a scripted sequence of statuses. */
async function scripted(statuses: number[]): Promise<{
  url: string;
  hits: { headers: http.IncomingHttpHeaders; body: string }[];
  close(): Promise<void>;
}> {
  const hits: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  let i = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      hits.push({ headers: req.headers, body: raw });
      res.writeHead(statuses[Math.min(i++, statuses.length - 1)]);
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/x`, hits, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("push lands on a phone with a title and a priority", async () => {
  const ntfy = await scripted([200]);
  try {
    const cfg: NotifyConfig = { thresholds: [], onBlock: true, onApproval: true, highWater: 0, pushTopic: ntfy.url };
    const [result] = await deliver(cfg, MSG);

    assert.equal(result.ok, true);
    assert.equal(result.channel, "push");
    assert.equal(ntfy.hits[0].headers.title, MSG.subject, "the lock screen shows the subject");
    assert.equal(ntfy.hits[0].headers.priority, "high", "a payment waiting on a human is not a low-priority ping");
    assert.equal(ntfy.hits[0].body, MSG.body);
  } finally {
    await ntfy.close();
  }
});

test("a delivery that fails for a reason retrying can fix is retried", async () => {
  const flaky = await scripted([503, 503, 200]);
  try {
    const cfg: NotifyConfig = { thresholds: [], onBlock: true, onApproval: true, highWater: 0, pushTopic: flaky.url };
    const [result] = await deliver(cfg, MSG);

    assert.equal(result.ok, true, "the third attempt got through");
    assert.equal(result.attempts, 3);
    assert.equal(flaky.hits.length, 3);
  } finally {
    await flaky.close();
  }
});

test("a rejection retrying cannot fix is not retried three times", async () => {
  const rejecting = await scripted([401]);
  try {
    const cfg: NotifyConfig = { thresholds: [], onBlock: true, onApproval: true, highWater: 0, pushTopic: rejecting.url };
    const [result] = await deliver(cfg, MSG);

    assert.equal(result.ok, false);
    assert.equal(result.attempts, 1, "a wrong key is wrong three times too");
    assert.match(result.detail, /HTTP 401/);
  } finally {
    await rejecting.close();
  }
});

test("an alert that never arrives is written down", async () => {
  const dir = tmpDir();
  const dead = await scripted([500]);
  try {
    const store = new NotifyStore(dir);
    store.save({ pushTopic: dead.url });
    const notifier = new Notifier(store, "research-agent");

    notifier.approvalQueued("abc123", "api.example.com", 400_000n, "allowance");
    await new Promise((r) => setTimeout(r, 2500)); // two backoffs, then give up

    const failures = store.recentFailures();
    assert.equal(failures.length, 1, "silence is not an acceptable record of a missed alert");
    assert.equal(failures[0].channel, "push");
    assert.equal(failures[0].event, "approval");
    assert.equal(failures[0].attempts, 3);
    assert.match(failures[0].detail, /HTTP 500/);
  } finally {
    await dead.close();
  }
});

test("sms says plainly when it cannot send instead of failing silently", async () => {
  const cfg: NotifyConfig = { thresholds: [], onBlock: true, onApproval: true, highWater: 0, sms: "+31612345678" };
  const [result] = await deliver(cfg, MSG, {});

  assert.equal(result.ok, false);
  assert.equal(result.channel, "sms");
  assert.equal(result.attempts, 1);
  assert.match(result.detail, /TWILIO_ACCOUNT_SID/, "it names the thing that is missing");
});

test("every configured channel gets the same alert", async () => {
  const hook = await scripted([200]);
  const push = await scripted([200]);
  try {
    const cfg: NotifyConfig = {
      thresholds: [],
      onBlock: true,
      onApproval: true,
      highWater: 0,
      webhookUrl: hook.url,
      pushTopic: push.url,
      sms: "+31612345678",
    };
    const results = await deliver(cfg, MSG, {});
    assert.deepEqual(
      results.map((r) => r.channel).sort(),
      ["push", "sms", "webhook"],
      "one alert, every channel that was set up",
    );
  } finally {
    await hook.close();
    await push.close();
  }
});

test("the heartbeat pings while the agent runs, and stops when it stops", async () => {
  const pings: number[] = [];
  const stop = startHeartbeat(
    { thresholds: [], onBlock: true, onApproval: true, highWater: 0, heartbeatUrl: "https://hc-ping.com/x", heartbeatSeconds: 10 },
    "research-agent",
    async () => {
      pings.push(Date.now());
    },
  );

  assert.equal(pings.length, 1, "it pings immediately, so a monitor knows it started");
  stop();
  const after = pings.length;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(pings.length, after, "nothing pings on behalf of a process that has stopped");
});

test("no heartbeat URL means no timer and no pretence", () => {
  let called = false;
  const stop = startHeartbeat({ thresholds: [], onBlock: true, onApproval: true, highWater: 0 }, "research-agent", async () => {
    called = true;
  });
  stop();
  assert.equal(called, false);
});
