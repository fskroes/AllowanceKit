/**
 * Solana canary: the Solana twin of `scripts/canary.ts` (SOL-09).
 *
 * Proves the Solana `upto` money path — a metered call backed by a payment
 * channel — works end to end through the real buyer runtime: the allowance, the
 * per-call cap on the *ceiling*, the escrow book, the channel store and the audit
 * ledger are all in the path.
 *
 * Phase A (always): hermetic proof. A real `createLiveAgent` on `solana-devnet`
 *   pays a real `paymentGate` `upto` seller backed by an `InMemoryUptoOperator`.
 *   Zero network — the offer pins the blockhash and slot. Proves the buyer logic
 *   and the rails without a cent or a keypair. This is the always-on check, the
 *   twin of canary.ts phase 1.
 *
 * Phase B (`--sandbox`, or SOLANA_SANDBOX=1): real settlement on the
 *   402.surfnet.dev sandbox (a mainnet fork with the program and mainnet USDC,
 *   free faucet). Broadcasts real transactions and proves the on-chain
 *   `settled == actual` watermark and that the wallet lost exactly the metered
 *   amount. Autonomous — the faucet funds both wallets — so this is the strongest
 *   proof an agent can record without a funded key.
 *
 * Phase C (`--devnet`, or `--network solana` for MAINNET): real settlement on
 *   public Solana. The buyer is `AGENT_PRIVATE_KEY` (Solana format), which must
 *   already hold USDC — there is no programmatic USDC faucet on devnet. The
 *   seller's fee payer and authorizer are generated and funded with a devnet SOL
 *   airdrop. This is the run whose signature goes into docs/canary-runs/.
 *   `--network solana` settles real money on mainnet-beta and is the human step.
 *
 * Requirements:
 *   AGENT_PRIVATE_KEY  — Solana secret, base58 (Phantom) or JSON array of 64
 *                        bytes (solana-keygen). Needed for phase C only.
 *   SOLANA_SANDBOX_URL — override the sandbox RPC (default 402.surfnet.dev:8899).
 *   SOLANA_DEVNET_RPC  — override the devnet RPC (default api.devnet.solana.com).
 *
 * Run:
 *   node scripts/canary-solana.ts                     # phase A only (no network)
 *   SOLANA_SANDBOX=1 node scripts/canary-solana.ts --sandbox   # + real sandbox settle
 *   node --env-file=.env scripts/canary-solana.ts --devnet     # + real devnet settle
 *   node --env-file=.env scripts/canary-solana.ts --devnet --network solana  # MAINNET
 *   … add --record to print a paste-ready docs/canary-runs/ block on success.
 */
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
  SOLANA_NETWORKS,
  solanaSigner,
  normalizeSolanaKey,
  usdcBalanceMicroSolana,
  solBalanceLamportsSolana,
} from "../src/solana.ts";
import {
  InMemoryUptoOperator,
  createSolanaUptoOperator,
  type Meter,
  type OfferExtraInput,
  type UptoOperator,
  type UptoPaymentEnvelope,
} from "../src/seller-upto.ts";
import {
  ChannelStore,
  solanaAccountRpc,
  decodeChannelAccount,
} from "../src/channels.ts";
import { Ledger, type LedgerEvent } from "../src/ledger.ts";
import { getBase58Decoder } from "@solana/kit";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RST = "\x1b[0m";

function ok(msg: string) { console.log(`${GREEN}✓${RST} ${msg}`); }
function fail(msg: string): never { console.error(`${RED}✗ ${msg}${RST}`); process.exit(1); }
function info(msg: string) { console.log(`${DIM}${msg}${RST}`); }

const SANDBOX = process.argv.includes("--sandbox") || process.env.SOLANA_SANDBOX === "1";
const DEVNET = process.argv.includes("--devnet");
const RECORD = process.argv.includes("--record");

/** Which cluster phase C settles on. Devnet by default; `--network solana` is real money. */
const NETWORK = (() => {
  const i = process.argv.indexOf("--network");
  const value = i >= 0 ? process.argv[i + 1] : process.argv.find((a) => a.startsWith("--network="))?.split("=")[1];
  return value ?? "solana-devnet";
})();

