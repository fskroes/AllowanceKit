import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NotifyStore, Notifier, startCloudHeartbeat, CLOUD_DEFAULT_URL } from "../src/notify.ts";
import { createAgent } from "../src/wallet.ts";
import { usd } from "../src/money.ts";

/**
 * Wallie Cloud channel (ticket C-05). The cloud is a different kind of channel
 * from the human alerts: it receives *every* decision (paid, blocked, queued)
 * plus a heartbeat, and it holds the workspace key by environment-variable name,
 * never by value. These tests stand up a local http server as the cloud and
 * prove the shape on the wire, the liveness beat, and the no-key-on-disk rule.
 */

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "allowance-cloud-"));
}

interface CloudServer {
  url: string;
  events: Array<Record<string, any>>;
  heartbeats: Array<Record<string, any>>;
  auths: string[];
  waitFor(bucket: "events" | "heartbeats", n: number, ms?: number): Promise<void>;
  close(): Promise<void>;
}

/** A stand-in for api.onewallie.com: captures /v1/events and /v1/heartbeat, answers /v1/me. */
async function cloudServer(opts: { workspace?: string } = {}): Promise<CloudServer> {
  const events: Array<Record<string, any>> = [];
  const heartbeats: Array<Record<string, any>> = [];
  const auths: string[] = [];
  const waiters: Array<{ n: number; bucket: "events" | "heartbeats"; resolve: () => void }> = [];
  const check = () => {
    for (const w of [...waiters]) {
      const len = w.bucket === "events" ? events.length : heartbeats.length;
      if (len >= w.n) {
        w.resolve();
        waiters.splice(waiters.indexOf(w), 1);
      }
    }
  };

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      auths.push(req.headers.authorization ?? "");
      if (req.url === "/v1/events") {
        events.push(raw ? JSON.parse(raw) : {});
        check();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      } else if (req.url === "/v1/heartbeat") {
        heartbeats.push(raw ? JSON.parse(raw) : {});
        check();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      } else if (req.url === "/v1/me") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ workspace: { name: opts.workspace ?? "Test Workspace" } }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;

  return {
    url: `http://127.0.0.1:${port}`,
    events,
    heartbeats,
    auths,
    waitFor(bucket, n, ms = 3000) {
      const cur = bucket === "events" ? events.length : heartbeats.length;
      if (cur >= n) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timed out waiting for ${n} ${bucket}`)), ms);
        waiters.push({ n, bucket, resolve: () => { clearTimeout(t); resolve(); } });
      });
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Spawn the real CLI as a subprocess. */
function run(args: string[], env: Record<string, string | undefined> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI, ...args], {
      env: { ...process.env, AGENT_PRIVATE_KEY: undefined, WALLIE_CLOUD_KEY: undefined, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** Every file under a state dir, joined — for proving a secret is absent from all of them. */
function readAll(dir: string): string {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => fs.readFileSync(path.join(d.parentPath ?? dir, d.name), "utf8"))
    .join("\n");
}

test("a paid, a blocked and a queued decision each reach the cloud with the right shape", async () => {
  const srv = await cloudServer();
  const keyEnv = "WALLIE_CLOUD_TEST_KEY_1";
  process.env[keyEnv] = "wk_test_abc123def456";
  try {
    const store = new NotifyStore(tmpDir());
    store.save({ cloud: { enabled: true, url: srv.url, keyEnv } });
    const notifier = new Notifier(store, "research-agent", undefined, { network: "base-sepolia", mode: "live" });

    // A live seller URL carries a query string that could be personal — it must be stripped.
    notifier.paid("https://seller.example/api?token=secret&city=lisbon", "seller.example", usd(0.01), "0xdeadbeef");
    notifier.blocked("evil.example", "host_not_allowed", "evil.example is not on your allowlist", usd(0.5));
    notifier.approvalQueued("req-1", "big.example", usd(10), "allowance-kit");

    await srv.waitFor("events", 3);
    assert.deepEqual(srv.events.map((e) => e.kind).sort(), ["approval", "blocked", "payment"]);

    for (const e of srv.events) {
      assert.equal(e.agent, "research-agent");
      assert.equal(e.network, "base-sepolia");
      assert.equal(e.mode, "live");
      assert.ok(e.subject && e.body && e.at, "every event carries a subject, body and timestamp");
    }

    const paid = srv.events.find((e) => e.kind === "payment")!;
    assert.equal(paid.data.amountMicro, usd(0.01).toString());
    assert.equal(paid.data.txHash, "0xdeadbeef");
    assert.ok(!String(paid.data.url).includes("token=secret"), "the query string must be stripped before it leaves the machine");
    assert.ok(!String(paid.data.url).includes("?"), "no query string at all");
    assert.match(paid.data.url, /^https:\/\/seller\.example\/api/);

    assert.ok(srv.auths.length >= 3 && srv.auths.every((a) => a === "Bearer wk_test_abc123def456"), "every request carries the bearer key");
  } finally {
    delete process.env[keyEnv];
    await srv.close();
  }
});

test("the heartbeat beats to the cloud until it is stopped", async () => {
  const srv = await cloudServer();
  const keyEnv = "WALLIE_CLOUD_TEST_KEY_2";
  process.env[keyEnv] = "wk_test_heartbeat";
  try {
    const stop = startCloudHeartbeat(
      { enabled: true, url: srv.url, keyEnv },
      { agent: "worker", network: "base", mode: "live", version: "0.5.0" },
      { everyMs: 20 },
    );
    try {
      await srv.waitFor("heartbeats", 2);
    } finally {
      stop();
    }
    const hb = srv.heartbeats[0];
    assert.equal(hb.agent, "worker");
    assert.equal(hb.network, "base");
    assert.equal(hb.mode, "live");
    assert.equal(hb.version, "0.5.0");
    assert.ok(srv.auths.every((a) => a === "Bearer wk_test_heartbeat"), "every heartbeat carries the bearer key");
  } finally {
    delete process.env[keyEnv];
    await srv.close();
  }
});

test("`notify cloud` enables the channel but never writes the key to disk", async () => {
  const dir = tmpDir();
  const secret = "wk_live_supersecretvalue123";
  const r = await run(["notify", "cloud", secret, "--state", dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`export WALLIE_CLOUD_KEY=${secret}`));

  const cfg = JSON.parse(fs.readFileSync(path.join(dir, "notifications.json"), "utf8"));
  assert.equal(cfg.cloud.enabled, true);
  assert.equal(cfg.cloud.keyEnv, "WALLIE_CLOUD_KEY");
  assert.equal(cfg.cloud.url, CLOUD_DEFAULT_URL);

  assert.ok(!readAll(dir).includes(secret), "the workspace key must never be written to any file under the state dir");
});

test("`notify cloud` rejects a value that is not a workspace key", async () => {
  const dir = tmpDir();
  const r = await run(["notify", "cloud", "not-a-key", "--state", dir]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /workspace key/);
  assert.ok(!fs.existsSync(path.join(dir, "notifications.json")), "a rejected key writes no config");
});

test("`notify test` reports the cloud channel by asking who the key belongs to", async () => {
  const srv = await cloudServer({ workspace: "Acme Research" });
  try {
    const dir = tmpDir();
    new NotifyStore(dir).save({ cloud: { enabled: true, url: srv.url, keyEnv: "WALLIE_CLOUD_KEY" } });
    const r = await run(["notify", "test", "--state", dir], { WALLIE_CLOUD_KEY: "wk_test_ok" });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /cloud\s+connected as Acme Research/);
  } finally {
    await srv.close();
  }
});

test("with cloud off, the runtime starts no beat and paid() is a silent no-op (demo behaves as today)", async () => {
  const dir = tmpDir();
  const rt = createAgent(dir);
  assert.equal(typeof rt.stopHeartbeat, "function", "a stop handle is always present");
  rt.stopHeartbeat?.(); // harmless when there is no timer

  const notifier = new Notifier(new NotifyStore(dir), "x");
  assert.doesNotThrow(() => notifier.paid("https://a.example/x", "a.example", usd(1)));
});

test("cloud on but the key unset fails safe: no throw, no network, recorded", async () => {
  const dir = tmpDir();
  const store = new NotifyStore(dir);
  store.save({ cloud: { enabled: true, url: "https://api.onewallie.com", keyEnv: "DEFINITELY_UNSET_KEY_XYZ" } });
  const notifier = new Notifier(store, "x", undefined, { mode: "practice" });
  notifier.paid("https://a.example/x", "a.example", usd(1));
  await new Promise((r) => setTimeout(r, 50)); // let the fire-and-forget settle
  const fails = store.recentFailures(5);
  assert.ok(fails.some((f) => f.channel === "cloud" && /not set/.test(f.detail)), "an unset key is recorded, not thrown");
});
