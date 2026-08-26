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
  const [h, c, s] = fac.jwt("POST", "/v2/x402/verify").split(".");
  const header = b64json(h);
  const claims = b64json(c);
  assert.equal(header.alg, "ES256");
  assert.equal(header.kid, "test-key-id");
  assert.ok(typeof header.nonce === "string");
  assert.equal(claims.sub, "test-key-id");
  assert.equal(claims.uri, "POST api.cdp.coinbase.com/v2/x402/verify");
  assert.ok(Number(claims.exp) > Number(claims.nbf));
  const ok = crypto.verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  assert.ok(ok, "jwt signature must verify against public key");
});

type Captured = { auth?: string; body?: Record<string, unknown>; path?: string };

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
    if (action === "verify") await fac.verify({ scheme: "exact", payload: {} }, reqs);
    else await fac.settle({ scheme: "exact", payload: {} }, reqs);
    await fn(captured);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("verify posts x402 v1 contract shape with bearer jwt", async () => {
  await withCaptureServer("verify", { isValid: true, payer: "0xpayer" }, async (cap) => {
    assert.equal(cap.path, "/v2/x402/verify");
    assert.match(cap.auth ?? "", /^Bearer ey/);
    assert.equal(cap.body?.x402Version, 1);
    assert.deepEqual(cap.body?.paymentRequirements, reqs);
    assert.deepEqual(cap.body?.paymentPayload, { scheme: "exact", payload: {} });
  });
});

test("settle maps success/txHash/network and errorReason", async () => {
  await withCaptureServer("settle", { success: true, txHash: "0xtx", network: "base-sepolia" }, async (cap) => {
    assert.equal(cap.path, "/v2/x402/settle");
  });
  await withCaptureServer("settle", { success: false, errorReason: "insufficient_funds" }, async () => {});
});

test("missing credentials throw a helpful error", () => {
  delete process.env.CDP_API_KEY_ID;
  delete process.env.CDP_API_KEY_SECRET;
  assert.throws(() => new CdpFacilitator(), /CDP_API_KEY_ID/);
});
