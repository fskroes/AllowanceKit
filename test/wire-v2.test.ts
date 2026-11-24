import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { payingFetch, type PayContext } from "../src/payer.ts";
import { createLiveAgent, NETWORKS } from "../src/live.ts";
import type { AcceptsEntry } from "../src/types.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "allowance-v2-"));
}

const KEY = "0x" + "11".repeat(32);
const WALLET = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";

const USELESS_FACT_CHALLENGE = {
  x402Version: 2,
  accepts: [
    {
      scheme: "exact",
      network: "eip155:8453",
      amount: "1000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0xD7d49D6a12Ee3852f29A52A40908069bF4e48914",
      maxTimeoutSeconds: 300,
      extra: { name: "USD Coin", version: "2" },
    },
  ],
};

interface V2Seller {
  url: string;
  close(): Promise<void>;
  lastPayment(): Record<string, unknown> | undefined;
  lastPaymentHeaderName(): string | undefined;
}

async function listenV2(challenge: object, opts: { emptyBody?: boolean } = {}): Promise<V2Seller> {
  let lastPayment: Record<string, unknown> | undefined;
  let lastHeaderName: string | undefined;
  const server = http.createServer((req, res) => {
    const sig = req.headers["payment-signature"];
    const legacy = req.headers["x-payment"];
    if (typeof sig === "string" && sig) {
      lastHeaderName = "payment-signature";
      lastPayment = JSON.parse(Buffer.from(sig, "base64").toString("utf8")) as Record<string, unknown>;
      res.setHeader(
        "PAYMENT-RESPONSE",
        Buffer.from(JSON.stringify({ success: true, network: "eip155:8453", transaction: "0xv2feed" })).toString("base64"),
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ fact: "honey never spoils" }));
      return;
    }
    if (typeof legacy === "string" && legacy) lastHeaderName = "x-payment";
    res.setHeader("PAYMENT-REQUIRED", Buffer.from(JSON.stringify(challenge)).toString("base64"));
    res.writeHead(402, { "Content-Type": "application/json" });
    res.end(opts.emptyBody === false ? JSON.stringify(challenge) : "{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    lastPayment: () => lastPayment,
    lastPaymentHeaderName: () => lastHeaderName,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

function captureCtx(): { ctx: PayContext; authorized: bigint[]; settled: { micro: bigint; txHash: string }[] } {
  const authorized: bigint[] = [];
  const settled: { micro: bigint; txHash: string }[] = [];
  const ctx: PayContext = {
    agentName: "t",
    address: "0xbuyer",
    chain: { sign: () => "0xmocksig", balance: () => 1_000_000n },
    authorize: async (micro) => {
      if (micro > 0n) authorized.push(micro);
      return { allowed: true };
    },
    recordPayment: (_url, _host, micro, txHash) => {
      settled.push({ micro, txHash });
    },
    recordBlocked: () => {},
  };
  return { ctx, authorized, settled };
}

test("buyer parses a v2 402 with an empty body — challenge in the PAYMENT-REQUIRED header (§4c)", async () => {
  const seller = await listenV2(USELESS_FACT_CHALLENGE);
  const { ctx, authorized } = captureCtx();

  const paid = await payingFetch(ctx, `${seller.url}/api/useless-fact`);

  assert.notEqual(paid.error, "seller returned 402 with no acceptable payment methods");
  assert.deepEqual(authorized, [1000n], "buyer authorized against the v2 `amount` field");
  assert.equal(paid.quotedMicro, 1000n);

  const sent = seller.lastPayment();
  assert.equal((sent?.accepted as AcceptsEntry).network, "eip155:8453", "buyer echoed the CAIP-2 network");
  await seller.close();
});

test("buyer answers a v2 seller with x402Version:2, PAYMENT-SIGNATURE, nested {accepted,payload}, reads PAYMENT-RESPONSE", async () => {
  const seller = await listenV2(USELESS_FACT_CHALLENGE);
  const { ctx, settled } = captureCtx();

  const paid = await payingFetch(ctx, `${seller.url}/api/useless-fact`);

  assert.equal(seller.lastPaymentHeaderName(), "payment-signature");

  const sent = seller.lastPayment()!;
  assert.equal(sent.x402Version, 2);
  assert.ok(sent.accepted && typeof sent.accepted === "object", "carries the chosen requirements under `accepted`");
  assert.ok(sent.payload && typeof sent.payload === "object", "carries scheme-specific data under `payload`");
  assert.equal((sent.payload as { signature?: string }).signature, "0xmocksig");
  assert.equal(sent.scheme, undefined, "v2 puts scheme inside `accepted`, not at the top level");

  assert.equal(paid.ok, true, `payment failed: ${paid.error ?? ""}`);
  assert.equal(paid.txHash, "0xv2feed");
  assert.equal(paid.costMicro, 1000n);
  assert.deepEqual(settled, [{ micro: 1000n, txHash: "0xv2feed" }]);
  await seller.close();
});

test("buyer echoes the seller's chosen offer verbatim under `accepted` (no v1 normalization on the wire)", async () => {
  const seller = await listenV2(USELESS_FACT_CHALLENGE);
  const { ctx } = captureCtx();
  await payingFetch(ctx, `${seller.url}/api/useless-fact`);

  const sent = seller.lastPayment()!;
  assert.deepEqual(sent.accepted, USELESS_FACT_CHALLENGE.accepts[0], "accepted matches the seller's offer byte-for-byte");
  assert.equal((sent.accepted as AcceptsEntry).maxAmountRequired, undefined, "no synthesized v1 price field on the v2 wire");
  assert.equal((sent as Record<string, unknown>).resource, undefined, "no malformed top-level resource string");
  await seller.close();
});

test("a v2 seller that echoes the challenge in the body too is still parsed", async () => {
  const seller = await listenV2(USELESS_FACT_CHALLENGE, { emptyBody: false });
  const { ctx, authorized } = captureCtx();
  const paid = await payingFetch(ctx, `${seller.url}/api/useless-fact`);
  assert.equal(paid.ok, true, `payment failed: ${paid.error ?? ""}`);
  assert.deepEqual(authorized, [1000n]);
  await seller.close();
});

test("a live agent configured for base-sepolia signs for a seller quoting eip155:84532 (same chain, mapped)", async () => {
  const dir = tmpDir();
  const live = await createLiveAgent({ stateDir: dir, privateKey: KEY, network: "base-sepolia", checkOnChainBalance: false });

  const requirements: AcceptsEntry = {
    scheme: "exact",
    network: "eip155:84532",
    amount: "1000",
    resource: "https://api.example.com/x",
    payTo: WALLET,
    asset: NETWORKS["base-sepolia"].usdc,
    maxTimeoutSeconds: 300,
    extra: { name: NETWORKS["base-sepolia"].domainName, version: NETWORKS["base-sepolia"].domainVersion },
  };

  const b64 = await live.ctx.encodePayment!({
    x402Version: 2,
    scheme: "exact",
    network: "eip155:84532",
    resource: "https://api.example.com/x",
    from: live.address,
    payTo: WALLET,
    amount: "1000",
    nonce: "abc",
    timestamp: Date.now(),
    requirements,
  });

  const decoded = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  assert.equal(decoded.x402Version, 2, "answered in v2 because the seller quoted v2");
  assert.ok(decoded.accepted, "v2 nests the chosen requirements under `accepted`");
  assert.equal(decoded.accepted.network, "eip155:84532", "kept the seller's CAIP-2 network");
  assert.match(decoded.payload.signature, /^0x[0-9a-fA-F]+$/, "produced a real EIP-712 signature");
  assert.equal(decoded.payload.authorization.value, "1000");
});

test("a live agent for base-sepolia still refuses eip155:8453 (mainnet, a genuinely different chain)", async () => {
  const dir = tmpDir();
  const live = await createLiveAgent({ stateDir: dir, privateKey: KEY, network: "base-sepolia", checkOnChainBalance: false });

  await assert.rejects(
    () =>
      live.ctx.encodePayment!({
        x402Version: 2,
        scheme: "exact",
        network: "eip155:8453",
        resource: "https://api.example.com/x",
        from: live.address,
        payTo: WALLET,
        amount: "1000",
        nonce: "abc",
        timestamp: Date.now(),
        requirements: {
          scheme: "exact",
          network: "eip155:8453",
          amount: "1000",
          resource: "https://api.example.com/x",
          payTo: WALLET,
          asset: NETWORKS.base.usdc,
        },
      }),
    /configured for "base-sepolia"/,
    "a mainnet CAIP-2 quote to a testnet agent is refused before anything is signed",
  );
});
