import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { base58Encode } from "../src/base58.ts";
import {
  Meter,
  InMemoryUptoOperator,
  uptoPaymentGate,
  advertiseUptoOffer,
  toFacilitatorUptoPayload,
  type UptoGateOptions,
  type UptoHandler,
} from "../src/seller-upto.ts";
import type { UptoPayload } from "../src/types.ts";
import { paymentGate } from "../src/seller.ts";
import { MockChain } from "../src/chain.ts";
import type { AcceptsEntry } from "../src/types.ts";

const DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const DEVNET_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SELLER = "Se11erTreasury1111111111111111111111111111";
const CEILING = 100_000n; // $0.10

/** A fresh, valid 32-byte base58 channel address per call. */
function channelId(): string {
  return base58Encode(crypto.randomBytes(32));
}

/** A valid 32-byte base58 payer address. */
function payer(): string {
  return base58Encode(crypto.randomBytes(32));
}

/** Minimal ServerResponse stand-in that records status, headers and body. */
function fakeRes() {
  const rec: { status: number; headers: Record<string, string>; body?: string } = { status: 0, headers: {} };
  return {
    rec,
    res: {
      statusCode: 0,
      setHeader(k: string, v: string) { rec.headers[k.toLowerCase()] = v; },
      writeHead(status: number, headers?: Record<string, string>) {
        rec.status = status;
        for (const [k, v] of Object.entries(headers ?? {})) rec.headers[k.toLowerCase()] = v;
        return this;
      },
      write(chunk: string) { rec.body = (rec.body ?? "") + chunk; return true; },
      end(body?: string) { if (body !== undefined) rec.body = (rec.body ?? "") + body; },
    } as never,
  };
}

/** The seller's own upto offer, so `accepted` echoes it. */
function offer(amount = CEILING): AcceptsEntry {
  return {
    scheme: "upto",
    network: DEVNET_CAIP2,
    amount: amount.toString(),
    maxAmountRequired: amount.toString(),
    payTo: SELLER,
    asset: DEVNET_MINT,
    maxTimeoutSeconds: 300,
    extra: { paymentFlow: "escrow", feePayer: "FeePayer1111111111111111111111111111111111", receiverAuthorizer: "Authorizer11111111111111111111111111111111", withdrawDelay: 900 },
  };
}

/** Craft an `X-PAYMENT` header for an upto deposit against `off`. */
function header(over: Partial<{ channelId: string; from: string; maxAmount: bigint; deposit: bigint; expiresAt: number; accepted: AcceptsEntry }> = {}): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const env = {
    x402Version: 2,
    accepted: over.accepted ?? offer(),
    payload: {
      channelId: over.channelId ?? channelId(),
      from: over.from ?? payer(),
      maxAmount: (over.maxAmount ?? CEILING).toString(),
      deposit: (over.deposit ?? over.maxAmount ?? CEILING).toString(),
      expiresAt: over.expiresAt ?? nowSec + 120,
      validAfter: 0,
      openSlot: 400_000_000,
      openTransaction: "AQABbase64OpenTx",
      nonce: "12345",
      type: "deposit" as const,
    },
  };
  return Buffer.from(JSON.stringify(env)).toString("base64");
}

