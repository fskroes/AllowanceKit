import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLiveAgent } from "../src/live.ts";
import { topUp } from "../src/wallet.ts";
import { payingFetch } from "../src/payer.ts";
import { paymentGate } from "../src/seller.ts";
import { MockChain } from "../src/chain.ts";
import {
  InMemoryUptoOperator,
  type OfferExtraInput,
  type UptoOperator,
  type UptoPaymentEnvelope,
} from "../src/seller-upto.ts";
import { ChannelStore } from "../src/channels.ts";
import { Ledger, type LedgerEvent } from "../src/ledger.ts";
import { getBase58Decoder } from "@solana/kit";

/**
 * The buyer `upto` flow end-to-end, fully offline (docs/SOLANA-ARCHITECTURE.md
 * §4.3, SOL-05). A real {@link createLiveAgent} on `solana-devnet` pays a real
 * {@link paymentGate} seller running an {@link InMemoryUptoOperator} (no chain,
 * no keys). The only thing that would touch the network — the buyer's `open`
 * transaction build — is made zero-RPC by pinning the blockhash and slot in the
 * seller's offer `extra`, so the whole loop runs in-process.
 *
 * SOL-05 done-when: ceiling $0.10, actual $0.03 → the ledger row reads
 * `amountMicro 30000, depositMicro 100000, refundMicro 70000`, and the channel
 * row settles. The on-chain "wallet lost exactly $0.03" and the reclaim path are
 * the gated sandbox test (`test/solana-sandbox.test.ts`).
 */

const PER_ROW_MICRO = 1000n; // $0.001 per row
const CEILING_MICRO = 100000n; // $0.10

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "allowance-upto-"));
}

/** A real 32-byte base58 address — the buyer's `open` build validates every one. */
function randomAddr(): string {
  return getBase58Decoder().decode(new Uint8Array(crypto.randomBytes(32)));
}

/** A throwaway 64-byte Solana secret as the JSON-array form `solana-keygen` writes. */
function keyJson(): string {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  const seed = pkcs8.subarray(pkcs8.length - 32);
  const spki = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer;
  const pub = spki.subarray(spki.length - 32);
  return JSON.stringify(Array.from(Buffer.concat([seed, pub])));
}

/**
 * Wrap an {@link InMemoryUptoOperator} so its advertised `extra` pins a
 * blockhash and slot — that is what lets the buyer build the `open` with zero
 * RPC. `overrides` lets a test force the claim to throw (the orphan path).
 */
function operatorWithPinnedBlockhash(overrides: Partial<UptoOperator> = {}): {
  operator: UptoOperator;
  base: InMemoryUptoOperator;
} {
  const base = new InMemoryUptoOperator({ feePayer: randomAddr(), receiverAuthorizer: randomAddr() });
  const blockhash = randomAddr();
  const operator: UptoOperator = {
    offerExtra: async (i: OfferExtraInput) => ({
      ...(await base.offerExtra(i)),
      recentBlockhash: blockhash,
      recentSlot: 200_000_000,
      lastValidBlockHeight: 200_000_150,
    }),
    openDeposit: overrides.openDeposit ?? ((e: UptoPaymentEnvelope) => base.openDeposit(e)),
    settleClaim: overrides.settleClaim ?? ((e: UptoPaymentEnvelope, a: bigint) => base.settleClaim(e, a)),
  };
  return { operator, base };
}

