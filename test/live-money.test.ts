import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLiveAgent, NETWORKS } from "../src/live.ts";
import { createAgent, topUp, allowanceRemaining } from "../src/wallet.ts";
import { evaluatePolicy, defaultPolicy, PolicyStore } from "../src/policy.ts";
import { readMode } from "../src/mode.ts";
import { BalanceCache, usdcBalanceMicro, RpcError } from "../src/usdc.ts";
import { usd } from "../src/money.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "allowance-live-"));
}

/** A well-known throwaway key. Nothing here ever broadcasts a transaction. */
const KEY = "0x" + "11".repeat(32);

/** A stand-in JSON-RPC node: records what was asked, answers what it was told to. */
async function rpc(answer: string | { error: string } | { status: number }): Promise<{
  url: string;
  calls: { method: string; params: unknown[] }[];
  close(): Promise<void>;
}> {
  const calls: { method: string; params: unknown[] }[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      calls.push(JSON.parse(raw) as { method: string; params: unknown[] });
      if (typeof answer === "object" && "status" in answer) {
        res.writeHead(answer.status);
        res.end("nope");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          typeof answer === "string"
            ? { jsonrpc: "2.0", id: 1, result: answer }
            : { jsonrpc: "2.0", id: 1, error: { message: answer.error } },
        ),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const USDC = NETWORKS["base-sepolia"].usdc;
const WALLET = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";

test("a live agent can be funded — the allowance is recorded without a faucet", async () => {
  const dir = tmpDir();
  const live = await createLiveAgent({ stateDir: dir, privateKey: KEY, checkOnChainBalance: false });

  assert.equal(topUp(live, 5), usd(5), "topUp returns the spendable allowance");
  assert.equal(allowanceRemaining(live), usd(5));

  const topups = live.ledger.read().filter((e) => e.t === "topup");
  assert.equal(topups.length, 1, "the ledger records the top-up, or the rails read it as unfunded");
  assert.equal(topups[0].amountMicro, usd(5).toString());
  assert.ok(!fs.existsSync(path.join(dir, "accounts.json")), "no simulated balance is invented for real money");
});

test("a directory a live agent claimed never reports itself as practice money", async () => {
  const dir = tmpDir();
  const live = await createLiveAgent({ stateDir: dir, privateKey: KEY, network: "base-sepolia", checkOnChainBalance: false });

  const marker = readMode(dir);
  assert.equal(marker.mode, "live");
  assert.equal(marker.network, "base-sepolia");
  assert.equal(marker.address, live.address);

  // The CLI and the dashboard both go through createAgent.
  const managed = createAgent(dir);
  assert.equal(managed.mode, "live", "the management runtime inherits the rail");
  assert.equal(managed.address, live.address, "and shows the real payer, not a simulated one");
});

test("a live agent refuses to sign for a chain it was not configured for", async () => {
  const dir = tmpDir();
  const live = await createLiveAgent({ stateDir: dir, privateKey: KEY, network: "base-sepolia", checkOnChainBalance: false });

  await assert.rejects(
    () =>
      live.ctx.encodePayment!({
        x402Version: 1,
        scheme: "exact",
        network: "base",
        resource: "https://api.example.com/x",
        from: live.address,
        payTo: WALLET,
        amount: "1000",
        nonce: "abc",
        timestamp: Date.now(),
        requirements: {
          scheme: "exact",
          network: "base",
          maxAmountRequired: "1000",
          resource: "https://api.example.com/x",
          payTo: WALLET,
          asset: NETWORKS.base.usdc,
        },
      }),
    /configured for "base-sepolia"/,
    "a mainnet quote to a testnet agent is refused before anything is signed",
  );
});

test("the wallet balance is read straight off the chain, in ledger units", async () => {
  const node = await rpc("0x00000000000000000000000000000000000000000000000000000000000d4950");
  try {
    const balance = await usdcBalanceMicro(node.url, USDC, WALLET);
    assert.equal(balance, 870_736n, "USDC is 6 decimals, which is what the ledger counts in");

    const [params] = node.calls[0].params as [{ to: string; data: string }, string];
    assert.equal(node.calls[0].method, "eth_call");
    assert.equal(params.to, USDC);
    assert.equal(
      params.data,
      "0x70a08231" + WALLET.slice(2).toLowerCase().padStart(64, "0"),
      "balanceOf(address), left-padded to 32 bytes",
    );
  } finally {
    await node.close();
  }
});

test("an RPC that errors is reported, not silently read as a zero balance", async () => {
  const node = await rpc({ error: "execution reverted" });
  try {
    await assert.rejects(() => usdcBalanceMicro(node.url, USDC, WALLET), RpcError);
  } finally {
    await node.close();
  }
  const broken = await rpc({ status: 502 });
  try {
    await assert.rejects(() => usdcBalanceMicro(broken.url, USDC, WALLET), /HTTP 502/);
  } finally {
    await broken.close();
  }
});

test("the balance cache spares the node, and an outage cannot freeze an agent", async () => {
  let reads = 0;
  let fail = false;
  const cache = new BalanceCache(
    async () => {
      reads++;
      if (fail) throw new RpcError("node down");
      return 1_000_000n;
    },
    60_000,
  );

  assert.equal(await cache.get(), 1_000_000n);
  assert.equal(await cache.get(), 1_000_000n);
  assert.equal(reads, 1, "a second authorize inside the TTL does not hit the network again");

  fail = true;
  cache.invalidate();
  assert.equal(await cache.get(), 1_000_000n, "an unreachable node falls back to the last reading");
  assert.equal(reads, 2);
});

test("a payment the allowance permits but the wallet cannot cover is refused", () => {
  const policy = { ...defaultPolicy, killSwitch: false, allowHostSuffixes: ["api.example.com"], requireApprovalAboveUsd: 5 };
  const base = {
    host: "api.example.com",
    amountMicro: usd(0.4),
    spendTotalMicro: 0n,
    topupsMicro: usd(5),
    windowSpendMicro: 0n,
  };

  const covered = evaluatePolicy(policy, { ...base, walletBalanceMicro: usd(1) });
  assert.equal(covered.allowed, true, "a funded wallet passes");

  const short = evaluatePolicy(policy, { ...base, walletBalanceMicro: usd(0.1) });
  assert.equal(short.allowed, false);
  assert.equal(short.allowed === false && short.rule, "insufficient_funds");
  assert.equal(short.allowed === false && short.recoverable, true, "sending USDC fixes it");
  assert.match(
    short.allowed === false ? short.detail : "",
    /wallet holds \$0\.10/,
    "the block says what the wallet actually has",
  );

  const unknown = evaluatePolicy(policy, base);
  assert.equal(unknown.allowed, true, "an unreadable chain falls back to the ledger rather than freezing spend");
});

test("the allowance still speaks before the wallet does", () => {
  const policy = { ...defaultPolicy, killSwitch: false, allowHostSuffixes: ["api.example.com"], requireApprovalAboveUsd: 5 };
  const decision = evaluatePolicy(policy, {
    host: "api.example.com",
    amountMicro: usd(0.4),
    spendTotalMicro: usd(5),
    topupsMicro: usd(5),
    windowSpendMicro: 0n,
    walletBalanceMicro: 0n,
  });
  assert.equal(decision.allowed === false && decision.rule, "budget_exhausted", "the limit a human set is the headline");
});

test("a live agent's rails consult the chain before authorizing", async () => {
  const dir = tmpDir();
  // 0x0f4240 = 1_000_000 micro = $1.00 in the wallet.
  const node = await rpc("0x00000000000000000000000000000000000000000000000000000000000f4240");
  try {
    const live = await createLiveAgent({ stateDir: dir, privateKey: KEY, rpcUrl: node.url });
    topUp(live, 50);
    new PolicyStore(dir, live.agentName).save({
      allowHostSuffixes: ["api.example.com"],
      perCallMaxUsd: 10,
      windowLimitUsd: 20,
      totalBudgetUsd: 50,
      requireApprovalAboveUsd: 40,
    });

    const affordable = await live.ctx.authorize(usd(0.5), "https://api.example.com/x");
    assert.equal(affordable.allowed, true, "$0.50 out of a $1.00 wallet");

    const beyond = await live.ctx.authorize(usd(5), "https://api.example.com/x");
    assert.equal(beyond.allowed, false, "$5.00 is inside a $50 allowance but outside a $1.00 wallet");
    assert.equal(beyond.allowed === false && beyond.rule, "insufficient_funds");
  } finally {
    await node.close();
  }
});