const SANDBOX_URL = process.env.SOLANA_SANDBOX_URL ?? "https://402.surfnet.dev:8899";
const MAINNET_MINT = SOLANA_NETWORKS["solana"].mint;

const PER_ROW_MICRO = 1000n; // $0.001 per row
const CEILING_MICRO = 100000n; // $0.10 — the deposit the buyer escrows
const ROWS = 30; // 30 × $0.001 = $0.03 actual, well under the ceiling (SOL-05 done-when)
const ACTUAL_MICRO = PER_ROW_MICRO * BigInt(ROWS);
const REFUND_MICRO = CEILING_MICRO - ACTUAL_MICRO;

const usd = (micro: bigint) => `$${(Number(micro) / 1e6).toFixed(4)}`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Which cluster a recorded run points its explorer links at. */
type Cluster = "devnet" | "mainnet" | "sandbox";

interface Keypair { secret: Uint8Array; address: string; json: string }

/** A throwaway Ed25519 keypair in the 64-byte form `solana-keygen` writes. */
function keypair(): Keypair {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  const seed = pkcs8.subarray(pkcs8.length - 32);
  const spki = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer;
  const pub = spki.subarray(spki.length - 32);
  const secret = Uint8Array.from(Buffer.concat([seed, pub]));
  return { secret, address: solanaSigner(secret).address, json: JSON.stringify(Array.from(secret)) };
}

/** Build a keypair from an env var holding a Solana secret, or undefined if unset. */
function envKeypair(name: string): Keypair | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  const secret = normalizeSolanaKey(v);
  return { secret, address: solanaSigner(secret).address, json: JSON.stringify(Array.from(secret)) };
}

/** A real 32-byte base58 address — the buyer's `open` build validates every one. */
function randomAddr(): string {
  return getBase58Decoder().decode(new Uint8Array(crypto.randomBytes(32)));
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "allowance-canary-sol-"));
}

function paymentRows(dir: string): Extract<LedgerEvent, { t: "payment" }>[] {
  return new Ledger(dir).read().filter((e): e is Extract<LedgerEvent, { t: "payment" }> => e.t === "payment");
}

/** The metered handler: charge $0.001 per requested row, clamped to the ceiling by the gate. */
function meteredHandler(req: http.IncomingMessage, res: http.ServerResponse, meter?: Meter): void {
  const rows = Math.max(0, Number(new URL(req.url ?? "/", "http://x").searchParams.get("rows") ?? "1") || 0);
  meter?.charge(PER_ROW_MICRO * BigInt(rows));
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ rows }));
}

