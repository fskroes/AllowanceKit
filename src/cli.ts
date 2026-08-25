import { createAgent, allowanceRemaining } from "./wallet.ts";
import { startDashboard } from "./dashboard-server.ts";
import { fmtUsdExact } from "./money.ts";

const [, , cmd, ...args] = process.argv;
const stateDir = new URL("../.allowance/", import.meta.url).pathname;
const rt = createAgent(stateDir, "research-agent");

async function main(): Promise<void> {
  switch (cmd) {
    case "init": {
      console.log(`agent wallet ${rt.address}`);
      console.log(`policy file  ${stateDir}config.json`);
      console.log(`next: node src/cli.ts topup 5.00`);
      break;
    }
    case "topup": {
      const amount = Number(args[0]);
      if (!(amount > 0)) throw new Error("usage: topup <usd-amount>");
      const micro = BigInt(Math.round(amount * 1e6));
      rt.chain.faucet(rt.address, micro);
      rt.ledger.append({ t: "topup", at: new Date().toISOString(), agent: rt.agentName, amountMicro: micro.toString(), source: "human::cli", balanceAfterMicro: rt.chain.balance(rt.address).toString() });
      console.log(`topped up ${fmtUsdExact(micro)} → remaining ${fmtUsdExact(allowanceRemaining(rt))}`);
      break;
    }
    case "status": {
      const p = rt.policy();
      console.log(`agent        ${rt.agentName}`);
      console.log(`wallet       ${rt.address}`);
      console.log(`remaining    ${fmtUsdExact(allowanceRemaining(rt))} of $${p.totalBudgetUsd.toFixed(2)}`);
      console.log(`per-call cap $${p.perCallMaxUsd.toFixed(2)} · approval ≥ $${p.requireApprovalAboveUsd.toFixed(2)}`);
      console.log(`velocity     $${p.windowLimitUsd.toFixed(2)} / ${p.windowSeconds}s`);
      console.log(`hosts        [${p.allowHostSuffixes.join(", ")}] · killSwitch ${p.killSwitch ? "ON" : "off"}`);
      break;
    }
    case "policy": {
      const [field, ...rest] = args;
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
    case "audit": {
      for (const e of rt.ledger.read()) console.log(JSON.stringify(e));
      break;
    }
    case "dashboard": {
      const port = Number(args[0] ?? 4030);
      await startDashboard(rt, port);
      console.log(`dashboard → http://localhost:${port}`);
      setInterval(() => undefined, 1 << 30);
      break;
    }
    default:
      console.log("usage: cli.ts <init|topup|status|policy [k v]|audit|dashboard [port]>");
  }
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