async function startSeller(
  operator: UptoOperator,
  opts: { beforeServe?: import("../src/seller-upto.ts").UptoGateOptions["beforeServe"] } = {},
): Promise<{ url: (rows: number) => string; close(): Promise<void> }> {
  const handler = (req: http.IncomingMessage, res: http.ServerResponse, meter?: import("../src/seller-upto.ts").Meter): void => {
    const rows = Math.max(0, Number(new URL(req.url ?? "/", "http://x").searchParams.get("rows") ?? "1") || 0);
    meter?.charge(PER_ROW_MICRO * BigInt(rows)); // clamped to the ceiling by the gate
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ rows }));
  };
  const server = http.createServer(
    paymentGate(
      {
        priceMicro: PER_ROW_MICRO,
        description: "Metered rows",
        payTo: randomAddr(),
        network: "solana-devnet",
        facilitator: new MockChain(),
        upto: { ceilingMicro: CEILING_MICRO, operator, beforeServe: opts.beforeServe },
      },
      handler,
    ),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as { port: number };
  return {
    url: (rows) => `http://localhost:${port}/rows?rows=${rows}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function buyer(dir: string): Promise<import("../src/live.ts").LiveAgentRuntime> {
  const live = await createLiveAgent({
    stateDir: dir,
    privateKey: keyJson(),
    network: "solana-devnet",
    rpcUrl: "http://127.0.0.1:1", // never reached — the encode is zero-RPC
    checkOnChainBalance: false,
    preferScheme: "upto",
  });
  topUp(live, 1); // $1 ceiling, well above one $0.10 channel
  return live;
}

function paymentRows(dir: string): Extract<LedgerEvent, { t: "payment" }>[] {
  return new Ledger(dir).read().filter((e): e is Extract<LedgerEvent, { t: "payment" }> => e.t === "payment");
}

test("upto buyer: metered charge below the ceiling settles the channel and refunds the rest", async () => {
  const dir = tmpDir();
  const { operator, base } = operatorWithPinnedBlockhash();
  const seller = await startSeller(operator);
  const live = await buyer(dir);
  try {
    const res = await payingFetch(live.ctx, seller.url(30)); // 30 rows × $0.001 = $0.03

    assert.equal(res.ok, true, res.error ?? "expected a 200");
    assert.equal(res.costMicro, 30000n, "actual charge is 30 rows");
    assert.equal(res.quotedMicro, CEILING_MICRO, "quoted is the ceiling");
    assert.equal(res.refundMicro, 70000n, "the rest of the deposit refunds");
    assert.ok(res.channelId, "the channel id is reported");

    // The seller opened and sealed exactly one channel at the metered amount.
    assert.equal(base.calls.deposit, 1);
    assert.equal(base.calls.claim, 1);
    const ch = base.channels.get(res.channelId!);
    assert.equal(ch?.settledMicro, 30000n, "on the seller side the channel settled at the actual");

    // The buyer's ledger row: actual in `amountMicro`, escrow annotated.
    const rows = paymentRows(dir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].amountMicro, "30000");
    assert.equal(rows[0].scheme, "upto");
    assert.equal(rows[0].depositMicro, "100000");
    assert.equal(rows[0].refundMicro, "70000");
    assert.equal(rows[0].channelId, res.channelId);

    // The buyer's channel store row resolved to `settled`, escrow back to zero.
    const store = new ChannelStore(dir);
    const rec = store.get(res.channelId!);
    assert.equal(rec?.status, "settled");
    assert.equal(rec?.settledMicro, "30000");
    assert.equal(rec?.refundMicro, "70000");
    assert.equal(store.escrowedMicro(live.agentName), 0n, "a settled channel escrows nothing");
  } finally {
    live.stopHeartbeat?.();
    await seller.close();
  }
});

test("upto buyer: a seller that refuses (policy abort) refunds the whole deposit and records a zero payment", async () => {
  const dir = tmpDir();
  const { operator } = operatorWithPinnedBlockhash();
  const seller = await startSeller(operator, { beforeServe: () => ({ abort: true, reason: "seller policy" }) });
  const live = await buyer(dir);
  try {
    const res = await payingFetch(live.ctx, seller.url(30));

    assert.equal(res.ok, false, "an abort is not a success");
    assert.equal(res.costMicro, 0n, "nothing was spent");
    assert.equal(res.refundMicro, CEILING_MICRO, "the whole deposit came back");
    assert.equal(res.blockedBy?.rule, "settlement_rejected");
    assert.ok(res.channelId);

    // The ledger shows the attempt as a zero payment with the full refund (§4.3).
    const rows = paymentRows(dir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].amountMicro, "0");
    assert.equal(rows[0].refundMicro, "100000");

    const store = new ChannelStore(dir);
    assert.equal(store.get(res.channelId!)?.status, "refunded");
    assert.equal(store.escrowedMicro(live.agentName), 0n, "a refunded channel escrows nothing");
  } finally {
    live.stopHeartbeat?.();
    await seller.close();
  }
});

test("upto buyer: a settle failure after the deposit leaves an orphan the buyer marks unknown", async () => {
  const dir = tmpDir();
  // Deposit succeeds, then the seller's claim throws — the deposit is on-chain
  // and unsettled, the orphan case reconcile resolves later (§4.3 row 3).
  const { operator } = operatorWithPinnedBlockhash({
    settleClaim: async () => {
      throw new Error("settle blew up");
    },
  });
  const seller = await startSeller(operator);
  const live = await buyer(dir);
  try {
    const res = await payingFetch(live.ctx, seller.url(30));

    assert.equal(res.ok, false);
    assert.equal(res.costMicro, 0n);
    assert.equal(res.blockedBy?.rule, "settlement_rejected");
    assert.ok(res.channelId);

    // No payment row — nothing settled — but the escrow row stands as `unknown`,
    // so its deposit is still counted and reconcile can resolve it.
    assert.equal(paymentRows(dir).length, 0);
    const store = new ChannelStore(dir);
    assert.equal(store.get(res.channelId!)?.status, "unknown");
    assert.equal(store.escrowedMicro(live.agentName), CEILING_MICRO, "an unknown channel still escrows its deposit");
  } finally {
    live.stopHeartbeat?.();
    await seller.close();
  }
});

test("upto buyer: a seller over-reporting the actual is clamped to the deposit, not trusted (no crash, computed refund)", async () => {
  // An adversarial/buggy seller returns amountMicro and refundMicro larger than
  // the deposit it was handed. The buyer must clamp to the deposit (the program
  // enforces cumulative <= deposit) and compute the refund itself, and must not
  // throw out of payingFetch (which would skip the ledger and leave the hold).
  const dir = tmpDir();
  const store = new ChannelStore(dir);
  const CHANNEL = randomAddr();
  const AGENT = randomAddr();
  const recorded: { amountMicro: bigint; annotations?: { refundMicro?: bigint; depositMicro?: bigint } }[] = [];

  const offer = {
    scheme: "upto",
    network: "solana-devnet",
    amount: CEILING_MICRO.toString(),
    asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    payTo: randomAddr(),
    extra: { feePayer: randomAddr(), receiverAuthorizer: randomAddr(), withdrawDelay: 900 },
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: { headers?: Record<string, string> }) => {
    if (init?.headers && "X-PAYMENT" in init.headers) {
      // A lying receipt: 5× the deposit, plus a bogus refund figure.
      const lie = Buffer.from(
        JSON.stringify({ success: true, amountMicro: "500000", refundMicro: "500000", transaction: "sig", channelId: CHANNEL }),
      ).toString("base64");
      return new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { "x-payment-response": lie } });
    }
    return new Response(JSON.stringify({ x402Version: 2, accepts: [offer] }), {
      status: 402,
      headers: { "content-type": "application/json" },
    });
  }) as never;

  const ctx = {
    agentName: AGENT,
    address: AGENT,
    chain: { sign: () => "", balance: () => 0n },
    chooseOffer: () => offer,
    authorize: async (amt: bigint) => (amt > 0n ? { allowed: true as const, reservationId: "r1" } : { allowed: true as const }),
    recordPayment: (_u: string, _h: string, amountMicro: bigint, _tx: string, _r: unknown, annotations?: { refundMicro?: bigint; depositMicro?: bigint }) => {
      recorded.push({ amountMicro, annotations });
    },
    recordBlocked: () => {},
    releaseReservation: () => {},
    upto: {
      open: async () => {
        store.add({ channelId: CHANNEL, agent: AGENT, url: "http://localhost/x", host: "localhost", network: "solana-devnet", depositMicro: CEILING_MICRO, withdrawDelay: 900, reservationId: "r1" });
        return { header: "aGVhZGVy", channelId: CHANNEL, depositMicro: CEILING_MICRO };
      },
      resolve: async (channelId: string, outcome: { kind: string; settledMicro?: bigint }) => {
        if (outcome.kind === "settled") store.settle(channelId, outcome.settledMicro!);
        else if (outcome.kind === "refunded") store.refund(channelId);
        else store.markUnknown(channelId);
      },
    },
  };

  try {
    // Must resolve, not reject.
    const res = await payingFetch(ctx as never, "http://localhost/x");
    assert.equal(res.costMicro, CEILING_MICRO, "the claim is clamped to the deposit");
    assert.equal(res.refundMicro, 0n, "clamped claim leaves nothing to refund");
    assert.equal(store.get(CHANNEL)?.status, "settled");
    assert.equal(store.get(CHANNEL)?.settledMicro, "100000", "the store never records more than the deposit");
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].amountMicro, CEILING_MICRO);
    assert.equal(recorded[0].annotations?.refundMicro, 0n, "the ledger refund is computed, not the seller's 500000");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("upto buyer: a transport error after the deposit is built marks the channel unknown and releases the hold (§4.3 row 1)", async () => {
  // Focused on the payUpto branch: the 402 is answered, the open is built and
  // the escrow row written, then the deposit send throws before the seller sees
  // it. Hand-built context so the send can be made to fail deterministically.
  const dir = tmpDir();
  const store = new ChannelStore(dir);
  const CHANNEL = getBase58Decoder().decode(new Uint8Array(crypto.randomBytes(32)));
  const AGENT = "So1anaBuyer1111111111111111111111111111111";
  const blocked: { rule: string }[] = [];
  let released = false;

  const uptoOffer = {
    scheme: "upto",
    network: "solana-devnet",
    amount: CEILING_MICRO.toString(),
    asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    payTo: "Se11er11111111111111111111111111111111111111",
    extra: { feePayer: "Fee1111111111111111111111111111111111111111", receiverAuthorizer: "Auth111111111111111111111111111111111111111", withdrawDelay: 900 },
  };

  let call = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: { headers?: Record<string, string> }) => {
    call++;
    if (init?.headers && "X-PAYMENT" in init.headers) throw new Error("connection refused"); // the deposit send
    // Everything else (preflight GET) is the 402 challenge carrying the offer.
    return new Response(JSON.stringify({ x402Version: 2, accepts: [uptoOffer] }), {
      status: 402,
      headers: { "content-type": "application/json" },
    });
  }) as never;

  const ctx = {
    agentName: AGENT,
    address: AGENT,
    chain: { sign: () => "", balance: () => 0n },
    chooseOffer: () => uptoOffer,
    authorize: async (amt: bigint) => (amt > 0n ? { allowed: true as const, reservationId: "r1" } : { allowed: true as const }),
    recordPayment: () => {},
    recordBlocked: (_u: string, _h: string, rule: string) => {
      blocked.push({ rule });
    },
    releaseReservation: () => {
      released = true;
    },
    upto: {
      open: async () => {
        store.add({
          channelId: CHANNEL,
          agent: AGENT,
          url: "http://localhost/x",
          host: "localhost",
          network: "solana-devnet",
          depositMicro: CEILING_MICRO,
          withdrawDelay: 900,
          reservationId: "r1",
        });
        return { header: "aGVhZGVy", channelId: CHANNEL, depositMicro: CEILING_MICRO };
      },
      resolve: async (channelId: string, outcome: { kind: string; settledMicro?: bigint }) => {
        if (outcome.kind === "settled") store.settle(channelId, outcome.settledMicro!);
        else if (outcome.kind === "refunded") store.refund(channelId);
        else store.markUnknown(channelId);
      },
    },
  };

  try {
    const res = await payingFetch(ctx as never, "http://localhost/x");
    assert.equal(res.ok, false);
    assert.equal(res.status, 0, "a transport error has no HTTP status");
    assert.equal(res.channelId, CHANNEL, "the opened channel is reported even on a send failure");
    assert.equal(res.blockedBy?.rule, "settlement_rejected");
    assert.equal(res.blockedBy?.recoverable, true, "the send can be retried");
    assert.equal(released, true, "the reservation hold is released");
    assert.deepEqual(blocked, [{ rule: "settlement_rejected" }]);
    assert.equal(call, 2, "the deposit send was attempted after the 402");

    // The row is left `unknown` so a later reconcile drops it once it confirms
    // no PDA landed — it is not silently deleted here.
    assert.equal(store.get(CHANNEL)?.status, "unknown");
  } finally {
    globalThis.fetch = realFetch;
  }
});
