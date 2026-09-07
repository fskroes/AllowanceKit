import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { paymentGate } from "../src/seller.ts";

/**
 * These drive the real CLI as a subprocess — the only way to prove the money
 * front door (`init --live`, `pay`, `doctor`) behaves for a non-coder, and that
 * the mainnet guardrails and the no-key-on-disk promise hold end to end.
 */

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
/** A well-known throwaway key. Nothing here ever broadcasts a transaction. */
const KEY = "0x" + "11".repeat(32);
/** The address that key derives to — asserted, so a silent derivation change is caught. */
const KEY_ADDRESS = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "allowance-cli-"));
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Spawn the CLI (async, so any in-process http seller keeps serving). */
function run(args: string[], env: Record<string, string | undefined> = {}): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI, ...args], {
      env: { ...process.env, AGENT_PRIVATE_KEY: undefined, ...env },
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

test("init --live marks the directory live and never writes the key to disk", async () => {
  const dir = tmpDir();
  const r = await run(["init", "--live", "--network", "base-sepolia", "--state", dir], { AGENT_PRIVATE_KEY: KEY });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /REAL MONEY/);
  assert.match(r.stdout, new RegExp(KEY_ADDRESS));

  const mode = JSON.parse(fs.readFileSync(path.join(dir, "mode.json"), "utf8")) as Record<string, string>;
  assert.equal(mode.mode, "live");
  assert.equal(mode.network, "base-sepolia");
  assert.equal(mode.address, KEY_ADDRESS);

  const everything = readAll(dir);
  assert.ok(!everything.includes(KEY), "the 0x-prefixed key must not appear in any file");
  assert.ok(!everything.includes("11".repeat(32)), "nor the bare key");
});

test("init --live without a key explains how to set it, and writes nothing", async () => {
  const dir = tmpDir();
  const r = await run(["init", "--live", "--state", dir]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /AGENT_PRIVATE_KEY/);
  assert.ok(!fs.existsSync(path.join(dir, "mode.json")), "a failed init leaves no live marker");
});

test("init --live refuses to re-point a directory at a different network", async () => {
  const dir = tmpDir();
  await run(["init", "--live", "--network", "base-sepolia", "--state", dir], { AGENT_PRIVATE_KEY: KEY });
  const r = await run(["init", "--live", "--network", "base", "--yes", "--state", dir], { AGENT_PRIVATE_KEY: KEY });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /already live on base-sepolia/);
});

test("mainnet needs confirmation: --yes lets it through, its absence stops it", async () => {
  const blocked = tmpDir();
  const noConfirm = await run(["init", "--live", "--network", "base", "--state", blocked], { AGENT_PRIVATE_KEY: KEY });
  assert.equal(noConfirm.code, 1, "no TTY and no --yes must refuse");
  assert.match(noConfirm.stderr, /REAL MONEY/);
  assert.ok(!fs.existsSync(path.join(blocked, "mode.json")), "a refused mainnet init writes no marker");

  const confirmed = tmpDir();
  const ok = await run(["init", "--live", "--network", "base", "--yes", "--state", confirmed], { AGENT_PRIVATE_KEY: KEY });
  assert.equal(ok.code, 0, ok.stderr);
  const mode = JSON.parse(fs.readFileSync(path.join(confirmed, "mode.json"), "utf8")) as Record<string, string>;
  assert.equal(mode.network, "base");
});

test("on mainnet, a top-up over $50 needs --yes", async () => {
  const dir = tmpDir();
  await run(["init", "--live", "--network", "base", "--yes", "--state", dir], { AGENT_PRIVATE_KEY: KEY });

  const big = await run(["topup", "100", "--state", dir]);
  assert.equal(big.code, 1);
  assert.match(big.stderr, /REAL MONEY/);

  const small = await run(["topup", "20", "--state", dir]);
  assert.equal(small.code, 0, small.stderr);

  const bigConfirmed = await run(["topup", "100", "--yes", "--state", dir]);
  assert.equal(bigConfirmed.code, 0, bigConfirmed.stderr);
});

test("on mainnet, a policy change prints a REAL MONEY reminder", async () => {
  const dir = tmpDir();
  await run(["init", "--live", "--network", "base", "--yes", "--state", dir], { AGENT_PRIVATE_KEY: KEY });
  const r = await run(["policy", "perCallMaxUsd", "0.10", "--state", dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /REAL MONEY/);
});

test("doctor fails when a live directory has no key, and passes for a funded practice one", async () => {
  const live = tmpDir();
  await run(["init", "--live", "--network", "base-sepolia", "--state", live], { AGENT_PRIVATE_KEY: KEY });
  const noKey = await run(["doctor", "--state", live]);
  assert.equal(noKey.code, 1, "a live dir with no key in the env is a failed setup");
  assert.match(noKey.stdout, /AGENT_PRIVATE_KEY is not set/);

  const practice = tmpDir();
  await run(["init", "--state", practice]);
  const healthy = await run(["doctor", "--state", practice]);
  assert.equal(healthy.code, 0, healthy.stdout);
  assert.match(healthy.stdout, /All checks passed/);
});

test("pay blocks a host that is not on the allowlist and exits 2", async () => {
  const dir = tmpDir();
  await run(["init", "--state", dir]);
  await run(["topup", "5", "--state", dir]);
  const r = await run(["pay", "https://not-allowed.example.com/x", "--state", dir]);
  assert.equal(r.code, 2, "a policy block is exit 2, distinct from an error (1)");
  assert.match(r.stdout, /BLOCKED/);
});

test("pay settles a real 402 against a local seller and exits 0", async () => {
  const PRICE = 25_000n; // $0.025
  const server = http.createServer((req, res) => {
    void paymentGate(
      {
        priceMicro: PRICE,
        description: "test resource",
        payTo: "0xseller",
        // An always-true facilitator: this test proves the CLI drives the whole
        // 402 → sign → settle handshake, not that the mock chain verifies.
        facilitator: {
          verify: async () => ({ isValid: true, payer: "0xbuyer" }),
          settle: async () => ({ success: true, txHash: "0xabc123", network: "mock-ledger" }),
        },
      },
      (_req, res2) => {
        res2.setHeader("Content-Type", "application/json");
        res2.end(JSON.stringify({ ok: true, data: "the paid resource" }));
      },
    )(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;

  try {
    const dir = tmpDir();
    await run(["init", "--state", dir]);
    await run(["topup", "5", "--state", dir]);
    // localhost is on the default allowlist; the port is stripped before matching.
    const r = await run(["pay", `http://localhost:${port}/data`, "--state", dir]);
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /PAID/);
    assert.match(r.stdout, /0xabc123/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
