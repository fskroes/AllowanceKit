import fs from "node:fs";
import path from "node:path";
import { createAgent, decideApproval, allowanceRemaining, topUp } from "./wallet.ts";
import { startSellerApis, describeServers } from "./demo-servers.ts";
import { payingFetch, type PaidResult } from "./payer.ts";
import { fmtUsdExact } from "./money.ts";
import { RULE_LABELS } from "./policy.ts";

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  amber: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

function banner(text: string): void {
  console.log("\n" + c.bold(c.cyan(`── ${text}`)) + " " + c.dim("─".repeat(Math.max(4, 72 - text.length))));
}

function paid(result: PaidResult, label: string, extra = ""): void {
  if (result.txHash) {
    console.log(
      `  ${c.green("PAID   ")} ${label.padEnd(40)} ${fmtUsdExact(result.costMicro).padStart(10)} ` +
        `${c.dim(String(result.txHash).slice(0, 10) + "…")} ${extra}`,
    );
  } else if (result.blockedBy) {
    console.log(
      `  ${c.red("BLOCKED")} ${label.padEnd(40)} ${c.red(RULE_LABELS[result.blockedBy.rule].padEnd(26))} ` +
        `${c.dim(result.blockedBy.detail.slice(0, 62))}`,
    );
  } else {
    console.log(`  ${c.dim("free   ")} ${label} status ${result.status}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The full story in one command: happy path → runaway loop → attack →
 * approval gate → kill switch. Runs entirely on the mock ledger in its own
 * state dir, so it never touches a funded allowance.
 */
export async function runDemo(stateDir: string): Promise<void> {
  const dir = path.resolve(stateDir);
  console.log(c.bold("\n  AllowanceKit — an agent that pays its own way, inside rails the human controls"));
  console.log(
    c.dim("  Practice mode: every dollar below is simulated on a local ledger. No real money can move.\n"),
  );
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(c.dim(`  (demo state ${path.basename(dir)}/ reset — your funded allowance is never touched)\n`));
  }

  const rt = createAgent(dir);

  banner("SETUP · human funds a fresh agent wallet once");
  topUp(rt, 5, "human::demo-card");
  console.log(`  agent wallet   ${rt.address}`);
  console.log(
    `  allowance      ${c.green("$5.00 practice money")} (the agent can never exceed it)`,
  );
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
  paid(report, "report?id=q3-2026", c.dim("$0.45 ≥ $0.30 → queued for human"));
  const reqId = report.blockedBy?.requestId ?? rt.approvals.pending()[0]?.id;
  if (!reqId) throw new Error("expected a queued approval request for the analyst report");
  console.log(c.amber(`  human reviews the queue (dashboard button or \`npx allowance-kit approve ${reqId}\`)…`));
  decideApproval(rt, reqId, true);
  console.log(c.green(`  approved ${reqId} — the agent retries the exact same call:`));
  const retry = await payingFetch(rt.ctx, catalog.analystReportUrl("q3-2026"));
  paid(retry, "report?id=q3-2026 (retry)", c.dim("(approved grant covers this host+amount)"));
  const feed = await payingFetch(rt.ctx, catalog.enterpriseFeedUrl("pro"));
  paid(feed, "feed?key=pro");

  banner("PHASE 4 · human hits the kill switch mid-flight");
  rt.policyStore.save({ killSwitch: true });
  rt.ledger.append({
    t: "policy_change",
    at: new Date().toISOString(),
    agent: rt.agentName,
    field: "killSwitch",
    value: true,
  });
  const frozen = await payingFetch(rt.ctx, catalog.weatherUrl("berlin"));
  paid(frozen, "weather?city=berlin");
  rt.policyStore.save({ killSwitch: false });
  rt.ledger.append({
    t: "policy_change",
    at: new Date().toISOString(),
    agent: rt.agentName,
    field: "killSwitch",
    value: false,
  });

  banner("RESULT");
  const events = rt.ledger.read();
  const paymentsN = events.filter((e) => e.t === "payment").length;
  const blockedN = events.filter((e) => e.t === "blocked").length;
  const spent = rt.ledger.spendTotal(rt.agentName);
  console.log(
    `  spent ${c.bold(fmtUsdExact(spent))} across ${paymentsN} settled payments; ` +
      `${c.red(String(blockedN) + " policy blocks")} enforced`,
  );
  console.log(`  remaining allowance: ${c.green(fmtUsdExact(allowanceRemaining(rt)))} of $5.00`);
  console.log(c.dim("\n  audit trail (last 5 ledger lines, EU AI Act Art.26 §5 evidence):"));
  for (const e of events.slice(-5)) console.log(c.dim("    " + JSON.stringify(e).slice(0, 110)));

  for (const s of catalog.servers) await s.close();

  const rel = path.relative(process.cwd(), dir) || dir;
  console.log(c.bold("\n  See this ledger in the live dashboard — same numbers, with a kill switch:"));
  console.log(`    npx allowance-kit dashboard --state ${rel}\n`);
}
