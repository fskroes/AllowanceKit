/**
 * The Wallie MCP example agent (docs/SOLANA-ARCHITECTURE.md §8, SOL-07).
 *
 * A plain script — no LLM — that drives the Wallie MCP server the way an agent
 * framework would: it lists the tools, then calls them to buy from two of the
 * demo sellers. It runs the real MCP client/server protocol over a linked
 * in-process transport, so the whole story is deterministic and offline. The
 * same server is what `npx wallie-mcp` serves over stdio (see test/mcp.test.ts).
 *
 * The transcript shows the three things a judge should see:
 *   1. an `exact` buy that settles,
 *   2. a payment blocked at the ceiling, named in plain `RULE_LABELS` language,
 *   3. a Solana `upto` buy that settles below its ceiling and refunds the rest.
 *
 * Run it:  node demo/mcp-agent/agent.ts
 */
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent, topUp } from "../../src/wallet.ts";
import { createLiveAgent } from "../../src/live.ts";
import { createMcpServer, type McpBinding } from "../../src/mcp.ts";
import { PolicyStore } from "../../src/policy.ts";
import { startSellerApis } from "../../src/demo-servers.ts";
import { MockChain } from "../../src/chain.ts";
import { paymentGate } from "../../src/seller.ts";
import { InMemoryUptoOperator, type Meter, type OfferExtraInput, type UptoOperator, type UptoPaymentEnvelope } from "../../src/seller-upto.ts";
import { getBase58Decoder } from "@solana/kit";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const line = (s = "") => process.stdout.write(s + "\n");
const rule = () => line("─".repeat(64));

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wallie-mcp-demo-"));
}

function randomAddr(): string {
  return getBase58Decoder().decode(new Uint8Array(crypto.randomBytes(32)));
}

/** A throwaway 64-byte Solana secret, JSON-array form. Never funded — the buy is offline. */
function solanaKeyJson(): string {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  const seed = pkcs8.subarray(pkcs8.length - 32);
  const spki = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer;
  const pub = spki.subarray(spki.length - 32);
  return JSON.stringify(Array.from(Buffer.concat([seed, pub])));
}

/** Connect an MCP client to a server governing `binding`, over a linked transport. */
async function connect(binding: McpBinding): Promise<{ client: Client; close(): Promise<void> }> {
  const server = await createMcpServer(binding);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "wallie-mcp-agent", version: "1" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client, close: async () => (await client.close(), await server.close()) };
}

interface ToolResult {
  content?: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

/** Call a tool and print its one-line summary; return the structured payload. */
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const label = Object.keys(args).length ? `${name}(${JSON.stringify(args)})` : `${name}()`;
  line(`  › ${label}`);
  const res = (await client.callTool({ name, arguments: args })) as ToolResult;
  for (const c of res.content ?? []) if (c.text) for (const ln of c.text.split("\n")) line(`    ${ln}`);
  return res.structuredContent ?? {};
}

// A Solana `upto` seller whose advertised `extra` pins a blockhash and slot, so
// the buyer builds its channel-open with zero RPC — the metered demo seller of
// docs/SOLANA-ARCHITECTURE.md §8, made fully offline.
function pinnedUptoSeller(perRowMicro: bigint, ceilingMicro: bigint) {
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
  return { base, operator, ceilingMicro, perRowMicro };
}

async function main(): Promise<void> {
  rule();
  line("  Wallie MCP example agent — one server, five tools, real MCP protocol");
  rule();

  // ---- Phase 1: an EVM practice agent buys an `exact` API, then hits a cap ----
  line("");
  line("Phase 1 — practice USDC on the mock rail (exact scheme)");
  line("");

  const dirA = tmpDir();
  const buyerA = createAgent(dirA);
  topUp(buyerA, 5); // $5 allowance
  // A per-call cap of $1 so the $5 enterprise feed trips the ceiling — the block.
  new PolicyStore(dirA, buyerA.agentName).save({ perCallMaxUsd: 1 });
  const sellers = await startSellerApis(new MockChain(path.join(dirA, "accounts.json")));

  const a = await connect({ runtime: buyerA });
  try {
    const { tools } = await a.client.listTools();
    line(`  tools/list → ${tools.map((t) => t.name).join(", ")}`);
    line("");

    await call(a.client, "get_budget");
    line("");
    line("  Buy weather data ($0.001) — an exact x402 call:");
    await call(a.client, "pay_fetch", { url: sellers.weatherUrl("Lisbon") });
    line("");
    line("  Try the enterprise feed ($5.00) — over the $1 per-call cap:");
    await call(a.client, "pay_fetch", { url: sellers.enterpriseFeedUrl("k") });
    line("");
    await call(a.client, "get_budget");
  } finally {
    await a.close();
    await Promise.all(sellers.servers.map((s) => s.close()));
  }

  // ---- Phase 2: a Solana agent buys an `upto` API and gets a refund ----
  line("");
  rule();
  line("");
  line("Phase 2 — Solana devnet, self-facilitated upto seller (metered, offline)");
  line("");

  const dirB = tmpDir();
  const seller = pinnedUptoSeller(1000n, 100000n); // $0.001/row, $0.10 ceiling
  const server = http.createServer(
    paymentGate(
      {
        priceMicro: seller.perRowMicro,
        description: "Metered rows (pay only for what you read)",
        payTo: randomAddr(),
        network: "solana-devnet",
        facilitator: new MockChain(),
        upto: { ceilingMicro: seller.ceilingMicro, operator: seller.operator },
      },
      (req, res, meter?: Meter) => {
        const rows = Math.max(0, Number(new URL(req.url ?? "/", "http://x").searchParams.get("rows") ?? "1") || 0);
        meter?.charge(seller.perRowMicro * BigInt(rows)); // clamped to the ceiling by the gate
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ rows }));
      },
    ),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;

  const buyerB = await createLiveAgent({
    stateDir: dirB,
    privateKey: solanaKeyJson(),
    network: "solana-devnet",
    rpcUrl: "http://127.0.0.1:1", // never reached — the open is zero-RPC
    checkOnChainBalance: false,
    preferScheme: "upto",
  });
  topUp(buyerB, 1); // $1 ceiling — the escrow deposit is $0.10

  const b = await connect({ runtime: buyerB, network: buyerB.network, rpcUrl: buyerB.rpcUrl });
  try {
    line("  Read 30 metered rows — ceiling $0.10, priced at $0.001/row:");
    const paid = await call(b.client, "pay_fetch", { url: `http://localhost:${port}/rows?rows=30` });
    const cost = paid.cost as { text: string } | undefined;
    const refund = paid.refund as { text: string } | undefined;
    line(`    → charged ${cost?.text ?? "?"}, refunded ${refund?.text ?? "?"} of the $0.10 deposit`);
    line("");
    await call(b.client, "list_channels");
    line("");
    line("  Escrow returns to the allowance once the channel settles:");
    await call(b.client, "get_budget");
  } finally {
    buyerB.stopHeartbeat?.();
    await b.close();
    await new Promise<void>((r) => server.close(() => r()));
  }

  line("");
  rule();
  line("  Done. The same server runs standalone over stdio:  npx wallie-mcp");
  rule();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
