import fs from "node:fs";
import path from "node:path";
import { usd } from "./money.ts";

export interface PolicyConfig {
  agentName: string;
  totalBudgetUsd: number;
  perCallMaxUsd: number;
  windowLimitUsd: number;
  windowSeconds: number;
  allowHostSuffixes: string[];
  blockedHosts: string[];
  requireApprovalAboveUsd: number;
}

export type RuntimePolicy = PolicyConfig & { killSwitch: boolean };

export const defaultPolicy: PolicyConfig = {
  agentName: "research-agent",
  totalBudgetUsd: 5,
  perCallMaxUsd: 0.5,
  windowLimitUsd: 2,
  windowSeconds: 12,
  allowHostSuffixes: ["localhost"],
  blockedHosts: [],
  requireApprovalAboveUsd: 0.3,
};

export class PolicyStore {
  private file: string;

  constructor(stateDir: string) {
    fs.mkdirSync(stateDir, { recursive: true });
    this.file = path.join(stateDir, "config.json");
    if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, JSON.stringify(defaultPolicy, null, 2));
  }

  load(): RuntimePolicy {
    const cfg = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<RuntimePolicy>;
    return { ...defaultPolicy, killSwitch: false, ...cfg };
  }

  save(patch: Partial<RuntimePolicy>): void {
    const next = { ...this.load(), ...patch };
    fs.writeFileSync(this.file, JSON.stringify(next, null, 2));
  }
}

export type PolicyDecision = { allowed: true } | { allowed: false; rule: string; detail: string };

export function evaluatePolicy(
  policy: RuntimePolicy,
  ctx: { host: string; amountMicro: bigint; spendTotalMicro: bigint; topupsMicro: bigint; windowSpendMicro: bigint },
): PolicyDecision {
  if (policy.killSwitch)
    return { allowed: false, rule: "kill_switch", detail: "human paused all spending for this agent" };
  const bare = ctx.host.split(":")[0].toLowerCase();
  const matches = (suffix: string) => suffix === "*" || bare === suffix || bare.endsWith("." + suffix);
  if (!policy.allowHostSuffixes.some(matches))
    return {
      allowed: false,
      rule: "host_not_allowlisted",
      detail: `"${bare}" not in allowHostSuffixes [${policy.allowHostSuffixes.join(", ")}]`,
    };
  if (policy.blockedHosts.some(matches))
    return { allowed: false, rule: "host_blocked", detail: `"${bare}" appears in blockedHosts` };
  if (ctx.amountMicro > usd(policy.perCallMaxUsd))
    return {
      allowed: false,
      rule: "per_call_cap",
      detail: `price exceeds per-call cap of $${policy.perCallMaxUsd.toFixed(2)}`,
    };
  if (ctx.windowSpendMicro + ctx.amountMicro > usd(policy.windowLimitUsd))
    return {
      allowed: false,
      rule: "velocity_circuit_breaker",
      detail: `rolling ${policy.windowSeconds}s spend would exceed $${policy.windowLimitUsd.toFixed(2)} limit`,
    };
  if (ctx.topupsMicro - ctx.spendTotalMicro < ctx.amountMicro)
    return { allowed: false, rule: "budget_exhausted", detail: "remaining allowance below price" };
  if (ctx.amountMicro >= usd(policy.requireApprovalAboveUsd))
    return {
      allowed: false,
      rule: "human_approval_required",
      detail: `price at or above $${policy.requireApprovalAboveUsd.toFixed(2)} needs explicit human approval`,
    };
  return { allowed: true };
}
