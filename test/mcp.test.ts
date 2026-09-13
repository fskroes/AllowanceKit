import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createAgent, topUp } from "../src/wallet.ts";
import { createLiveAgent } from "../src/live.ts";
import { createMcpServer, handleToolCall, resolveBinding, TOOL_DEFINITIONS, type McpBinding } from "../src/mcp.ts";
import { paymentGate } from "../src/seller.ts";
import { MockChain } from "../src/chain.ts";
import { ChannelStore } from "../src/channels.ts";
import { PolicyStore } from "../src/policy.ts";
import { Ledger, type LedgerEvent } from "../src/ledger.ts";
import {
  InMemoryUptoOperator,
  type OfferExtraInput,
  type UptoOperator,
  type UptoPaymentEnvelope,
} from "../src/seller-upto.ts";
import { getBase58Decoder } from "@solana/kit";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

/**
 * The MCP server surface (docs/SOLANA-ARCHITECTURE.md §8, SOL-07). The five
 * tools are exercised over the real MCP protocol: `tools/list` against the
 * spawned `wallie-mcp` bin over stdio (the done-when clause), and `tools/call`
 * against a linked in-memory client/server for the money paths — a mock `exact`
 * buy, a ceiling block whose reason is the human `RULE_LABELS` text, and a fully
 * offline Solana `upto` buy that settles below the ceiling and refunds the rest.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const TOOL_NAMES = ["decide_approval", "get_budget", "list_channels", "pay_fetch", "reclaim_channel"];

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "allowance-mcp-"));
}

function randomAddr(): string {
  return getBase58Decoder().decode(new Uint8Array(crypto.randomBytes(32)));
}

/** A throwaway 64-byte Solana secret, JSON-array form (`solana-keygen`'s shape). */
function keyJson(): string {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  const seed = pkcs8.subarray(pkcs8.length - 32);
  const spki = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer;
  const pub = spki.subarray(spki.length - 32);
  return JSON.stringify(Array.from(Buffer.concat([seed, pub])));
}

