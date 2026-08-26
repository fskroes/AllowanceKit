import fs from "node:fs";
import path from "node:path";
import { createAgent, decideApproval, allowanceRemaining } from "./wallet.ts";
import { startDashboard } from "./dashboard-server.ts";
import { fmtUsdExact } from "./money.ts";

const SIMULATED = "SIMULATED FUNDS (built-in mock ledger — no real money moves)";

async function main(): Promise<void> {
  const [, , cmd, ...args] = process.argv;
  const stateDir = new URL("../.allowance/", import.meta.url).pathname;

  switch (cmd) {
    case "init": {
      const existed = fs.existsSync(path.join(stateDir, "agent.json"));
      const rt = createAgent(stateDir, "research-agent");
      console.log(`${existed ? "existing" : "provisioned"} agent wallet ${rt.address}`);
      console.log(`settlement  ${SIMULATED}`);
      console.log(`policy file ${stateDir}config.json`);
      console.log(`next: node src/cli.ts topup 5.00`);
      break;
    }
    case "topup": {
      const rt = createAgent(stateDir, "research-agent");
      const amount = Number(args[0]);
      if (!(amount > 0)) throw new Error("usage: topup <usd-amount>");
      const micro = BigInt(Math.round(amount * 1e6));
      rt.chain.faucet(rt.address, micro);
      rt.ledger.append({ t: "topup", at: new Date().toISOString(), agent: rt.agentName, amountMicro: micro.toString(), source: "human::cli", balanceAfterMicro: rt.chain.balance(rt.address).toString() });
      console.log(`topped up ${fmtUsdExact(micro)} (${SIMULATED})`);
      console.log(`remaining   ${fmtUsdExact(allowanceRemaining(rt))}`);
      break;
    }
    case "status": {
      const rt = createAgent(stateDir, "research-agent");
      const p = rt.policy();
      console.log(`agent        ${rt.agentName}`);
      console.log(`wallet       ${rt.address} (stable across commands)`);
      console.log(`settlement   ${SIMULATED}`);
      console.log(`remaining    ${fmtUsdExact(allowanceRemaining(rt))} of $${p.totalBudgetUsd.toFixed(2)}`);
      console.log(`per-call cap $${p.perCallMaxUsd.toFixed(2)} · approval ≥ $${p.requireApprovalAboveUsd.toFixed(2)}`);
      console.log(`velocity     $${p.windowLimitUsd.toFixed(2)} / ${p.windowSeconds}s`);
      console.log(`hosts        [${p.allowHostSuffixes.join(", ")}] · killSwitch ${p.killSwitch ? "ON" : "off"}`);
      break;
    }
    case "policy": {
      const [field, ...rest] = args;
      const rt = createAgent(stateDir, "research-agent");
      if (!field) {
        console.log(JSON.stringify(rt.policy(), null, 2));
        break;
      }
      const value = rest.join(" ");
      const parsed: Record<string, unknown> = field === "allowHostSuffixes" || field === "blockedHosts"
        ? { [field]: JSON.parse(value) }
        : isNaN(Number(value))
          ? { [field]: value === "true" ? true : value === "false" ? false : value }
          : { [field]: Number(value) };
      rt.policyStore.save(parsed);
      rt.ledger.append({ t: "policy_change", at: new Date().toISOString(), agent: rt.agentName, field, value });
      console.log(JSON.stringify(rt.policy(), null, 2));
      break;
    }
    case "approvals": {
      const rt = createAgent(stateDir, "research-agent");
      const pending = rt.approvals.pending();
      if (!pending.length) {
        console.log("no approval requests pending");
        break;
      }
      for (const r of pending)
        console.log(`${r.id}  ${fmtUsdExact(BigInt(r.amountMicro)).padStart(10)}  ${r.host}  requested ${r.at}\n    approve: node src/cli.ts approve ${r.id}`);
      break;
    }
    case "approve":
    case "deny": {
      const id = args[0];
      if (!id) throw new Error(`usage: ${cmd} <request-id>   (list ids with: node src/cli.ts approvals)`);
      const rt = createAgent(stateDir, "research-agent");
      if (decideApproval(rt, id, cmd === "approve")) console.log(`${cmd === "approve" ? "approved" : "denied"} request ${id}`);
      else throw new Error(`no pending approval request "${id}" (list ids with: node src/cli.ts approvals)`);
      break;
    }
    case "audit": {
      const rt = createAgent(stateDir, "research-agent");
      for (const e of rt.ledger.read()) console.log(JSON.stringify(e));
      break;
    }
    case "dashboard": {
      const rt = createAgent(stateDir, "research-agent");
      const port = Number(args[0] ?? 4030);
      await startDashboard(rt, port);
      const token = fs.readFileSync(path.join(stateDir, "dashboard-token"), "utf8").trim();
      console.log(`dashboard → http://localhost:${port}`);
      console.log(`kill switch & approvals are token-gated · control token: ${token.slice(0, 8)}… (full token in .allowance/dashboard-token)`);
      setInterval(() => undefined, 1 << 30);
      break;
    }
    default:
      console.log("usage: cli.ts <init|topup <usd>|status|policy [k v]|audit|approvals|approve <id>|deny <id>|dashboard [port]>");
  }
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