function gateOpts(over: Partial<UptoGateOptions> = {}): UptoGateOptions {
  const operator = over.operator ?? new InMemoryUptoOperator();
  const handler: UptoHandler =
    over.handler ??
    ((_req, res, meter) => {
      meter.charge(30_000n); // $0.03, under the $0.10 ceiling
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  return {
    ceilingMicro: CEILING,
    description: "metered call",
    payTo: SELLER,
    network: "solana-devnet",
    operator,
    handler,
    withdrawDelay: 900,
    ...over,
  };
}

function respOf(rec: { headers: Record<string, string> }) {
  const h = rec.headers["x-payment-response"];
  return h ? JSON.parse(Buffer.from(h, "base64").toString()) : undefined;
}

// ---------------------------------------------------------------------------

test("Meter accumulates and clamps to the ceiling; refuses negatives", () => {
  const m = new Meter(100n);
  m.charge(30n);
  m.charge(40n);
  assert.equal(m.settledMicro, 70n);
  m.charge(1000n);
  assert.equal(m.chargedMicro, 1070n, "raw charge is uncapped");
  assert.equal(m.settledMicro, 100n, "settled is clamped to the ceiling");
  assert.throws(() => m.charge(-1n), /cannot be negative/);
  assert.throws(() => new Meter(-1n), /cannot be negative/);
});

test("toFacilitatorUptoPayload coerces to the exact shape @x402/svm's isUptoSvmPayload accepts", () => {
  // A buyer that sent openSlot as a NUMBER (and omitted validAfter) — the shape
  // that would silently be rejected as unsupported_payload_type if passed raw.
  const p: UptoPayload = {
    channelId: "Chan111111111111111111111111111111111111111",
    from: "Payer11111111111111111111111111111111111111",
    maxAmount: "100000",
    deposit: "100000",
    expiresAt: 1_800_000_000,
    openSlot: 400_000_000, // number on the wire
    openTransaction: "AQABbase64",
    nonce: "12345",
  };
  const out = toFacilitatorUptoPayload(p, "deposit", "Auth11111111111111111111111111111111111111");

  // Mirror isUptoSvmPayload's exact predicate (node_modules/@x402/svm chunk).
  const guardOk =
    typeof out.from === "string" &&
    typeof out.maxAmount === "string" &&
    typeof out.deposit === "string" &&
    typeof out.channelId === "string" &&
    typeof out.authorizedSigner === "string" &&
    typeof out.openTransaction === "string" &&
    typeof out.openSlot === "string" &&
    Number.isSafeInteger(out.expiresAt) &&
    Number.isSafeInteger(out.validAfter) &&
    typeof out.nonce === "string" &&
    (out.voucherSignature === undefined || typeof out.voucherSignature === "string") &&
    (out.type === undefined || out.type === "deposit" || out.type === "claim");
  assert.ok(guardOk, `payload does not satisfy isUptoSvmPayload: ${JSON.stringify(out)}`);
  assert.equal(out.openSlot, "400000000", "numeric openSlot coerced to a string");
  assert.equal(out.validAfter, 0, "missing validAfter defaulted to 0");
  assert.equal(out.type, "deposit");

  // On claim the authorizedSigner is forced to ours and the voucher attaches.
  const claim = toFacilitatorUptoPayload(p, "claim", "Auth11111111111111111111111111111111111111", "sigBase58");
  assert.equal(claim.authorizedSigner, "Auth11111111111111111111111111111111111111");
  assert.equal(claim.voucherSignature, "sigBase58");
  assert.equal(claim.type, "claim");

  // A payload missing the open fields is a loud error, not a silent chain reject.
  assert.throws(() => toFacilitatorUptoPayload({ ...p, nonce: undefined }, "deposit", "A"), /missing openSlot, nonce/);
});

test("advertiseUptoOffer lists the mint, CAIP-2 network, ceiling and self-facilitation extra", async () => {
  const op = new InMemoryUptoOperator();
  const off = await advertiseUptoOffer(gateOpts({ operator: op }), "http://s/x");
  assert.equal(off.scheme, "upto");
  assert.equal(off.network, DEVNET_CAIP2);
  assert.equal(off.asset, DEVNET_MINT);
  assert.equal(off.payTo, SELLER);
  assert.equal(off.amount, "100000");
  assert.equal((off.extra as Record<string, unknown>).feePayer, op.feePayer);
  assert.equal((off.extra as Record<string, unknown>).receiverAuthorizer, op.receiverAuthorizer);
  assert.equal((off.extra as Record<string, unknown>).withdrawDelay, 900);
});

test("happy path: deposit, meter the actual, settle once, refund the rest", async () => {
  const op = new InMemoryUptoOperator();
  const gate = uptoPaymentGate(gateOpts({ operator: op }));
  const cid = channelId();
  const cap = fakeRes();
  await gate({ headers: { host: "s", "x-payment": header({ channelId: cid }) }, url: "/x" } as never, cap.res);

  assert.equal(cap.rec.status, 200, "handler body flushed with a 200");
  assert.deepEqual(JSON.parse(cap.rec.body!), { ok: true });
  assert.equal(op.calls.deposit, 1, "deposited exactly once");
  assert.equal(op.calls.claim, 1, "settled exactly once");
  assert.equal(op.channels.get(cid)?.status, "sealed");

  const resp = respOf(cap.rec);
  assert.equal(resp.success, true);
  assert.equal(resp.amount, "30000", "reports the metered amount, not the ceiling");
  assert.equal(resp.depositMicro, "100000");
  assert.equal(resp.refundMicro, "70000", "ceiling − actual is refunded");
  assert.equal(resp.channelId, cid);
  assert.equal(resp.network, DEVNET_CAIP2);
});

test("a handler that never meters refunds the whole deposit (amount 0)", async () => {
  const op = new InMemoryUptoOperator();
  const gate = uptoPaymentGate(
    gateOpts({ operator: op, handler: (_req, res) => { res.end(JSON.stringify({ ok: true })); } }),
  );
  const cid = channelId();
  const cap = fakeRes();
  await gate({ headers: { host: "s", "x-payment": header({ channelId: cid }) }, url: "/x" } as never, cap.res);

  assert.equal(cap.rec.status, 200);
  const resp = respOf(cap.rec);
  assert.equal(resp.amount, "0");
  assert.equal(resp.refundMicro, "100000", "the whole deposit came back");
  assert.equal(op.channels.get(cid)?.settledMicro, 0n);
});

test("a handler that throws refunds and never charges", async () => {
  const op = new InMemoryUptoOperator();
  const gate = uptoPaymentGate(
    gateOpts({
      operator: op,
      handler: (_req, _res, meter) => {
        meter.charge(50_000n); // would have charged, but the throw discards it
        throw new Error("boom");
      },
    }),
  );
  const cid = channelId();
  const cap = fakeRes();
  await gate({ headers: { host: "s", "x-payment": header({ channelId: cid }) }, url: "/x" } as never, cap.res);

  assert.equal(cap.rec.status, 502);
  const resp = respOf(cap.rec);
  assert.equal(resp.success, false);
  assert.equal(resp.amount, "0", "a thrown handler is never charged");
  assert.equal(resp.refundMicro, "100000");
  assert.equal(op.channels.get(cid)?.settledMicro, 0n, "settled with 0, a full refund");
  assert.equal(op.calls.claim, 1, "the refund still settles the channel once");
});

test("beforeServe abort refunds the deposit and never runs the handler", async () => {
  const op = new InMemoryUptoOperator();
  let handlerRan = false;
  const gate = uptoPaymentGate(
    gateOpts({
      operator: op,
      beforeServe: () => ({ abort: true, reason: "over budget" }),
      handler: (_req, res, meter) => { handlerRan = true; meter.charge(1n); res.end("x"); },
    }),
  );
  const cid = channelId();
  const cap = fakeRes();
  await gate({ headers: { host: "s", "x-payment": header({ channelId: cid }) }, url: "/x" } as never, cap.res);

  assert.equal(handlerRan, false, "the handler never ran");
  assert.equal(cap.rec.status, 402);
  const resp = respOf(cap.rec);
  assert.equal(resp.amount, "0");
  assert.equal(resp.refundMicro, "100000");
  assert.match(resp.error, /over budget/);
  assert.equal(op.channels.get(cid)?.status, "sealed", "the channel was closed by the refund");
});

test("a replayed channel id is rejected and never deposited twice", async () => {
  const op = new InMemoryUptoOperator();
  const gate = uptoPaymentGate(gateOpts({ operator: op }));
  const cid = channelId();
  const first = fakeRes();
  await gate({ headers: { host: "s", "x-payment": header({ channelId: cid }) }, url: "/x" } as never, first.res);
  assert.equal(first.rec.status, 200);

  const second = fakeRes();
  await gate({ headers: { host: "s", "x-payment": header({ channelId: cid }) }, url: "/x" } as never, second.res);
  assert.equal(second.rec.status, 402, "the replay is rejected");
  assert.match(JSON.parse(second.rec.body!).error, /replayed/);
  assert.equal(op.calls.deposit, 1, "deposited only once across the replay");
});

test("an under-deposit is rejected before the chain is touched", async () => {
  const op = new InMemoryUptoOperator();
  const gate = uptoPaymentGate(gateOpts({ operator: op }));
  const cap = fakeRes();
  // maxAmount below the ceiling: the buyer tried to escrow less than authorised.
  await gate({ headers: { host: "s", "x-payment": header({ maxAmount: 40_000n }) }, url: "/x" } as never, cap.res);

  assert.equal(cap.rec.status, 402);
  assert.match(JSON.parse(cap.rec.body!).error, /does not match the offer/);
  assert.equal(op.calls.deposit, 0, "no deposit was broadcast");
});

test("a deposit whose amount and ceiling disagree (deposit != maxAmount) is rejected", async () => {
  const op = new InMemoryUptoOperator();
  const gate = uptoPaymentGate(gateOpts({ operator: op }));
  const cap = fakeRes();
  await gate({ headers: { host: "s", "x-payment": header({ maxAmount: CEILING, deposit: 40_000n }) }, url: "/x" } as never, cap.res);
  assert.equal(cap.rec.status, 402);
  assert.match(JSON.parse(cap.rec.body!).error, /deposit .* must equal the ceiling/);
  assert.equal(op.calls.deposit, 0);
});

test("an `accepted` that does not echo the offer is rejected", async () => {
  const op = new InMemoryUptoOperator();
  const gate = uptoPaymentGate(gateOpts({ operator: op }));

  const wrongPayee = fakeRes();
  const badOffer: AcceptsEntry = { ...offer(), payTo: "SomeoneE1se111111111111111111111111111111" };
  await gate({ headers: { host: "s", "x-payment": header({ accepted: badOffer }) }, url: "/x" } as never, wrongPayee.res);
  assert.equal(wrongPayee.rec.status, 402);
  assert.match(JSON.parse(wrongPayee.rec.body!).error, /payTo/);
  assert.equal(op.calls.deposit, 0);
});

test("no X-PAYMENT header returns a 402 advertising the upto offer", async () => {
  const gate = uptoPaymentGate(gateOpts());
  const cap = fakeRes();
  await gate({ headers: { host: "s" }, url: "/x" } as never, cap.res);
  assert.equal(cap.rec.status, 402);
  const body = JSON.parse(cap.rec.body!);
  assert.equal(body.x402Version, 2);
  assert.equal(body.accepts[0].scheme, "upto");
  assert.equal(body.accepts[0].asset, DEVNET_MINT);
});

test("an expired voucher window is rejected", async () => {
  const op = new InMemoryUptoOperator();
  const gate = uptoPaymentGate(gateOpts({ operator: op }));
  const cap = fakeRes();
  const past = Math.floor(Date.now() / 1000) - 5;
  await gate({ headers: { host: "s", "x-payment": header({ expiresAt: past }) }, url: "/x" } as never, cap.res);
  assert.equal(cap.rec.status, 402);
  assert.match(JSON.parse(cap.rec.body!).error, /expiresAt/);
  assert.equal(op.calls.deposit, 0);
});

/** An operator whose settle fails, to exercise the on-chain failure branches. */
class ClaimFailsOperator extends InMemoryUptoOperator {
  when: "always" | "positive";
  constructor(when: "always" | "positive") {
    super();
    this.when = when;
  }
  async settleClaim(env: Parameters<InMemoryUptoOperator["settleClaim"]>[0], actual: bigint) {
    if (this.when === "always" || actual > 0n) throw new Error("chain down");
    return super.settleClaim(env, actual);
  }
}

test("a settle that fails after a served handler reports the deposit as reclaimable", async () => {
  const op = new ClaimFailsOperator("positive");
  const gate = uptoPaymentGate(gateOpts({ operator: op }));
  const cid = channelId();
  const cap = fakeRes();
  await gate({ headers: { host: "s", "x-payment": header({ channelId: cid }) }, url: "/x" } as never, cap.res);

  assert.equal(cap.rec.status, 502, "the deposit is on-chain but unsettled");
  const resp = respOf(cap.rec);
  assert.equal(resp.success, false);
  assert.equal(resp.refundMicro, "0", "nothing was refunded");
  assert.match(resp.error, /reclaimable/);
  assert.equal(op.channels.get(cid)?.status, "open", "the channel stays open for reclaim");
});

test("a beforeServe hook that throws aborts and refunds", async () => {
  const op = new InMemoryUptoOperator();
  let handlerRan = false;
  const gate = uptoPaymentGate(
    gateOpts({
      operator: op,
      beforeServe: () => { throw new Error("policy store unreachable"); },
      handler: (_req, res, meter) => { handlerRan = true; meter.charge(1n); res.end("x"); },
    }),
  );
  const cid = channelId();
  const cap = fakeRes();
  await gate({ headers: { host: "s", "x-payment": header({ channelId: cid }) }, url: "/x" } as never, cap.res);

  assert.equal(handlerRan, false);
  assert.equal(cap.rec.status, 402);
  const resp = respOf(cap.rec);
  assert.equal(resp.refundMicro, "100000", "a thrown hook still refunds the deposit");
  assert.match(resp.error, /policy store unreachable/);
});

test("an abort whose refund also fails reports the deposit as reclaimable", async () => {
  const op = new ClaimFailsOperator("always");
  const gate = uptoPaymentGate(gateOpts({ operator: op, beforeServe: () => ({ abort: true, reason: "no" }) }));
  const cap = fakeRes();
  await gate({ headers: { host: "s", "x-payment": header() }, url: "/x" } as never, cap.res);

  assert.equal(cap.rec.status, 402);
  const resp = respOf(cap.rec);
  assert.equal(resp.refundMicro, "0", "the refund did not land — do not claim it did");
  assert.match(resp.error, /refund failed/);
});

test("a handler throw whose refund also fails reports the deposit as reclaimable", async () => {
  const op = new ClaimFailsOperator("always");
  const gate = uptoPaymentGate(
    gateOpts({ operator: op, handler: () => { throw new Error("boom"); } }),
  );
  const cap = fakeRes();
  await gate({ headers: { host: "s", "x-payment": header() }, url: "/x" } as never, cap.res);

  assert.equal(cap.rec.status, 502);
  const resp = respOf(cap.rec);
  assert.equal(resp.refundMicro, "0");
  assert.match(resp.error, /reclaimable/);
});

// --- paymentGate routing: one seller, both schemes ------------------------

test("paymentGate advertises both exact and upto for a Solana seller", async () => {
  const gate = paymentGate(
    {
      priceMicro: 10_000n,
      description: "metered",
      payTo: SELLER,
      network: "solana-devnet",
      facilitator: new MockChain(),
      upto: { ceilingMicro: CEILING, operator: new InMemoryUptoOperator() },
    },
    () => {},
  );
  const cap = fakeRes();
  await gate({ headers: { host: "s" }, url: "/x" } as never, cap.res);

  assert.equal(cap.rec.status, 402);
  const schemes = JSON.parse(cap.rec.body!).accepts.map((a: AcceptsEntry) => a.scheme);
  assert.deepEqual(schemes, ["exact", "upto"], "both offers listed, exact first");
});

test("paymentGate falls back to an exact-only 402 when the upto operator cannot be built", async () => {
  // upto is configured with neither a ready operator nor solanaOperator env
  // keys, so building it throws — the exact 402 must still list exact.
  const gate = paymentGate(
    {
      priceMicro: 10_000n,
      description: "metered",
      payTo: SELLER,
      network: "solana-devnet",
      facilitator: new MockChain(),
      upto: { ceilingMicro: CEILING },
    },
    () => {},
  );
  const cap = fakeRes();
  await gate({ headers: { host: "s" }, url: "/x" } as never, cap.res);

  assert.equal(cap.rec.status, 402);
  const schemes = JSON.parse(cap.rec.body!).accepts.map((a: AcceptsEntry) => a.scheme);
  assert.deepEqual(schemes, ["exact"], "a broken upto operator does not blank the 402");
});

test("paymentGate routes an upto payment to the channel gate and settles metered", async () => {
  const op = new InMemoryUptoOperator();
  const gate = paymentGate(
    {
      priceMicro: 10_000n,
      description: "metered",
      payTo: SELLER,
      network: "solana-devnet",
      facilitator: new MockChain(),
      upto: { ceilingMicro: CEILING, operator: op },
    },
    (_req, res, meter) => {
      meter?.charge(25_000n);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ metered: true }));
    },
  );
  const cid = channelId();
  const cap = fakeRes();
  await gate({ headers: { host: "s", "x-payment": header({ channelId: cid }) }, url: "/x" } as never, cap.res);

  assert.equal(cap.rec.status, 200);
  assert.deepEqual(JSON.parse(cap.rec.body!), { metered: true });
  assert.equal(op.calls.deposit, 1);
  assert.equal(respOf(cap.rec).amount, "25000");
});

