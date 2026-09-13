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
import { solanaSigner, usdcBalanceMicroSolana } from "../src/solana.ts";
import {
  createSolanaUptoOperator,
  type DepositOutcome,
  type UptoOperator,
  type UptoPaymentEnvelope,
  type Meter,
} from "../src/seller-upto.ts";
import {
  ChannelStore,
  reconcileChannels,
  reclaimChannel,
  solanaAccountRpc,
  decodeChannelAccount,
} from "../src/channels.ts";
import { Ledger, type LedgerEvent } from "../src/ledger.ts";

/**
 * The Solana `upto` buyer against a real self-facilitated seller on the
 * 402.surfnet.dev sandbox (a mainnet fork with the program and mainnet USDC) —
 * docs/SOLANA-ARCHITECTURE.md §2.7, §7, SOL-05. Gated by `SOLANA_SANDBOX`: it
 * needs the faucet and broadcasts real transactions, so it never runs in CI.
 * The hermetic proof of the same buyer logic is `test/solana-upto-buyer.test.ts`.
 *
 *   SOLANA_SANDBOX=1 node --test test/solana-sandbox.test.ts
 *
 * The two proofs the ticket names:
 *   1. ceiling $0.10, actual $0.03 → on-chain `settled == 30000`, the wallet
 *      lost exactly $0.03, ledger `amountMicro 30000 / depositMicro 100000 /
 *      refundMicro 70000`.
 *   2. the orphan path with `withdrawDelay: 5` reclaims the deposit.
 */

const SANDBOX_URL = process.env.SOLANA_SANDBOX_URL ?? "https://402.surfnet.dev:8899";
// The sandbox shares mainnet genesis, so it is the mainnet network and mint.
const NETWORK = "solana";
const MAINNET_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PER_ROW_MICRO = 1000n; // $0.001 per row
const CEILING_MICRO = 100000n; // $0.10
const gate = { skip: process.env.SOLANA_SANDBOX ? false : "set SOLANA_SANDBOX=1 to run against 402.surfnet.dev" };

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "allowance-sandbox-"));
}

interface Keypair {
  secret: Uint8Array;
  address: string;
  json: string;
}
function keypair(): Keypair {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  const seed = pkcs8.subarray(pkcs8.length - 32);
  const spki = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer;
  const pub = spki.subarray(spki.length - 32);
  const secret = Uint8Array.from(Buffer.concat([seed, pub]));
  return { secret, address: solanaSigner(secret).address, json: JSON.stringify(Array.from(secret)) };
}

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(SANDBOX_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Fund `owner` with lamports (SOL) via the sandbox faucet. */
async function airdropSol(owner: string, sol: number): Promise<void> {
  await rpc("requestAirdrop", [owner, Math.round(sol * 1e9)]);
  await sleep(1500);
}

/** Set `owner`'s USDC balance directly via the surfnet faucet extension. */
async function setUsdc(owner: string, micro: bigint): Promise<void> {
  await rpc("surfnet_setTokenAccount", [owner, MAINNET_MINT, { amount: micro.toString() }]);
  await sleep(1000);
}

async function startSeller(operator: UptoOperator, withdrawDelay?: number): Promise<{ url: (r: number) => string; close(): Promise<void> }> {
  const handler = (req: http.IncomingMessage, res: http.ServerResponse, meter?: Meter): void => {
    const rows = Math.max(0, Number(new URL(req.url ?? "/", "http://x").searchParams.get("rows") ?? "1") || 0);
    meter?.charge(PER_ROW_MICRO * BigInt(rows));
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ rows }));
  };
  const server = http.createServer(
    paymentGate(
      {
        priceMicro: PER_ROW_MICRO,
        description: "Metered rows",
        payTo: keypair().address, // 100% of the distribution goes here
        network: NETWORK,
        facilitator: new MockChain(),
        upto: { ceilingMicro: CEILING_MICRO, operator, withdrawDelay },
      },
      handler,
    ),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as { port: number };
  return { url: (r) => `http://localhost:${port}/rows?rows=${r}`, close: () => new Promise<void>((res) => server.close(() => res())) };
}

async function fundedBuyer(dir: string): Promise<{ live: import("../src/live.ts").LiveAgentRuntime; kp: Keypair }> {
  const kp = keypair();
  await setUsdc(kp.address, 1_000_000n); // $1 USDC on-chain
  await airdropSol(kp.address, 0.05); // dust SOL for the reclaim escape path (§2.5)
  const live = await createLiveAgent({
    stateDir: dir,
    privateKey: kp.json,
    network: NETWORK,
    rpcUrl: SANDBOX_URL,
    preferScheme: "upto",
  });
  topUp(live, 1);
  return { live, kp };
}

function paymentRows(dir: string): Extract<LedgerEvent, { t: "payment" }>[] {
  return new Ledger(dir).read().filter((e): e is Extract<LedgerEvent, { t: "payment" }> => e.t === "payment");
}

