/**
 * L-02 acceptance test: pay a real THIRD-PARTY x402 seller on Base Sepolia
 * through the live buyer runtime — not our own `paymentGate`. Proves the v1+v2
 * buyer negotiates a foreign v2 402, selects the right offer, signs a real
 * EIP-3009 authorization, and settles against the seller's own facilitator to a
 * 200 with a receipt.
 *
 * Seller (default): Mart402's PDF parser (https://mart402.dev/v1/parse) — a
 * deterministic product that runs FULLY on its Base Sepolia sandbox (its own
 * agents.md documents an end-to-end settlement on 2026-08-11). Its `/v1/parse`
 * wants a free `quote_id` first, so this harness fetches one, then pays.
 *
 * Any other seller can be passed as argv[1]; a `/v1/parse` path triggers the
 * quote step, anything else is fetched as a plain GET.
 *
 * Run: node --env-file=.env scripts/l02-thirdparty.ts [url]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLiveAgent } from "../src/live.ts";
import { topUp } from "../src/wallet.ts";
import { payingFetch } from "../src/payer.ts";

const TARGET = process.argv[2] ?? "https://mart402.dev/v1/parse";
/** A tiny public one-page PDF, used only to obtain a free quote to pay against. */
const SAMPLE_PDF = "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf";
const target = new URL(TARGET);
const host = target.host;

const pk = process.env.AGENT_PRIVATE_KEY;
if (!pk) { console.error("AGENT_PRIVATE_KEY not set"); process.exit(1); }

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "l02-thirdparty-"));
const agent = await createLiveAgent({ stateDir, agentName: "l02-agent", privateKey: pk, network: "base-sepolia" });
console.log(`agent   ${agent.address}`);
console.log(`seller  ${TARGET}  (host ${host})`);
console.log(`state   ${stateDir}`);

const bal = await agent.walletBalanceMicro();
console.log(`wallet  $${(Number(bal) / 1e6).toFixed(4)} USDC on base-sepolia\n`);

// Room for a dollar-ish call, one host, auto-approve under $5.
topUp(agent, 2, "human::l02");
agent.policyStore.save({
  totalBudgetUsd: 2,
  perCallMaxUsd: 1.5,
  windowLimitUsd: 2,
  requireApprovalAboveUsd: 5,
  allowHostSuffixes: [host],
});

// Mart402's /v1/parse needs a free quote_id in the POST body; fetch one first.
let init: RequestInit | undefined;
if (/\/v1\/parse\/?$/.test(target.pathname)) {
  const quoteUrl = new URL("/v1/parse/quote", target).toString();
  const qr = await fetch(quoteUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: SAMPLE_PDF }),
  });
  const q = (await qr.json()) as { ok?: boolean; quote_id?: string; pages?: number; price_usd?: number };
  if (!q.ok || !q.quote_id) {
    console.error(`quote failed (${qr.status}): ${JSON.stringify(q)}`);
    process.exit(1);
  }
  console.log(`quote   ${q.quote_id}  (${q.pages} page(s), ~$${q.price_usd} on the sandbox)\n`);
  init = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quote_id: q.quote_id }),
  };
}

const paid = await payingFetch(agent.ctx, TARGET, init);
console.log("result:");
console.log(JSON.stringify(paid, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));

console.log("\nledger:");
for (const e of agent.ledger.read()) console.log(" ", JSON.stringify(e));

process.exit(paid.ok ? 0 : 1);