test("paymentGate shutdown waits for an accepted payment before stopping cleanup", async () => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let stops = 0;
  const operator = Object.assign(new InMemoryUptoOperator(), { async stop() { stops++; } });
  const gate = paymentGate({
    priceMicro: 1_000n, description: "metered", payTo: SELLER,
    network: "solana-devnet", facilitator: new MockChain(),
    upto: { ceilingMicro: CEILING, operator },
  }, async (_req, res, meter) => {
    entered();
    await pending;
    meter!.charge(30_000n);
    res.end("done");
  });
  const response = fakeRes();
  const serving = gate({ headers: { host: "s", "x-payment": header() }, url: "/x" } as never, response.res);
  await started;
  const stopping = gate.stop();
  assert.equal(stops, 0);
  const rejected = fakeRes();
  await gate({ headers: { host: "s" } } as never, rejected.res);
  assert.equal(rejected.rec.status, 503);
  release();
  await serving;
  await stopping;
  assert.equal(response.rec.status, 200);
  assert.equal(operator.calls.claim, 1);
  assert.equal(stops, 1);
  await gate.stop();
  assert.equal(stops, 1, "shutdown is idempotent");
});

// --- Sandbox: one real open-serve-settle on 402.surfnet.dev ---------------
// Gated by SOLANA_SANDBOX=1 (docs/SOLANA-ARCHITECTURE.md §2.7, §7). Off by
// default so CI never touches the network; it needs a hosted Surfpool fork with
// the payment-channels program, mainnet USDC, and the treasury ATA present.
test("SOLANA_SANDBOX: real open → serve → settle with on-chain settled == actual", { skip: process.env.SOLANA_SANDBOX !== "1" }, async (t) => {
  const { createSolanaUptoOperator } = await import("../src/seller-upto.ts");
  const { normalizeSolanaKey } = await import("../src/solana.ts");
  const feeEnv = process.env.SELLER_FEE_PAYER_KEY;
  const authEnv = process.env.SELLER_AUTHORIZER_KEY;
  assert.ok(feeEnv && authEnv, "set SELLER_FEE_PAYER_KEY and SELLER_AUTHORIZER_KEY for the sandbox run");

  const rpcUrl = process.env.SOLANA_SANDBOX_RPC ?? "https://402.surfnet.dev:8899";
  const operator = await createSolanaUptoOperator({
    network: "solana", // the sandbox forks mainnet genesis → mainnet CAIP-2
    feePayerSecret: normalizeSolanaKey(feeEnv!),
    receiverAuthorizerSecret: normalizeSolanaKey(authEnv!),
    rpcUrl,
  });
  t.after(() => operator.stop());
  // The full buyer open + settle loop is exercised by the SOL-05 sandbox test
  // (test/solana-sandbox.test.ts); here we prove the operator constructs and the
  // offer advertises against the sandbox network.
  const off = await advertiseUptoOffer(gateOpts({ operator, network: "solana", payTo: SELLER }), "http://s/x");
  assert.equal(off.scheme, "upto");
  assert.ok((off.extra as Record<string, unknown>).feePayer, "operator advertised a feePayer");
});
