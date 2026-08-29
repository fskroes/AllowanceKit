/**
 * Canary: proves AllowanceKit works against the real CDP facilitator.
 *
 * Phase 1 (always): JWT auth → CDP verify endpoint. Proves ES256 signing
 *                    and CDP API key are valid.
 * Phase 2 (if --full): end-to-end: local seller + CDP facilitator + payingFetch
 *                      against a real CDP-settled payment on Base Sepolia.
 * Phase 3 (if --full): the same payment through the real buyer runtime —
 *                      `createLiveAgent`, so the allowance, the on-chain balance
 *                      check, the approval gate and the audit ledger are all in
 *                      the path. Phase 2 proves the wire works; phase 3 proves
 *                      the product does.
 *
 * Requirements:
 *   CDP_API_KEY_ID     — CDP portal API key (ECDSA/P-256)
 *   CDP_API_KEY_SECRET — PEM private key (from portal download)
 *   AGENT_PRIVATE_KEY  — hex private key for a Base Sepolia wallet (phases 2-3)
 *
 * Run:
 *   node --env-file=.env scripts/canary.ts            # auth check only
 *   node --env-file=.env scripts/canary.ts --full     # auth + both settlement phases
 *   node --env-file=.env scripts/canary.ts --buyer    # auth + the buyer runtime only
 *   node --env-file=.env scripts/canary.ts --buyer --network base   # MAINNET, real money
 */
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CdpFacilitator } from "../src/facilitator-cdp.ts";
import { paymentGate } from "../src/seller.ts";
import { payingFetch } from "../src/payer.ts";
import { createLiveAgent } from "../src/live.ts";
import { topUp } from "../src/wallet.ts";
import type { AcceptsEntry } from "../src/types.ts";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RST = "\x1b[0m";

function ok(msg: string) { console.log(`${GREEN}✓${RST} ${msg}`); }
function fail(msg: string) { console.error(`${RED}✗ ${msg}${RST}`); process.exit(1); }
function info(msg: string) { console.log(`${DIM}${msg}${RST}`); }

const FULL = process.argv.includes("--full");
const BUYER_ONLY = process.argv.includes("--buyer");
const PHASE1_ONLY = !FULL && !BUYER_ONLY;

/**
 * Which chain phase 3 settles on. Base Sepolia by default — reaching mainnet
 * has to be typed out, because on mainnet this spends money that is real.
 */
const NETWORK = (() => {
  const i = process.argv.indexOf("--network");
  const value = i >= 0 ? process.argv[i + 1] : process.argv.find((a) => a.startsWith("--network="))?.split("=")[1];
  return value ?? "base-sepolia";
})();

async function phase1Verify(): Promise<CdpFacilitator> {
  console.log(`\n${BOLD}Phase 1${RST} — JWT auth → CDP verify endpoint\n`);

  const fac = new CdpFacilitator(); // reads CDP_API_KEY_ID / CDP_API_KEY_SECRET from env
  ok(`Facilitator created · keyId=${fac.apiKeyId.slice(0, 8)}…`);

  // Fake x402 v1 payload — signer doesn't matter; CDP will reject it
  // but a valid HTTP response proves our JWT authenticated successfully.
  const fakePayload = {
    x402Version: 1,
    scheme: "exact",
    network: "base-sepolia",
    resource: "https://canary.test/probe",
    payload: {
      signature: `0x${crypto.randomBytes(65).toString("hex")}`,
      authorization: {
        from: `0x${crypto.randomBytes(20).toString("hex")}`,
        to: `0x${crypto.randomBytes(20).toString("hex")}`,
        value: "10000",
        validAfter: "0",
        validBefore: String(Math.floor(Date.now() / 1000) + 600),
        nonce: `0x${crypto.randomBytes(32).toString("hex")}`,
      },
    },
  };

  const reqs: AcceptsEntry = {
    scheme: "exact",
    network: "base-sepolia",
    maxAmountRequired: "10000",
    resource: "https://canary.test/probe",
    description: "canary probe",
    mimeType: "application/json",
    payTo: `0x${crypto.randomBytes(20).toString("hex")}`,
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  };

  try {
    const result = await fac.verify(fakePayload, reqs);
    if (result.isValid) {
      info("  CDP responded with isValid: true (unexpected for a random payload — something else signed it)");
    } else {
      ok(`CDP responded · isValid=false · reason="${result.invalidReason}" — JWT auth succeeded`);
    }
    return fac;
  } catch (err) {
    const msg = String(err);
    if (msg.includes("401") || msg.includes("403") || msg.includes("CDP_API_KEY")) {
      fail(`CDP rejected our auth: ${msg}\n  → Check CDP_API_KEY_ID / CDP_API_KEY_SECRET (must be ECDSA/P-256)`);
    }
    // Network errors or 4xx from payload rejection = auth still worked
    if (msg.includes("400") || msg.includes("422")) {
      ok(`CDP responded (HTTP ${msg.includes("400") ? "400" : "422"}) — JWT auth succeeded · payload rejected (expected for random sig)`);
      return fac;
    }
    fail(`Unexpected error calling CDP: ${msg}`);
  }
}

