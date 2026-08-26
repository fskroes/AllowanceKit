import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { paymentGate } from "../src/seller.ts";
import { MockChain } from "../src/chain.ts";
import { payingFetch, type PayContext } from "../src/payer.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "allowance-test-"));
}

async function listen(gate: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>): Promise<{ url: string; close(): Promise<void>; lastHeader(): string }> {
  let lastHeader = "";
  const server = http.createServer((req, res) => {
    lastHeader = String(req.headers["x-payment"] ?? "");
    void gate(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    lastHeader: () => lastHeader,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

const PRICE = 25000n; // $0.025 — micro == USDC atomic units

function mockCtx(dir: string, chain?: MockChain): { ctx: PayContext; address: string } {
  const c = chain ?? new MockChain(path.join(dir, "accounts.json"));
  const { address } = c.createAccount();
  c.faucet(address, 1_000_000n);
  const ctx: PayContext = {
    agentName: "t",
    address,
    chain: c,
    encodePayment: async (u) =>
      Buffer.from(JSON.stringify({ ...u, signature: c.sign(address, u) })).toString("base64"),
    authorize: async () => ({ allowed: true }),
    recordPayment: () => {},
    recordBlocked: () => {},
  };
  return { ctx, address };
}

test("mock facilitator settles the flat wire shape end-to-end via payingFetch", async () => {
  const dir = tmpDir();
  const chain = new MockChain(path.join(dir, "accounts.json")); // shared by buyer accounting + seller settlement
  const { ctx } = mockCtx(dir, chain);
  const api = await listen(
    paymentGate({ priceMicro: PRICE, description: "t", payTo: "0xseller", facilitator: chain }, (_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    }),
  );

  // bare fetch sees the 402 challenge
  const bare = await fetch(`${api.url}/data`);
  assert.equal(bare.status, 402);
  const challenge = (await bare.json()) as { accepts?: unknown[] };
  assert.equal(challenge.accepts?.length, 1);

  // payingFetch handles the whole protocol in one shot: challenge → policy → sign → settle
  const paid = await payingFetch(ctx, `${api.url}/data`);
  assert.equal(paid.ok, true, `payment failed: ${paid.blockedBy?.rule ?? ""} ${paid.error ?? ""}`);
  assert.equal(paid.costMicro, PRICE);
  assert.ok(paid.txHash?.startsWith("0x"));
  assert.equal(chain.balance("0xseller"), PRICE);

  const decoded = JSON.parse(Buffer.from(api.lastHeader(), "base64").toString("utf8")) as Record<string, unknown>;
  assert.equal(decoded.scheme, "exact");
  assert.equal(typeof decoded.signature, "string");
  await api.close();
});

test("gate rejects underpriced/foreign-payee payloads before touching the facilitator", async () => {
  let verifyCalls = 0;
  const countingFacilitator = {
    verify: async () => {
      verifyCalls++;
      return { isValid: true, payer: "0xp" };
    },
    settle: async () => ({ success: true, txHash: "0xt", network: "mock-ledger" }),
  };
  const api = await listen(
    paymentGate({ priceMicro: PRICE, description: "t", payTo: "0xseller", facilitator: countingFacilitator }, () => {}),
  );

  const wrongPrice = Buffer.from(JSON.stringify({ amount: "1", payTo: "0xseller" })).toString("base64");
  const res1 = await fetch(`${api.url}/data`, { headers: { "X-PAYMENT": wrongPrice } });
  assert.equal(res1.status, 400);

  const rightShapeWrongPayee = Buffer.from(JSON.stringify({ amount: PRICE.toString(), payTo: "0xother" })).toString("base64");
  const res2 = await fetch(`${api.url}/data`, { headers: { "X-PAYMENT": rightShapeWrongPayee } });
  assert.equal(res2.status, 400);
  assert.equal(verifyCalls, 0);
  await api.close();
});

test("nested x402 v1 EVM shape passes the gate's sanity checks", async () => {
  let seenPayload: Record<string, unknown> | undefined;
  let seenReqs: Record<string, unknown> | undefined;
  const spyFacilitator = {
    verify: async (p: Record<string, unknown>, r: Record<string, unknown>) => {
      seenPayload = p;
      seenReqs = r;
      return { isValid: true, payer: "0xbuyer" };
    },
    settle: async () => ({ success: true, txHash: "0xdeadbeef", network: "base-sepolia" }),
  };
  const api = await listen(
    paymentGate(
      { priceMicro: PRICE, description: "d", payTo: "0xseller", facilitator: spyFacilitator, network: "base-sepolia" },
      (_req, res) => {
        res.end(JSON.stringify({ ok: true }));
      },
    ),
  );
  const nested = {
    x402Version: 1,
    scheme: "exact",
    network: "base-sepolia",
    resource: { url: `${api.url}/data`, description: "d", mimeType: "application/json" },
    payload: {
      signature: `0x${crypto.randomBytes(65).toString("hex")}`,
      authorization: { from: "0xbuyer", to: "0xseller", value: PRICE.toString(), validAfter: "0", validBefore: "9", nonce: `0x${crypto.randomBytes(32).toString("hex")}` },
    },
  };
  const res = await fetch(`${api.url}/data`, { headers: { "X-PAYMENT": Buffer.from(JSON.stringify(nested)).toString("base64") } });
  assert.equal(res.status, 200);
  assert.equal(seenPayload?.scheme, "exact");
  assert.equal(seenReqs?.network, "base-sepolia");
  const receipt = JSON.parse(Buffer.from(res.headers.get("x-payment-response") ?? "", "base64").toString("utf8")) as { amountMicro?: string };
  assert.equal(receipt.amountMicro, PRICE.toString());
  await api.close();
});

test("payingFetch surfaces policy blocks pre-flight without any network call", async () => {
  const blocked: PayContext = {
    agentName: "t",
    address: "0xa",
    chain: { sign: () => "", balance: () => 0n },
    authorize: async () => ({ allowed: false, rule: "kill_switch", detail: "paused" }),
    recordPayment: () => {},
    recordBlocked: () => {},
  };
  const r = await payingFetch(blocked, "http://localhost/x");
  assert.equal(r.ok, false);
  assert.equal(r.blockedBy?.rule, "kill_switch");
  assert.equal(r.status, 0);
});
