import { createAgent, allowanceRemaining } from "../src/wallet.ts";
import { startSellerApis, describeServers } from "../src/demo-servers.ts";
import { payingFetch, type PaidResult } from "../src/payer.ts";
import { fmtUsdExact } from "../src/money.ts";

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  amber: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

function banner(text: string): void {
  console.log("\n" + c.bold(cyan(`── ${text}`)) + " " + c.dim("─".repeat(Math.max(4, 72 - text.length))));
}

function cyan(s: string): string {
  return `\x1b[36m${s}\x1b[0m`;
}

function paid(result: PaidResult, label: string, extra = ""): void {
  if (result.txHash) {
    console.log(`  ${c.green("PAID   ")} ${label.padEnd(40)} ${fmtUsdExact(result.costMicro).padStart(10)} ${c.dim(String(result.txHash).slice(0, 10) + "…")} ${extra}`);
  } else if (result.blockedBy) {
    console.log(`  ${c.red("BLOCKED")} ${label.padEnd(40)} ${c.red(result.blockedBy.rule.padEnd(24))} ${c.dim(result.blockedBy.detail.slice(0, 58))}`);
  } else {
    console.log(`  ${c.dim("free   ")} ${label} status ${result.status}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const stateDir = new URL("../.allowance/", import.meta.url).pathname;
  console.log(c.bold("\n  AllowanceKit — an agent that pays its own way, inside rails the human controls"));
  console.log(c.dim("  x402 wire-compatible · zero dependencies · deterministic mock settlement (facilitator is pluggable)\n"));

  const rt = createAgent(stateDir, "research-agent");

  banner("SETUP · human funds a fresh agent wallet once");
  const topupMicro = 5_000_000n;
  rt.chain.faucet(rt.address, topupMicro);
  rt.ledger.append({ t: "topup", at: new Date().toISOString(), agent: rt.agentName, amountMicro: topupMicro.toString(), source: "human::demo-card", balanceAfterMicro: topupMicro.toString() });
  console.log(`  agent wallet   ${rt.address}`);
  console.log(`  allowance      ${c.green("$5.00")} (one-time top-up, agent can never exceed it)`);
  console.log(`  policy         per-call ≤ $0.50 · velocity ≤ $2.00/12s · human approval ≥ $0.30`);
  console.log(`                 host allowlist [${rt.policy().allowHostSuffixes.join(", ")}]`);

  const catalog = await startSellerApis(rt.chain);
  console.log(c.dim("\n  five x402-priced APIs now live on localhost (any real x402 client could pay them):"));
  console.log(c.dim(describeServers(catalog)));

  banner("PHASE 1 · fine-grained pay-per-use (happy path)");
  for (const city of ["lisbon", "oslo", "tokyo"]) {
    const r = await payingFetch(rt.ctx, catalog.weatherUrl(city));
    const w = r.body as { tempC: number; conditions: string } | null;
    paid(r, `weather?city=${city}`, w ? c.dim(`→ ${w.tempC}°C ${w.conditions}`) : "");
  }
  for (const topic of ["agent-payments", "stablecoin-settlement"]) {
    const r = await payingFetch(rt.ctx, catalog.premiumResearchUrl(topic));
    paid(r, `research?topic=${topic}`, r.body ? c.dim("→ findings delivered") : "");
  }

  banner("PHASE 2 · runaway loop (the bug every team eventually hits)");
  console.log(c.amber("  a retry bug fires $0.01 bulk-data calls in a tight loop…\n"));
  let attempts = 0;
  for (let i = 0; i < 400; i++) {
    attempts++;
    const r = await payingFetch(rt.ctx, catalog.bulkDataUrl(1000));
    if (!r.ok && r.blockedBy) {
      paid(r, `loop #${attempts}`, c.dim("(breaker trips here)"));
      break;
    }
    if (i === 0 || i === 49 || i === 99) paid(r, `loop #${attempts}`);
  }

  banner("PHASE 3 · attack & mispricing attempts");
  await sleep(12_500);
  console.log(c.dim("  (velocity window cooled down)\n"));
  const evil = await payingFetch(rt.ctx, "http://evil-api.example.com/steal-data");
  paid(evil, "evil-api.example.com", c.dim("(prompt-injection style redirect)"));
  const report = await payingFetch(rt.ctx, catalog.analystReportUrl("q3-2026"));
  paid(report, "report?id=q3-2026", c.dim("$0.45 > approval threshold $0.30"));
  const feed = await payingFetch(rt.ctx, catalog.enterpriseFeedUrl("pro"));
  paid(feed, "feed?key=pro");

  banner("PHASE 4 · human hits the kill switch mid-flight");
  rt.policyStore.save({ killSwitch: true });
  rt.ledger.append({ t: "policy_change", at: new Date().toISOString(), agent: rt.agentName, field: "killSwitch", value: true });
  const frozen = await payingFetch(rt.ctx, catalog.weatherUrl("berlin"));
  paid(frozen, "weather?city=berlin");
  rt.policyStore.save({ killSwitch: false });
  rt.ledger.append({ t: "policy_change", at: new Date().toISOString(), agent: rt.agentName, field: "killSwitch", value: false });

  banner("RESULT");
  const events = rt.ledger.read();
  const paymentsN = events.filter((e) => e.t === "payment").length;
  const blockedN = events.filter((e) => e.t === "blocked").length;
  const spent = rt.ledger.topups(rt.agentName) - allowanceRemaining(rt);
  console.log(`  spent ${c.bold(fmtUsdExact(spent))} across ${paymentsN} settled payments; ${c.red(String(blockedN) + " policy blocks")} enforced`);
  console.log(`  remaining allowance: ${c.green(fmtUsdExact(allowanceRemaining(rt)))} of $5.00`);
  console.log(c.dim("\n  audit trail (last 5 ledger lines, EU AI Act Art.26 §5 evidence):"));
  for (const e of events.slice(-5)) console.log(c.dim("    " + JSON.stringify(e).slice(0, 110)));

  for (const s of catalog.servers) await s.close();
  console.log(c.dim("\n  run `npm run dashboard` to watch this ledger live → http://localhost:4030\n"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