test("sandbox: a metered upto buy settles the actual on-chain and refunds the rest", gate, async () => {
  const dir = tmpDir();
  const feePayer = keypair();
  const authorizer = keypair();
  await airdropSol(feePayer.address, 0.5); // fees + rent for open/settle/distribute

  const operator = await createSolanaUptoOperator({
    network: NETWORK,
    feePayerSecret: feePayer.secret,
    receiverAuthorizerSecret: authorizer.secret,
    rpcUrl: SANDBOX_URL,
  });
  const seller = await startSeller(operator);
  const { live, kp } = await fundedBuyer(dir);

  try {
    const before = await usdcBalanceMicroSolana(SANDBOX_URL, MAINNET_MINT, kp.address);

    const res = await payingFetch(live.ctx, seller.url(30)); // 30 rows × $0.001 = $0.03
    assert.equal(res.ok, true, res.error ?? "expected a 200");
    assert.equal(res.costMicro, 30000n);
    assert.equal(res.refundMicro, 70000n);
    assert.ok(res.channelId);

    // On-chain: the channel sealed at exactly the metered amount.
    await sleep(3000);
    const data = await solanaAccountRpc(SANDBOX_URL).getAccountData(res.channelId!);
    if (data) {
      const chain = decodeChannelAccount(data);
      assert.equal(chain.settledMicro, 30000n, "on-chain settled watermark equals the actual");
    }

    // The wallet lost exactly $0.03 (deposit out, 70% refunded).
    const after = await usdcBalanceMicroSolana(SANDBOX_URL, MAINNET_MINT, kp.address);
    assert.equal(before - after, 30000n, "the wallet lost exactly the metered amount");

    // The ledger row carries the escrow annotations.
    const rows = paymentRows(dir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].amountMicro, "30000");
    assert.equal(rows[0].depositMicro, "100000");
    assert.equal(rows[0].refundMicro, "70000");

    assert.equal(new ChannelStore(dir).get(res.channelId!)?.status, "settled");
  } finally {
    live.stopHeartbeat?.();
    await seller.close();
  }
});

test("sandbox: an unsettled deposit orphans, then the payer reclaims it (withdrawDelay 5)", gate, async () => {
  const dir = tmpDir();
  const feePayer = keypair();
  const authorizer = keypair();
  await airdropSol(feePayer.address, 0.5);

  // A seller that opens the deposit on-chain but never settles — the orphan
  // case the buyer must be able to reclaim from independently (§2.5, §4.3).
  const real = await createSolanaUptoOperator({
    network: NETWORK,
    feePayerSecret: feePayer.secret,
    receiverAuthorizerSecret: authorizer.secret,
    rpcUrl: SANDBOX_URL,
    withdrawDelay: 5,
  });
  const stalling: UptoOperator = {
    offerExtra: (i) => real.offerExtra(i),
    openDeposit: (e: UptoPaymentEnvelope): Promise<DepositOutcome> => real.openDeposit(e),
    settleClaim: async () => {
      throw new Error("seller went dark after the deposit");
    },
  };
  const seller = await startSeller(stalling, 5);
  const { live, kp } = await fundedBuyer(dir);
  const store = new ChannelStore(dir);

  try {
    const before = await usdcBalanceMicroSolana(SANDBOX_URL, MAINNET_MINT, kp.address);

    const res = await payingFetch(live.ctx, seller.url(30));
    assert.equal(res.ok, false, "the seller never settled");
    assert.ok(res.channelId);
    assert.equal(store.get(res.channelId!)?.status, "unknown");

    // The deposit really left the wallet.
    const escrowed = await usdcBalanceMicroSolana(SANDBOX_URL, MAINNET_MINT, kp.address);
    assert.equal(before - escrowed, CEILING_MICRO, "the whole ceiling is escrowed on-chain");

    // Reconcile reads the OPEN PDA and orphans the row; the reclaim clock starts.
    await sleep(3000);
    const changes = await reconcileChannels(solanaAccountRpc(SANDBOX_URL), store, { agent: live.agentName });
    assert.ok(changes.some((c) => c.channelId === res.channelId && c.to === "orphaned"), "the open deposit orphaned");

    // Wait past the 5 s grace, then take the deposit back.
    await sleep(6000);
    const record = store.get(res.channelId!)!;
    const result = await reclaimChannel(record, solanaSigner(kp.secret), { rpcUrl: SANDBOX_URL });
    assert.equal(result.reclaimed, true, "the payer reclaimed the deposit");
    assert.equal(result.refundMicro, CEILING_MICRO, "the whole deposit came back (nothing was ever settled)");
    store.markReclaimed(res.channelId!, result.refundMicro);

    await sleep(3000);
    const restored = await usdcBalanceMicroSolana(SANDBOX_URL, MAINNET_MINT, kp.address);
    assert.equal(restored, before, "the wallet is whole again after the reclaim");
    assert.equal(store.get(res.channelId!)?.status, "reclaimed");
  } finally {
    live.stopHeartbeat?.();
    await seller.close();
  }
});