/** A linked MCP client speaking to a server that governs `binding`. */
async function connectClient(binding: McpBinding): Promise<{ client: Client; close(): Promise<void> }> {
  const server = await createMcpServer(binding);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function structured(result: unknown): Record<string, unknown> {
  return (result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
}

function summaryText(result: unknown): string {
  return ((result as { content?: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("\n");
}

function paymentRows(dir: string): Extract<LedgerEvent, { t: "payment" }>[] {
  return new Ledger(dir).read().filter((e): e is Extract<LedgerEvent, { t: "payment" }> => e.t === "payment");
}

// A mock `exact` seller on localhost, sharing the buyer's MockChain file so its
// facilitator knows the payer key. Priced in micro-USDC.
async function startMockSeller(
  accountsPath: string,
  priceMicro: bigint,
  payTo = "0xSeller000000000000000000000000000000mock",
): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer(
    paymentGate(
      { priceMicro, description: "mock priced api", payTo, facilitator: new MockChain(accountsPath) },
      (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      },
    ),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as { port: number };
  return { url: `http://localhost:${port}/data`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

// A Solana `upto` seller whose advertised `extra` pins a blockhash and slot, so
// the buyer's open build is zero-RPC and the whole loop runs offline.
function pinnedOperator(): { operator: UptoOperator; base: InMemoryUptoOperator } {
  const base = new InMemoryUptoOperator({ feePayer: randomAddr(), receiverAuthorizer: randomAddr() });
  const blockhash = randomAddr();
  const operator: UptoOperator = {
    offerExtra: async (i: OfferExtraInput) => ({
      ...(await base.offerExtra(i)),
      recentBlockhash: blockhash,
      recentSlot: 200_000_000,
      lastValidBlockHeight: 200_000_150,
    }),
    openDeposit: (e: UptoPaymentEnvelope) => base.openDeposit(e),
    settleClaim: (e: UptoPaymentEnvelope, a: bigint) => base.settleClaim(e, a),
  };
  return { operator, base };
}

async function startUptoSeller(operator: UptoOperator, perRowMicro: bigint, ceilingMicro: bigint) {
  const server = http.createServer(
    paymentGate(
      {
        priceMicro: perRowMicro,
        description: "metered rows",
        payTo: randomAddr(),
        network: "solana-devnet",
        facilitator: new MockChain(),
        upto: { ceilingMicro, operator },
      },
      (req, res, meter?: import("../src/seller-upto.ts").Meter) => {
        const rows = Math.max(0, Number(new URL(req.url ?? "/", "http://x").searchParams.get("rows") ?? "1") || 0);
        meter?.charge(perRowMicro * BigInt(rows));
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ rows }));
      },
    ),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as { port: number };
  return { url: (rows: number) => `http://localhost:${port}/rows?rows=${rows}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

// ---------------------------------------------------------------------------

test("the wallie-mcp bin answers tools/list with the five tools over real stdio", async () => {
  const dir = tmpDir();
  const client = new Client({ name: "probe", version: "0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(here, "..", "src", "mcp-bin.ts")],
    env: { ...process.env, ALLOWANCE_STATE_DIR: dir } as Record<string, string>,
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, TOOL_NAMES, "exactly the five tools");
    for (const t of tools) assert.ok(t.description && t.description.length > 0, `${t.name} has a description`);
    // Every tool advertises a JSON-Schema object input.
    for (const t of tools) assert.equal((t.inputSchema as { type?: string }).type, "object");
  } finally {
    await client.close();
  }
});

test("TOOL_DEFINITIONS is exactly the five documented tools", () => {
  assert.deepEqual(TOOL_DEFINITIONS.map((t) => t.name).sort(), TOOL_NAMES);
});

test("pay_fetch settles a mock exact buy and get_budget reflects the spend", async () => {
  const dir = tmpDir();
  const buyer = createAgent(dir);
  topUp(buyer, 5);
  const seller = await startMockSeller(path.join(dir, "accounts.json"), 1000n); // $0.001
  const { client, close } = await connectClient({ runtime: buyer });
  try {
    const res = await client.callTool({ name: "pay_fetch", arguments: { url: seller.url } });
    const s = structured(res);
    assert.equal((s.cost as { micro: string }).micro, "1000", "spent exactly the price");
    assert.equal(s.ok, true);
    assert.match(summaryText(res), /^PAID/, "the summary reads PAID");
    assert.equal(paymentRows(dir).length, 1, "one payment row landed");

    const budget = structured(await client.callTool({ name: "get_budget", arguments: {} }));
    assert.equal((budget.spent as { micro: string }).micro, "1000");
    assert.equal((budget.funded as { micro: string }).micro, "5000000");
    assert.equal((budget.remaining as { micro: string }).micro, "4999000");
    assert.equal((budget.window as { seconds: number }).seconds, buyer.policy().windowSeconds);
    // The §5 identity holds: funded − spent − reserved − escrowed == remaining.
    const m = (k: string) => BigInt((budget[k] as { micro: string }).micro);
    assert.equal(m("funded") - m("spent") - m("reserved") - m("escrowed"), m("remaining"));
  } finally {
    await close();
    await seller.close();
  }
});

test("pay_fetch over the per-call cap is blocked and surfaces the RULE_LABELS text", async () => {
  const dir = tmpDir();
  const buyer = createAgent(dir);
  topUp(buyer, 5);
  new PolicyStore(dir, buyer.agentName).save({ perCallMaxUsd: 0.0005 }); // below the $0.001 price
  const seller = await startMockSeller(path.join(dir, "accounts.json"), 1000n);
  const { client, close } = await connectClient({ runtime: buyer });
  try {
    const res = await client.callTool({ name: "pay_fetch", arguments: { url: seller.url } });
    const s = structured(res);
    const blocked = s.blocked as { rule: string; label: string; detail: string };
    assert.equal(blocked.rule, "per_call_cap");
    assert.equal(blocked.label, "Over your per-payment limit", "the human RULE_LABELS text, not the enum");
    assert.equal(s.ok, false);
    assert.match(summaryText(res), /^BLOCKED\s+Over your per-payment limit/);
    assert.equal(paymentRows(dir).length, 0, "nothing settled");
  } finally {
    await close();
    await seller.close();
  }
});

test("decide_approval approves a queued charge so the retry goes through", async () => {
  const dir = tmpDir();
  const buyer = createAgent(dir);
  topUp(buyer, 5);
  new PolicyStore(dir, buyer.agentName).save({ requireApprovalAboveUsd: 0.0005 }); // $0.001 needs approval
  const seller = await startMockSeller(path.join(dir, "accounts.json"), 1000n);
  const { client, close } = await connectClient({ runtime: buyer });
  try {
    const blockedRes = structured(await client.callTool({ name: "pay_fetch", arguments: { url: seller.url } }));
    const req = (blockedRes.blocked as { rule: string; requestId?: string });
    assert.equal(req.rule, "human_approval_required");
    assert.ok(req.requestId, "an approval id is handed back");

    const decided = structured(await client.callTool({ name: "decide_approval", arguments: { id: req.requestId, approve: true } }));
    assert.equal(decided.ok, true);

    const paid = structured(await client.callTool({ name: "pay_fetch", arguments: { url: seller.url } }));
    assert.equal(paid.ok, true, "the grant lets the retry settle");
    assert.equal((paid.cost as { micro: string }).micro, "1000");

    // A bad id is a soft failure listing what is pending, not a throw.
    const miss = structured(await client.callTool({ name: "decide_approval", arguments: { id: "nope", approve: true } }));
    assert.equal(miss.ok, false);
  } finally {
    await close();
    await seller.close();
  }
});

test("pay_fetch on a Solana upto seller settles below the ceiling, refunds the rest, and lists the channel", async () => {
  const dir = tmpDir();
  const { operator, base } = pinnedOperator();
  const seller = await startUptoSeller(operator, 1000n, 100000n); // $0.001/row, $0.10 ceiling
  const buyer = await createLiveAgent({
    stateDir: dir,
    privateKey: keyJson(),
    network: "solana-devnet",
    rpcUrl: "http://127.0.0.1:1", // never reached — the encode is zero-RPC
    checkOnChainBalance: false,
    preferScheme: "upto",
  });
  topUp(buyer, 1);
  const { client, close } = await connectClient({ runtime: buyer, network: buyer.network, rpcUrl: buyer.rpcUrl });
  try {
    const res = structured(await client.callTool({ name: "pay_fetch", arguments: { url: seller.url(30) } })); // 30 × $0.001
    assert.equal(res.ok, true);
    assert.equal((res.cost as { micro: string }).micro, "30000", "charged the metered actual");
    assert.equal((res.quoted as { micro: string }).micro, "100000", "quoted the ceiling");
    assert.equal((res.refund as { micro: string }).micro, "70000", "the rest of the deposit refunds");
    const channelId = res.channelId as string;
    assert.ok(channelId, "the channel id is reported");
    assert.equal(base.calls.claim, 1, "the seller settled exactly once");

    const list = structured(await client.callTool({ name: "list_channels", arguments: {} }));
    const channels = list.channels as { channelId: string; status: string; settled: { micro: string }; refund: { micro: string } }[];
    assert.equal(channels.length, 1);
    assert.equal(channels[0].channelId, channelId);
    assert.equal(channels[0].status, "settled");
    assert.equal(channels[0].settled.micro, "30000");
    assert.equal(channels[0].refund.micro, "70000");
    assert.equal((list.escrowed as { micro: string }).micro, "0", "a settled channel escrows nothing");

    const budget = structured(await client.callTool({ name: "get_budget", arguments: {} }));
    assert.equal((budget.escrowed as { micro: string }).micro, "0");
    assert.equal((budget.spent as { micro: string }).micro, "30000");
  } finally {
    buyer.stopHeartbeat?.();
    await close();
    await seller.close();
  }
});

test("reclaim_channel is a clear message when there is no such channel", async () => {
  const dir = tmpDir();
  const buyer = createAgent(dir);
  const res = await handleToolCall({ runtime: buyer }, "reclaim_channel", { id: "DoesNotExist" });
  assert.equal(res.isError, true);
  assert.match(summaryText(res), /no channel/);
});

test("reclaim_channel refuses a non-Solana channel and one it cannot sign for", async () => {
  const dir = tmpDir();
  const buyer = createAgent(dir);
  const store = new ChannelStore(dir);

  // A channel on an EVM network — no reclaim exists for that rail.
  store.add({ channelId: "EvmChan", agent: buyer.agentName, url: "http://x/y", host: "x", network: "base-sepolia", depositMicro: 1000n, withdrawDelay: 900 });
  const evm = await handleToolCall({ runtime: buyer }, "reclaim_channel", { id: "EvmChan" });
  assert.equal(evm.isError, true);
  assert.match(summaryText(evm), /Solana `upto` only/);

  // A Solana channel, but the binding has no key/rpc to sign the reclaim.
  store.add({ channelId: "SolChan", agent: buyer.agentName, url: "http://x/y", host: "x", network: "solana-devnet", depositMicro: 1000n, withdrawDelay: 900 });
  const noKey = await handleToolCall({ runtime: buyer }, "reclaim_channel", { id: "SolChan" });
  assert.equal(noKey.isError, true);
  assert.match(summaryText(noKey), /needs a Solana live agent with its key/);

  // Another agent's channel in the same directory is not reclaimable by this one.
  store.add({ channelId: "OtherChan", agent: "someone-else", url: "http://x/y", host: "x", network: "solana-devnet", depositMicro: 1000n, withdrawDelay: 900 });
  const other = await handleToolCall({ runtime: buyer }, "reclaim_channel", { id: "OtherChan" });
  assert.equal(other.isError, true);
  assert.match(summaryText(other), /no channel/);
});

test("tool handlers reject bad input without throwing", async () => {
  const dir = tmpDir();
  const buyer = createAgent(dir);
  const b = { runtime: buyer };
  assert.equal((await handleToolCall(b, "pay_fetch", {})).isError, true);
  assert.equal((await handleToolCall(b, "decide_approval", { id: "x" })).isError, true); // no `approve`
  assert.equal((await handleToolCall(b, "decide_approval", { approve: true })).isError, true); // no `id`
  assert.equal((await handleToolCall(b, "reclaim_channel", {})).isError, true); // no `id`
  assert.equal((await handleToolCall(b, "no_such_tool", {})).isError, true);
});

test("pay_fetch forwards method and body to the seller", async () => {
  const dir = tmpDir();
  const buyer = createAgent(dir);
  topUp(buyer, 5);
  // A free (unpriced) echo server: no 402, just report what it received.
  const seen: { method?: string; body?: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, body });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ got: body }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as { port: number };
  const { client, close } = await connectClient({ runtime: buyer });
  try {
    const res = structured(await client.callTool({ name: "pay_fetch", arguments: { url: `http://localhost:${port}/echo`, body: "{\"hi\":1}" } }));
    assert.equal(res.ok, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, "POST", "a body defaults the method to POST");
    assert.equal(seen[0].body, "{\"hi\":1}", "the body reached the seller");
  } finally {
    await close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("importing allowance-kit does not resolve @modelcontextprotocol/sdk (optional peer)", () => {
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-resolve-log-")), "specifiers.txt");
  const child = spawnSync(
    process.execPath,
    ["--import", path.join(here, "no-solana-register.mjs"), path.join(here, "no-mcp-driver.mjs")],
    { env: { ...process.env, RESOLVE_LOG: logFile }, encoding: "utf8" },
  );
  assert.equal(child.status, 0, `driver failed:\n${child.stderr}`);
  const resolved = fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean);
  assert.ok(resolved.length > 0, "the resolve hook recorded nothing");
  const sdk = resolved.filter((s) => s.includes("@modelcontextprotocol/sdk"));
  assert.deepEqual(sdk, [], `importing the root entry resolved the MCP SDK: ${sdk.join(", ")}`);
});

test("resolveBinding reads a practice directory as a mock agent", async () => {
  const dir = tmpDir();
  const binding = await resolveBinding({ stateDir: dir });
  assert.equal(binding.runtime.mode, "practice");
  assert.equal(binding.privateKey, undefined);
});