/** Stand up a local `upto` seller on `network` backed by `operator`. */
async function startSeller(
  network: string,
  operator: UptoOperator,
  payTo: string,
): Promise<{ url: (rows: number) => string; close(): Promise<void> }> {
  const server = http.createServer(
    paymentGate(
      {
        priceMicro: PER_ROW_MICRO,
        description: "Metered rows",
        payTo,
        network,
        facilitator: new MockChain(),
        upto: { ceilingMicro: CEILING_MICRO, operator },
      },
      meteredHandler,
    ),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as { port: number };
  return {
    url: (rows) => `http://localhost:${port}/rows?rows=${rows}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** The buyer policy every phase uses: the $0.10 ceiling fits, one host allowed. */
function setCanaryPolicy(live: import("../src/live.ts").LiveAgentRuntime): void {
  topUp(live, 1);
  live.policyStore.save({
    totalBudgetUsd: 1,
    perCallMaxUsd: 0.15, // above the $0.10 ceiling — the open is allowed
    windowLimitUsd: 1,
    requireApprovalAboveUsd: 0.5,
    allowHostSuffixes: ["localhost", "127.0.0.1"],
  });
}

/** A minimal JSON-RPC call, used for the sandbox faucet and airdrops. */
async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

/**
 * Phase A — the hermetic proof. Runs everywhere, needs nothing. Proves the buyer
 * `upto` flow, the escrow arithmetic, the channel store and the ledger, with the
 * only network hop (the `open` build) made zero-RPC by pinning the blockhash.
 */
async function phaseA(): Promise<void> {
  console.log(`\n${BOLD}Phase A${RST} — hermetic upto proof (no network, no keys)\n`);
  const dir = tmpDir();

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

  const seller = await startSeller("solana-devnet", operator, randomAddr());
  const live = await createLiveAgent({
    stateDir: dir,
    privateKey: keypair().json,
    network: "solana-devnet",
    rpcUrl: "http://127.0.0.1:1", // never reached — the encode is zero-RPC
    checkOnChainBalance: false,
    preferScheme: "upto",
  });
  setCanaryPolicy(live);

  try {
    ok(`Live agent ${live.address} on solana-devnet ${DIM}(hermetic)${RST}`);
    info(`  paying ${ROWS} rows → actual ${usd(ACTUAL_MICRO)}, ceiling ${usd(CEILING_MICRO)}`);
    const res = await payingFetch(live.ctx, seller.url(ROWS));

    if (!res.ok) fail(`upto buy failed: ${res.blockedBy?.rule ?? ""} ${res.error ?? "unknown"}`);
    if (res.costMicro !== ACTUAL_MICRO) fail(`actual charge ${res.costMicro} != ${ACTUAL_MICRO}`);
    if (res.refundMicro !== REFUND_MICRO) fail(`refund ${res.refundMicro} != ${REFUND_MICRO}`);
    if (!res.channelId) fail("no channel id reported");
    ok(`PAID ${usd(res.costMicro)} · refund ${usd(res.refundMicro!)} · channel ${res.channelId.slice(0, 8)}…`);

    // The rail that matters most: the ceiling over the per-call cap must not open.
    live.policyStore.save({ perCallMaxUsd: 0.05 }); // below the $0.10 ceiling
    const overCap = await payingFetch(live.ctx, seller.url(ROWS));
    if (overCap.ok) fail("an upto open settled with the ceiling over the per-call cap — the rails did not hold");
    ok(`Over-cap open refused · rule=${overCap.blockedBy?.rule}`);

    const rows = paymentRows(dir);
    if (rows.length !== 1) fail(`expected exactly 1 payment row, found ${rows.length}`);
    if (rows[0].amountMicro !== "30000" || rows[0].depositMicro !== "100000" || rows[0].refundMicro !== "70000")
      fail(`ledger escrow annotations wrong: ${JSON.stringify(rows[0])}`);
    const rec = new ChannelStore(dir).get(res.channelId);
    if (rec?.status !== "settled") fail(`channel status ${rec?.status} != settled`);
    ok(`Ledger row: amount 30000 · deposit 100000 · refund 70000 · channel settled, escrow back to zero`);
    console.log(`\n${GREEN}${BOLD}✓ Phase A passed — the upto buyer, rails and escrow book hold${RST}\n`);
  } finally {
    live.stopHeartbeat?.();
    await seller.close();
  }
}

/**
 * A real end-to-end settle on a real cluster. The caller has already funded the
 * buyer with USDC and the seller `feePayer` with SOL, and picked the network,
 * mint and RPC — the only difference between the sandbox and public Solana.
 */
async function realSettle(opts: {
  label: string;
  network: string;
  rpcUrl: string;
  mint: string;
  buyer: Keypair;
  feePayer: Keypair;
  authorizer: Keypair;
  cluster: Cluster; // where the record block points its explorer links
}): Promise<void> {
  const { label, network, rpcUrl, mint, buyer, feePayer, authorizer } = opts;
  const dir = tmpDir();

  const operator = await createSolanaUptoOperator({
    network,
    feePayerSecret: feePayer.secret,
    receiverAuthorizerSecret: authorizer.secret,
    rpcUrl,
  });
  const seller = await startSeller(network, operator, keypair().address);

  const live = await createLiveAgent({ stateDir: dir, privateKey: buyer.json, network, rpcUrl, preferScheme: "upto" });
  setCanaryPolicy(live);

  try {
    const before = await usdcBalanceMicroSolana(rpcUrl, mint, buyer.address);
    info(`  buyer USDC before: ${usd(before)}`);

    info(`  payingFetch ${ROWS} rows → actual ${usd(ACTUAL_MICRO)}, ceiling ${usd(CEILING_MICRO)} …`);
    const res = await payingFetch(live.ctx, seller.url(ROWS));
    if (!res.ok) fail(`upto settle failed: ${res.blockedBy?.rule ?? ""} ${res.error ?? "unknown"}`);
    if (res.costMicro !== ACTUAL_MICRO) fail(`actual charge ${res.costMicro} != ${ACTUAL_MICRO}`);
    if (res.refundMicro !== REFUND_MICRO) fail(`refund ${res.refundMicro} != ${REFUND_MICRO}`);
    if (!res.channelId) fail("no channel id reported");
    ok(`PAID ${usd(res.costMicro)} · refund ${usd(res.refundMicro!)} · channel ${res.channelId}`);

    // On-chain: the channel sealed at exactly the metered amount.
    await sleep(3000);
    const data = await solanaAccountRpc(rpcUrl).getAccountData(res.channelId);
    let onChainSettled: bigint | undefined;
    if (data) {
      onChainSettled = decodeChannelAccount(data).settledMicro;
      if (onChainSettled !== ACTUAL_MICRO) fail(`on-chain settled ${onChainSettled} != ${ACTUAL_MICRO}`);
      ok(`On-chain: channel PDA settled watermark = ${usd(onChainSettled)}`);
    } else {
      info("  channel PDA already closed by distribute (rent returned) — settled taken from the receipt");
    }

    // The wallet lost exactly the metered amount (deposit out, the rest refunded).
    const after = await usdcBalanceMicroSolana(rpcUrl, mint, buyer.address);
    if (before - after !== ACTUAL_MICRO) fail(`wallet moved ${before - after}, expected exactly ${ACTUAL_MICRO}`);
    ok(`Wallet lost exactly ${usd(before - after)} (deposit escrowed, ${usd(res.refundMicro!)} refunded)`);

    const rows = paymentRows(dir);
    if (rows.length !== 1) fail(`expected exactly 1 payment row, found ${rows.length}`);
    if (rows[0].amountMicro !== "30000" || rows[0].depositMicro !== "100000" || rows[0].refundMicro !== "70000")
      fail(`ledger escrow annotations wrong: ${JSON.stringify(rows[0])}`);
    if (new ChannelStore(dir).get(res.channelId)?.status !== "settled") fail("channel store not settled");
    ok(`Ledger row: amount 30000 · deposit 100000 · refund 70000 · channel settled`);

    console.log(`\n${GREEN}${BOLD}✓ ${label} passed — real USDC metered and settled on-chain, refund returned${RST}\n`);

    if (RECORD) printRecordBlock({
      network, rpcUrl, buyer: buyer.address, channelId: res.channelId,
      txHash: res.txHash, settledMicro: onChainSettled ?? res.costMicro,
      refundMicro: res.refundMicro!, cluster: opts.cluster,
    });
  } finally {
    live.stopHeartbeat?.();
    await seller.close();
  }
}

/** Phase B — real settle on the 402.surfnet.dev sandbox, funded by the free faucet. */
async function phaseB(): Promise<void> {
  console.log(`\n${BOLD}Phase B${RST} — real settle on the sandbox (${SANDBOX_URL})\n`);

  // Health check first — a clear message beats a mid-run RPC error.
  try {
    await rpc(SANDBOX_URL, "getHealth", []);
  } catch (e) {
    fail(`sandbox unreachable at ${SANDBOX_URL}: ${String(e)}\n  → set SOLANA_SANDBOX_URL, or run a local @solana/surfpool`);
  }

  const buyer = keypair();
  const feePayer = keypair();
  const authorizer = keypair();

  // Fund the buyer's USDC and the seller fee payer's SOL through the surfnet faucet.
  await rpc(SANDBOX_URL, "surfnet_setTokenAccount", [buyer.address, MAINNET_MINT, { amount: 1_000_000 }]); // $1 USDC
  await sleep(1000);
  await rpc(SANDBOX_URL, "requestAirdrop", [buyer.address, Math.round(0.05 * 1e9)]); // dust SOL for the escape path
  await rpc(SANDBOX_URL, "requestAirdrop", [feePayer.address, Math.round(0.5 * 1e9)]); // fees + rent
  await sleep(1500);
  ok(`Buyer ${buyer.address} funded ($1 USDC, 0.05 SOL)`);
  ok(`Seller fee payer ${feePayer.address} airdropped 0.5 SOL`);

  await realSettle({ label: "Phase B (sandbox)", network: "solana", rpcUrl: SANDBOX_URL, mint: MAINNET_MINT, buyer, feePayer, authorizer, cluster: "sandbox" });
}

/** Phase C — real settle on public Solana (devnet by default, mainnet with --network solana). */
async function phaseC(): Promise<void> {
  const netInfo = SOLANA_NETWORKS[NETWORK];
  if (!netInfo) fail(`unknown Solana network "${NETWORK}"`);
  const rpcUrl = (NETWORK === "solana-devnet" ? process.env.SOLANA_DEVNET_RPC : undefined) ?? netInfo.defaultRpc;
  const mint = netInfo.mint;
  const isMainnet = NETWORK === "solana";

  console.log(`\n${BOLD}Phase C${RST} — real settle on ${NETWORK} (${rpcUrl})\n`);
  if (isMainnet)
    console.log(`${YELLOW}${BOLD}  MAINNET — this settles real USDC on Solana. Ctrl-C now if that is not what you meant.${RST}\n`);

  const key = process.env.AGENT_PRIVATE_KEY;
  if (!key) fail("AGENT_PRIVATE_KEY not set — the buyer key (Solana base58 or JSON array)");
  let buyer: Keypair;
  try {
    const secret = normalizeSolanaKey(key);
    buyer = { secret, address: solanaSigner(secret).address, json: JSON.stringify(Array.from(secret)) };
  } catch (e) {
    fail(`AGENT_PRIVATE_KEY is not a Solana key: ${String(e)}\n  → expected base58 (Phantom) or a JSON array of 64 bytes (solana-keygen)`);
  }
  ok(`Buyer ${buyer.address}`);

  // The buyer must hold USDC — there is no programmatic USDC faucet on devnet.
  const usdc = await usdcBalanceMicroSolana(rpcUrl, mint, buyer.address);
  if (usdc < CEILING_MICRO)
    fail(
      `buyer holds ${usd(usdc)} USDC on ${NETWORK} (need ≥ ${usd(CEILING_MICRO)} to escrow the ceiling).\n` +
        (isMainnet
          ? `  → Send USDC on Solana to ${buyer.address}, then run this again.`
          : `  → Fund devnet USDC at https://faucet.circle.com (pick "Solana Devnet"), to ${buyer.address}, then run again.`),
    );
  info(`  buyer USDC: ${usd(usdc)}`);

  // The buyer needs a little SOL for the reclaim escape path if the seller stalls.
  const sol = await solBalanceLamportsSolana(rpcUrl, buyer.address);
  if (sol < 5_000_000n)
    info(`  ${YELLOW}buyer SOL is ${(Number(sol) / 1e9).toFixed(4)} — top up ~0.01 SOL so a stalled seller can be reclaimed (devnet: airdrop)${RST}`);

  // The seller's hot keys. Use SELLER_FEE_PAYER_KEY / SELLER_AUTHORIZER_KEY when
  // set — stable, human-funded, and required on mainnet, which has no airdrop.
  // Otherwise generate them and, on devnet only, airdrop the fee payer.
  const feePayer = envKeypair("SELLER_FEE_PAYER_KEY") ?? keypair();
  const authorizer = envKeypair("SELLER_AUTHORIZER_KEY") ?? keypair();

  const feeSol = await solBalanceLamportsSolana(rpcUrl, feePayer.address);
  const solStr = (l: bigint) => `${(Number(l) / 1e9).toFixed(4)} SOL`;
  if (feeSol >= 100_000_000n) {
    ok(`Seller fee payer ${feePayer.address} holds ${solStr(feeSol)}`);
  } else if (isMainnet) {
    fail(
      `seller fee payer ${feePayer.address} holds ${solStr(feeSol)} — mainnet has no airdrop.\n` +
        `  → Set SELLER_FEE_PAYER_KEY to a key funded with ~0.5 SOL (and SELLER_AUTHORIZER_KEY), then retry.`,
    );
  } else {
    try {
      await rpc(rpcUrl, "requestAirdrop", [feePayer.address, Math.round(0.5 * 1e9)]);
      await sleep(2000);
      ok(`Seller fee payer ${feePayer.address} airdropped 0.5 SOL`);
    } catch (e) {
      fail(
        `could not airdrop SOL to the seller fee payer: ${String(e)}\n` +
          `  → public ${NETWORK} airdrops are rate-limited. Fund ${feePayer.address} with ~0.5 SOL\n` +
          `    (or set SELLER_FEE_PAYER_KEY to a funded key) and retry, or run --sandbox (unlimited faucet).`,
      );
    }
  }

  await realSettle({
    label: `Phase C (${NETWORK})`,
    network: NETWORK,
    rpcUrl,
    mint,
    buyer,
    feePayer,
    authorizer,
    cluster: isMainnet ? "mainnet" : "devnet",
  });
}

/** Print a paste-ready docs/canary-runs/ markdown block after a real settle. */
function printRecordBlock(r: {
  network: string; rpcUrl: string; buyer: string; channelId: string;
  txHash?: string; settledMicro: bigint; refundMicro: bigint; cluster: Cluster;
}): void {
  const date = new Date().toISOString().slice(0, 10);
  const sandbox = r.cluster === "sandbox";
  // Mainnet-beta is the default cluster, so its explorer links carry no ?cluster
  // suffix; devnet needs one; the sandbox fork has no public explorer at all.
  const suffix = r.cluster === "devnet" ? "?cluster=devnet" : "";
  const filename = sandbox ? `${date}-solana-surfnet-sandbox.md` : `${date}-${r.network}-upto.md`;
  const heading = sandbox ? "solana sandbox (402.surfnet.dev)" : r.network;
  const command = sandbox
    ? "SOLANA_SANDBOX=1 node scripts/canary-solana.ts --sandbox --record"
    : `node --env-file=.env scripts/canary-solana.ts ${r.network === "solana-devnet" ? "--devnet" : `--devnet --network ${r.network}`} --record`;
  const explorer = sandbox
    ? `(sandbox / mainnet-fork — no public explorer)`
    : `https://explorer.solana.com/address/${r.channelId}${suffix}`;
  const txLine = !r.txHash
    ? `- Settle signature: (not surfaced on PaidResult — verify via the channel PDA above)`
    : sandbox
      ? `- Settle signature: \`${r.txHash}\``
      : `- Settle signature: \`${r.txHash}\`\n  https://explorer.solana.com/tx/${r.txHash}${suffix}`;
  console.log(`${DIM}${"─".repeat(70)}${RST}`);
  console.log(`${BOLD}Paste into docs/canary-runs/${filename}${RST}\n`);
  console.log(`# ${date} · ${heading} — Solana upto (SOL-09)

The live buyer runtime opened a payment channel, metered the call, settled the
actual on-chain and had the rest refunded — the Solana \`upto\` money path end to
end (docs/SOLANA-ARCHITECTURE.md §4.3, SOL-05/SOL-09).

## Command

\`\`\`
${command}
\`\`\`

## Wallets & limits

- Buyer: \`${r.buyer}\`
- Ceiling (deposit escrowed): ${usd(CEILING_MICRO)} · per-call cap $0.15 · rows ${ROWS}

## Channel & settlement

- Network: \`${r.network}\` · RPC \`${r.rpcUrl}\`
- Channel PDA (channelId): \`${r.channelId}\`
  ${explorer}
${txLine}
- Metered actual settled on-chain: ${usd(r.settledMicro)}
- Refunded to the buyer: ${usd(r.refundMicro)}
- Buyer wallet delta: exactly ${usd(r.settledMicro)}

## Ledger row

\`\`\`json
{"t":"payment","scheme":"upto","amountMicro":"${r.settledMicro}","depositMicro":"${CEILING_MICRO}","refundMicro":"${r.refundMicro}","channelId":"${r.channelId}"}
\`\`\`

## Result

The channel settled at exactly the metered amount and the difference refunded in
the same step; the buyer wallet lost only the actual charge. \`upto\` proven on
${r.network}.`);
  console.log(`${DIM}${"─".repeat(70)}${RST}`);
}

async function main() {
  console.log(`${BOLD}AllowanceKit Solana canary${RST} — proves the Solana upto money path\n`);
  if (!SANDBOX && !DEVNET)
    info("Running the hermetic phase only · add --sandbox (free faucet) or --devnet for a real settle\n");

  await phaseA();
  if (SANDBOX) await phaseB();
  if (DEVNET) await phaseC();

  console.log(`${GREEN}${BOLD}✓ Solana canary complete${RST}\n`);
}

main().catch((e) => fail(String(e)));
