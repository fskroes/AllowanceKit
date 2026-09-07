/**
 * L-02 acceptance test: pay a real THIRD-PARTY x402 seller on Base Sepolia
 * through the live buyer runtime — not our own `paymentGate`. Proves the v1+v2
 * buyer negotiates a foreign v2 402, signs a real EIP-3009 authorization, and
 * settles against the seller's own facilitator.
 *
 * Seller: QuickNode's x402 RPC gate (https://x402.quicknode.com/api/ping),
 * which advertises x402 v2 on eip155:84532 (Base Sepolia) in USDC.
 *
 * Run: node --env-file=.env scripts/l02-thirdparty.ts [url]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLiveAgent } from "../src/live.ts";
import { topUp } from "../src/wallet.ts";
import { payingFetch } from "../src/payer.ts";

const TARGET = process.argv[2] ?? "https://x402.quicknode.com/api/ping";
const host = new URL(TARGET).host;

const pk = process.env.AGENT_PRIVATE_KEY;
if (!pk) { console.error("AGENT_PRIVATE_KEY not set"); process.exit(1); }

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "l02-thirdparty-"));
const agent = await createLiveAgent({ stateDir, agentName: "l02-agent", privateKey: pk, network: "base-sepolia" });
console.log(`agent   ${agent.address}`);
console.log(`seller  ${TARGET}  (host ${host})`);
console.log(`state   ${stateDir}`);

const bal = await agent.walletBalanceMicro();
console.log(`wallet  $${(Number(bal) / 1e6).toFixed(4)} USDC on base-sepolia\n`);

// Room for the seller's top tier ($1.00), one host, auto-approve under $5.
topUp(agent, 2, "human::l02");
agent.policyStore.save({
  totalBudgetUsd: 2,
  perCallMaxUsd: 1.5,
  windowLimitUsd: 2,
  requireApprovalAboveUsd: 5,
  allowHostSuffixes: [host],
});

const paid = await payingFetch(agent.ctx, TARGET);
console.log("result:");
console.log(JSON.stringify(paid, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));

console.log("\nledger:");
for (const e of agent.ledger.read()) console.log(" ", JSON.stringify(e));

process.exit(paid.ok ? 0 : 1);