async function phase2E2E(fac: CdpFacilitator): Promise<void> {
  console.log(`\n${BOLD}Phase 2${RST} — end-to-end: local seller + CDP facilitator + payingFetch\n`);

  const agentKey = process.env.AGENT_PRIVATE_KEY;
  if (!agentKey) fail("AGENT_PRIVATE_KEY not set — needed for end-to-end (Base Sepolia USDC wallet)");

  let privateKeyToAccount: (pk: string) => { address: string; signTypedData: (args: unknown) => Promise<string> };
  let keccak256: (hex: `0x${string}`) => `0x${string}`;
  try {
    const viemAccounts = "viem/accounts";
    ({ privateKeyToAccount } = await import(viemAccounts));
    ({ keccak256 } = await import("viem"));
  } catch {
    fail("viem not installed — needed for EIP-3009 signing (npm i viem)");
  }
  const pk = agentKey.startsWith("0x") ? agentKey : `0x${agentKey}`;
  const account = privateKeyToAccount(pk);
  ok(`Agent wallet ${account.address}`);

  // Check USDC balance on Base Sepolia via public RPC (no viem dependency)
  const balanceCheck = await fetch("https://sepolia.base.org", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "eth_call",
      params: [{
        to: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        data: `0x70a08231000000000000000000000000${account.address.slice(2).toLowerCase()}`
      }, "latest"],
    }),
  });
  const balResp = await balanceCheck.json() as { result?: string };
  const balance = balResp.result ? BigInt(balResp.result) : 0n;
  if (balance < 10000n) { // < $0.01 USDC
    fail(
      `Agent wallet has ${balance} USDC atomic units (< $0.01) on Base Sepolia.\n` +
      `  → Fund it with USDC: https://faucet.circle.com (pick "Base Sepolia", no login, 20 USDC)\n` +
      `  → No testnet ETH needed: the facilitator submits the transfer and pays the gas.`,
    );
  }
  info(`  USDC balance: ${balance} atomic units ($${(Number(balance) / 1e6).toFixed(4)})`);

  // Spin up a local x402-gated server settled through CDP
  const priceMicro = 10000n; // $0.01
  // The facilitator rejects self-sends ("self_send_not_allowed"), so the seller
  // is a second wallet deterministically derived from the agent key — the payment
  // is a real transfer, and the funds stay under the same operator's control.
  const sellerAccount = privateKeyToAccount(keccak256(pk as `0x${string}`));
  const payTo = sellerAccount.address;
  ok(`Seller wallet ${payTo} ${DIM}(derived from agent key)${RST}`);

  const server = http.createServer(
    paymentGate(
      { priceMicro, description: "canary endpoint", payTo, facilitator: fac, network: "base-sepolia" },
      (_req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ canary: true })); },
    ),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/data`;
  ok(`Local x402 seller running → ${url} · price $0.01 USDC`);

  // Build a live agent (same viem signer, same wallet)
  const rails = {
    agentName: "canary-agent",
    address: account.address,
    chain: { sign: () => { throw new Error("mock-only"); }, balance: () => balance },
    encodePayment: async (unsigned: { requirements: AcceptsEntry; [k: string]: unknown }) => {
      const { encodePaymentEvm } = await import("../src/live.ts");
      return encodePaymentEvm(account, unsigned as Parameters<typeof encodePaymentEvm>[1]);
    },
    authorize: async () => ({ allowed: true } as const),
    recordPayment: () => {},
    recordBlocked: () => {},
  };

  info("  Sending payingFetch — will hit 402 challenge, sign EIP-3009, settle via CDP…");
  const result = await payingFetch(rails, url);

  server.closeAllConnections();
  server.close();

  if (result.ok) {
    ok(`PAID $${(Number(result.costMicro) / 1e6).toFixed(4)} · txHash=${result.txHash?.slice(0, 14)}…`);
    console.log(`\n${GREEN}${BOLD}✓ Canary passed — AllowanceKit → CDP → Base Sepolia settlement works end-to-end${RST}\n`);
  } else {
    fail(`Payment failed: ${result.blockedBy?.rule ?? ""} ${result.error ?? "unknown"}`);
  }
}

/**
 * The buyer runtime, end to end. Everything phase 2 stubs out is real here: the
 * allowance ledger, the on-chain balance check, the host allowlist, the approval
 * gate and the audit trail. A payment that settles in phase 2 but is refused
 * here means the rails are wrong, which is the failure this project exists to
 * prevent.
 */
async function phase3Buyer(fac: CdpFacilitator): Promise<void> {
  console.log(`\n${BOLD}Phase 3${RST} — the same payment through the real buyer runtime\n`);

  const agentKey = process.env.AGENT_PRIVATE_KEY;
  if (!agentKey) fail("AGENT_PRIVATE_KEY not set — needed for the buyer runtime");

  let keccak256: (hex: `0x${string}`) => `0x${string}`;
  let privateKeyToAccount: (pk: string) => { address: string };
  try {
    ({ keccak256 } = await import("viem"));
    const viemAccounts = "viem/accounts";
    ({ privateKeyToAccount } = await import(viemAccounts));
  } catch {
    fail("viem not installed — needed for EIP-3009 signing (npm i viem)");
  }
  const pk = (agentKey!.startsWith("0x") ? agentKey! : `0x${agentKey}`) as `0x${string}`;

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "allowance-canary-"));
  if (NETWORK === "base")
    console.log(`${YELLOW}${BOLD}  MAINNET — this settles real USDC on Base. Ctrl-C now if that is not what you meant.${RST}`);
  const agent = await createLiveAgent({ stateDir, agentName: "canary-agent", privateKey: pk, network: NETWORK });
  ok(`Live agent ${agent.address} · state ${stateDir}`);

  const onChain = await agent.walletBalanceMicro();
  info(`  Wallet holds $${(Number(onChain) / 1e6).toFixed(4)} USDC on ${NETWORK}`);
  if (onChain < 10_000n)
    fail(
      `wallet has less than $0.01 USDC on ${NETWORK}.\n` +
        (NETWORK === "base"
          ? `  → Send USDC on Base to ${agent.address}, then run this again.`
          : `  → Fund it: https://faucet.circle.com (pick "Base Sepolia", no login, 20 USDC)`),
    );

  // A $0.20 allowance, a $0.05 per-call cap, one host. Deliberately tight: the
  // point is that a real payment fits inside real limits.
  topUp(agent, 0.2, "human::canary");
  agent.policyStore.save({
    totalBudgetUsd: 0.2,
    perCallMaxUsd: 0.05,
    windowLimitUsd: 0.2,
    requireApprovalAboveUsd: 0.1,
    allowHostSuffixes: ["localhost", "127.0.0.1"],
  });
  ok(`Allowance $0.20 · per-call cap $0.05 · approval needed at $0.10+`);

  const sellerAccount = privateKeyToAccount(keccak256(pk));
  const server = http.createServer(
    paymentGate(
      { priceMicro: 10000n, description: "canary endpoint", payTo: sellerAccount.address, facilitator: fac, network: NETWORK },
      (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ canary: true }));
      },
    ),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/data`;
  ok(`Local x402 seller running → ${url} · price $0.01 USDC`);

  info("  payingFetch through the rails — allowance, balance check, ledger…");
  const paid = await payingFetch(agent.ctx, url);

  // And the rail that matters most: a price over the cap must not settle.
  let overCap: Awaited<ReturnType<typeof payingFetch>> | undefined;
  if (paid.ok) {
    agent.policyStore.save({ perCallMaxUsd: 0.005 });
    overCap = await payingFetch(agent.ctx, url);
  }

  server.closeAllConnections();
  server.close();

  if (!paid.ok) fail(`Payment failed: ${paid.blockedBy?.rule ?? ""} ${paid.error ?? "unknown"}`);
  ok(`PAID $${(Number(paid.costMicro) / 1e6).toFixed(4)} · txHash=${paid.txHash?.slice(0, 14)}…`);

  if (overCap?.ok) fail("a $0.01 payment settled under a $0.005 per-call cap — the rails did not hold");
  ok(`Over-cap payment refused · rule=${overCap?.blockedBy?.rule}`);

  const events = agent.ledger.read();
  const payments = events.filter((e) => e.t === "payment");
  const blocks = events.filter((e) => e.t === "blocked");
  if (payments.length !== 1) fail(`expected exactly 1 payment in the audit ledger, found ${payments.length}`);
  if (blocks.length !== 1) fail(`expected exactly 1 block in the audit ledger, found ${blocks.length}`);
  ok(`Audit ledger holds ${events.length} entries: 1 top-up, 1 payment, 1 block, and the policy changes`);
  console.log(`\n${GREEN}${BOLD}✓ Buyer runtime canary passed — real USDC moved inside real limits${RST}\n`);
}

async function main() {
  console.log(`${BOLD}AllowanceKit canary${RST} — proves CDP facilitator integration works\n`);
  if (PHASE1_ONLY) info("Running auth check only · add --full for end-to-end settlement\n");
  const fac = await phase1Verify();
  if (FULL) await phase2E2E(fac);
  if (FULL || BUYER_ONLY) await phase3Buyer(fac);
}

main().catch((e) => fail(String(e)));
