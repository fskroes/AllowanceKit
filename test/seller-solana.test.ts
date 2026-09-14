import { test } from "node:test";
import assert from "node:assert/strict";
import { paymentGate } from "../src/seller.ts";
import type { Facilitator, FacilitatorKind } from "../src/chain.ts";
import type { AcceptsEntry, DecodedPayment } from "../src/types.ts";
import { NETWORKS } from "../src/live.ts";

const DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const DEVNET_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const FEE_PAYER = "FeePayer1111111111111111111111111111111111";
const SELLER = "SellerOwner11111111111111111111111111111111";

/** A facilitator that advertises a Solana `exact` kind and settles anything. */
class FakeSolanaFacilitator implements Facilitator {
  calls = { supported: 0, verify: 0, settle: 0 };
  lastVerified?: { payment: DecodedPayment; requirements: AcceptsEntry };
  async supported(): Promise<FacilitatorKind[]> {
    this.calls.supported++;
    return [{ x402Version: 2, scheme: "exact", network: DEVNET_CAIP2, extra: { feePayer: FEE_PAYER } }];
  }
  async verify(payment: DecodedPayment, requirements: AcceptsEntry) {
    this.calls.verify++;
    this.lastVerified = { payment, requirements };
    return { isValid: true, payer: "SoLPayer" };
  }
  async settle() {
    this.calls.settle++;
    return { success: true, txHash: "5xSolanaTxSig", network: DEVNET_CAIP2 };
  }
}

/** Minimal ServerResponse stand-in that records the last write. */
function fakeRes() {
  const rec: { status: number; headers: Record<string, string>; body?: string } = { status: 0, headers: {} };
  return {
    rec,
    res: {
      statusCode: 0,
      setHeader(k: string, v: string) { rec.headers[k] = v; },
      writeHead(status: number, headers?: Record<string, string>) { rec.status = status; Object.assign(rec.headers, headers ?? {}); return this; },
      end(body?: string) { rec.body = body; },
    } as never,
  };
}

test("Solana gate advertises a 402 with the mint asset, CAIP-2 network, feePayer from /supported, x402Version 2", async () => {
  const fac = new FakeSolanaFacilitator();
  const gate = paymentGate(
    { priceMicro: 10000n, description: "a metered call", payTo: SELLER, network: "solana-devnet", facilitator: fac },
    () => {},
  );
  const cap = fakeRes();
  await gate({ headers: { host: "seller.example" }, url: "/data" } as never, cap.res);

  assert.equal(cap.rec.status, 402);
  const body = JSON.parse(cap.rec.body!);
  assert.equal(body.x402Version, 2, "Solana advertises the v2 envelope");
  const offer = body.accepts[0] as AcceptsEntry;
  assert.equal(offer.scheme, "exact");
  assert.equal(offer.network, DEVNET_CAIP2, "network is the canonical CAIP-2 id, not the v1 alias");
  assert.equal(offer.asset, DEVNET_MINT, "asset is the devnet USDC mint");
  assert.equal(offer.payTo, SELLER);
  assert.equal(offer.maxAmountRequired, "10000");
  assert.deepEqual(offer.extra, { feePayer: FEE_PAYER }, "feePayer copied from the facilitator's /supported, no EIP-712 extra");
  assert.ok(fac.calls.supported >= 1, "gate read the facilitator's /supported");
});

test("Solana gate skips the local flat check and settles a mocked facilitator response", async () => {
  const fac = new FakeSolanaFacilitator();
  let handled = false;
  const gate = paymentGate(
    { priceMicro: 10000n, description: "d", payTo: SELLER, network: DEVNET_CAIP2, facilitator: fac },
    () => { handled = true; },
  );

  // A v2 Solana payment: amount and payee live inside the signed transaction,
  // so nothing is readable from the JSON — the gate must not reject it locally.
  const payload = { x402Version: 2, accepted: { scheme: "exact", network: DEVNET_CAIP2 }, payload: { transaction: "AQABase64Tx" } };
  const header = Buffer.from(JSON.stringify(payload)).toString("base64");

  const cap = fakeRes();
  await gate({ headers: { host: "seller.example", "x-payment": header }, url: "/data" } as never, cap.res);

  assert.equal(fac.calls.verify, 1, "verify was called (no local 400)");
  assert.equal(fac.calls.settle, 1, "settle was called");
  assert.equal(fac.lastVerified?.requirements.asset, DEVNET_MINT, "verify got the mint-asset offer");
  assert.ok(handled, "the protected handler ran after settlement");

  const resp = JSON.parse(Buffer.from(cap.rec.headers["X-PAYMENT-RESPONSE"], "base64").toString());
  assert.equal(resp.success, true);
  assert.equal(resp.txHash, "5xSolanaTxSig");
  assert.equal(resp.network, DEVNET_CAIP2);
  assert.equal(resp.amountMicro, "10000", "reports the advertised price for Solana");
});

test("v1 Base path is byte-identical and never reads /supported", async () => {
  // The exact 402 body the EVM gate emitted before SOL-02, pinned byte-for-byte.
  const info = NETWORKS["base-sepolia"];
  const expected = JSON.stringify(
    {
      x402Version: 1,
      error: "X-PAYMENT header is required",
      accepts: [{
        scheme: "exact",
        network: "base-sepolia",
        maxAmountRequired: "10000",
        resource: "http://seller.example/data",
        description: "d",
        mimeType: "application/json",
        payTo: "0x000000000000000000000000000000000000dEaD",
        asset: info.usdc,
        maxTimeoutSeconds: 30,
        extra: { name: info.domainName, version: info.domainVersion },
      }],
    },
    null,
    2,
  );

  let supportedCalled = 0;
  const fac = { supported: async () => { supportedCalled++; return []; } } as unknown as Facilitator;
  const gate = paymentGate(
    { priceMicro: 10000n, description: "d", payTo: "0x000000000000000000000000000000000000dEaD", network: "base-sepolia", facilitator: fac },
    () => {},
  );
  const cap = fakeRes();
  await gate({ headers: { host: "seller.example" }, url: "/data" } as never, cap.res);

  assert.equal(cap.rec.status, 402);
  assert.equal(cap.rec.body, expected, "EVM 402 body unchanged, byte-for-byte");
  assert.equal(supportedCalled, 0, "EVM path never calls the facilitator's /supported");
});
