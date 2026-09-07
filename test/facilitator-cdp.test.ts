import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { CdpFacilitator, derToRawEs256 } from "../src/facilitator-cdp.ts";
import type { AcceptsEntry } from "../src/types.ts";

const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const PEM = privateKey.export({ type: "sec1", format: "pem" }).toString();

const reqs: AcceptsEntry = {
  scheme: "exact",
  network: "base-sepolia",
  maxAmountRequired: "10000",
  resource: "https://api.example.com/data",
  description: "test",
  mimeType: "application/json",
  payTo: "0xabc0000000000000000000000000000000000abc",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  maxTimeoutSeconds: 30,
};

function b64json(seg: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(seg, "base64url").toString("utf8")) as Record<string, unknown>;
}

test("derToRawEs256 converts DER to 64-byte r||s", () => {
  const sig = crypto.sign("sha256", Buffer.from("payload"), privateKey);
  const raw = derToRawEs256(sig);
  assert.equal(raw.length, 64);
});

test("jwt is ES256-signed with CDP claims and verifiable with its public key", () => {
  const fac = new CdpFacilitator({ apiKeyId: "test-key-id", apiKeySecret: PEM, baseUrl: "https://api.cdp.coinbase.com" });
  const [h, c, s] = fac.jwt("POST", "/platform/v2/x402/verify").split(".");
  const header = b64json(h);
  const claims = b64json(c);
  assert.equal(header.alg, "ES256");
  assert.equal(header.kid, "test-key-id");
  assert.ok(typeof header.nonce === "string");
  assert.equal(claims.sub, "test-key-id");
  assert.equal(claims.uri, "POST api.cdp.coinbase.com/platform/v2/x402/verify");
  assert.ok(Number(claims.exp) > Number(claims.nbf));
  const ok = crypto.verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  assert.ok(ok, "jwt signature must verify against public key");
});

type Captured = { auth?: string; body?: Record<string, unknown>; path?: string; result?: any };

async function withCaptureServer(action: "verify" | "settle", respond: object, fn: (captured: Captured) => Promise<void>): Promise<void> {
  const captured: Captured = {};
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      captured.auth = req.headers.authorization;
      captured.path = req.url;
      captured.body = JSON.parse(body || "{}") as Record<string, unknown>;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(respond));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  try {
    const fac = new CdpFacilitator({
      apiKeyId: "kid",
      apiKeySecret: PEM,
      baseUrl: `http://127.0.0.1:${addr.port}`,
    });
    if (action === "verify") captured.result = await fac.verify({ scheme: "exact", payload: {} }, reqs);
    else captured.result = await fac.settle({ scheme: "exact", payload: {} }, reqs);
    await fn(captured);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("verify posts x402 v1 contract shape with bearer jwt", async () => {
  await withCaptureServer("verify", { isValid: true, payer: "0xpayer" }, async (cap) => {
    assert.equal(cap.path, "/platform/v2/x402/verify");
    assert.match(cap.auth ?? "", /^Bearer ey/);
    assert.equal(cap.body?.x402Version, 1);
    assert.deepEqual(cap.body?.paymentRequirements, reqs);
    assert.deepEqual(cap.body?.paymentPayload, { scheme: "exact", payload: {} });
  });
});

// x402-compat.md §6.5: the facilitator body is the same three keys in both
// versions; a CdpFacilitator constructed with x402Version:2 posts x402Version:2
// and passes the v2 nested paymentPayload through opaquely. Default stays 1 (the
// "verify posts x402 v1 contract shape" test above pins that), so v1 sellers are
// unaffected.
test("a v2 facilitator posts x402Version:2 and passes the nested paymentPayload through", async () => {
  const captured: { body?: Record<string, unknown> } = {};
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      captured.body = JSON.parse(body || "{}") as Record<string, unknown>;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ isValid: true, payer: "0xpayer" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  try {
    const fac = new CdpFacilitator({ apiKeyId: "kid", apiKeySecret: PEM, baseUrl: `http://127.0.0.1:${addr.port}`, x402Version: 2 });
    // A v2 nested PaymentPayload (spec §5.2.2), as the buyer would decode it.
    const v2Payload = { x402Version: 2, accepted: { scheme: "exact", network: "eip155:84532" }, payload: { signature: "0xsig", authorization: {} } };
    await fac.verify(v2Payload, { ...reqs, network: "eip155:84532", amount: "10000" });
    assert.equal(captured.body?.x402Version, 2, "posts the v2 protocol version");
    assert.deepEqual(captured.body?.paymentPayload, v2Payload, "passes the v2 nested payload through unchanged");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("settle maps success/txHash/network and errorReason", async () => {
  await withCaptureServer("settle", { success: true, txHash: "0xtx", network: "base-sepolia" }, async (cap) => {
    assert.equal(cap.path, "/platform/v2/x402/settle");
    assert.equal(cap.result.success, true);
    assert.equal(cap.result.txHash, "0xtx");
    assert.equal(cap.result.network, "base-sepolia");
  });
  await withCaptureServer("settle", { success: false, errorReason: "insufficient_funds" }, async (cap) => {
    assert.equal(cap.result.success, false);
    assert.equal(cap.result.error, "insufficient_funds");
  });
});

// Regression: the live CDP API returns the settled hash as "transaction", not
// "txHash". Reading the wrong field silently dropped the on-chain audit trail
// from every real payment while the mock-shaped tests stayed green.
test("settle reads the tx hash from CDP's \"transaction\" field", async () => {
  await withCaptureServer("settle", {
    success: true,
    transaction: "0x22ce5c2788286a760e135adcc3ff9b05e8cc5a968452e8d7c2fd614f74784f14",
    network: "base-sepolia",
    payer: "0xe48f38f38e88e6275a155f772508ee6953a4425B",
  }, async (cap) => {
    assert.equal(cap.result.txHash, "0x22ce5c2788286a760e135adcc3ff9b05e8cc5a968452e8d7c2fd614f74784f14");
  });
});

test("settle prefers \"transaction\" when a facilitator sends both", async () => {
  await withCaptureServer("settle", { success: true, transaction: "0xreal", txHash: "0xlegacy" }, async (cap) => {
    assert.equal(cap.result.txHash, "0xreal");
  });
});

test("missing credentials throw a helpful error", () => {
  delete process.env.CDP_API_KEY_ID;
  delete process.env.CDP_API_KEY_SECRET;
  assert.throws(() => new CdpFacilitator(), /CDP_API_KEY_ID/);
});
