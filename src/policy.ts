import fs from "node:fs";
import path from "node:path";
import { fmtUsd, usd } from "./money.ts";

/**
 * The complete vocabulary of reasons a payment can be refused. Exported so
 * consumers can `switch` exhaustively instead of hand-copying strings out of
 * the README.
 */
export type PolicyRule =
  | "kill_switch"
  | "host_not_allowlisted"
  | "host_blocked"
  | "per_call_cap"
  | "velocity_circuit_breaker"
  | "budget_exhausted"
  | "insufficient_funds"
  | "human_approval_required"
  | "settlement_rejected";

/** Plain-English names for the rules, for anything a non-developer reads. */
export const RULE_LABELS: Record<PolicyRule, string> = {
  kill_switch: "Spending paused by you",
  host_not_allowlisted: "Site not on your approved list",
  host_blocked: "Site on your blocked list",
  per_call_cap: "Over your per-payment limit",
  velocity_circuit_breaker: "Too much, too fast",
  budget_exhausted: "Allowance used up",
  insufficient_funds: "Wallet is short of real funds",
  human_approval_required: "Waiting for your approval",
  settlement_rejected: "Payment refused by the seller",
};

export interface PolicyConfig {
  agentName: string;
  /** Hard ceiling on lifetime spend. Enforced alongside the funded amount: the agent can spend min(this, topups). */
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

/** Every field `allowance policy <field> <value>` accepts, with its shape. */
export const POLICY_FIELDS = {
  totalBudgetUsd: "usd",
  perCallMaxUsd: "usd",
  windowLimitUsd: "usd",
  windowSeconds: "seconds",
  requireApprovalAboveUsd: "usd",
  allowHostSuffixes: "host-list",
  blockedHosts: "host-list",
  killSwitch: "boolean",
  agentName: "string",
} as const;

export type PolicyField = keyof typeof POLICY_FIELDS;

/** The default agent's limits live in `config.json`; every other agent gets its own file. */
export function policyFileName(agentName?: string): string {
  return !agentName || agentName === defaultPolicy.agentName ? "config.json" : `config.${slug(agentName)}.json`;
}

/** Agent names reach the filesystem, so they are reduced to something that cannot escape it. */
export function slug(agentName: string): string {
  const cleaned = agentName.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return cleaned || "agent";
}

function nearest(field: string): string | undefined {
  const keys = Object.keys(POLICY_FIELDS);
  const lower = field.toLowerCase();
  return (
    keys.find((k) => k.toLowerCase() === lower) ??
    keys.find((k) => k.toLowerCase().startsWith(lower.slice(0, 6))) ??
    keys.find((k) => lower.startsWith(k.toLowerCase().slice(0, 6)))
  );
}

export class PolicyValidationError extends Error {}

/**
 * Rejects unknown fields, wrong types and impossible values *before* they are
 * written. A silently-accepted typo on the command that sets a spending limit
 * is the worst failure mode this library has.
 */
export function validatePolicyPatch(patch: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(patch)) {
    if (!(field in POLICY_FIELDS)) {
      const guess = nearest(field);
      throw new PolicyValidationError(
        `unknown policy field "${field}"${guess ? ` — did you mean "${guess}"?` : ""}\n` +
          `known fields: ${Object.keys(POLICY_FIELDS).join(", ")}`,
      );
    }
    const kind = POLICY_FIELDS[field as PolicyField];
    if (kind === "usd" || kind === "seconds") {
      if (typeof value !== "number" || !Number.isFinite(value))
        throw new PolicyValidationError(`${field} must be a number, got ${JSON.stringify(value)}`);
      if (value < 0) throw new PolicyValidationError(`${field} cannot be negative (got ${value})`);
      if (kind === "seconds" && value < 1)
        throw new PolicyValidationError(`${field} must be at least 1 second (got ${value})`);
    }
    if (kind === "host-list") {
      if (!Array.isArray(value) || value.some((h) => typeof h !== "string"))
        throw new PolicyValidationError(`${field} must be a list of hostnames, got ${JSON.stringify(value)}`);
    }
    if (kind === "boolean" && typeof value !== "boolean")
      throw new PolicyValidationError(`${field} must be true or false, got ${JSON.stringify(value)}`);
  }
}

/**
 * Non-fatal configuration warnings: combinations where one rail silently
 * shadows another, so a rule the human thinks they armed can never fire.
 */
export function policyWarnings(p: RuntimePolicy): string[] {
  const out: string[] = [];
  if (p.requireApprovalAboveUsd >= p.perCallMaxUsd)
    out.push(
      `the approval gate can never fire: requireApprovalAboveUsd ($${p.requireApprovalAboveUsd.toFixed(2)}) is not below ` +
        `perCallMaxUsd ($${p.perCallMaxUsd.toFixed(2)}), so anything big enough to need your approval is hard-blocked first. ` +
        `Lower requireApprovalAboveUsd or raise perCallMaxUsd.`,
    );
  if (p.windowLimitUsd >= p.totalBudgetUsd)
    out.push(
      `the velocity breaker will usually trip before the total budget: windowLimitUsd ($${p.windowLimitUsd.toFixed(2)}) ` +
        `is not below totalBudgetUsd ($${p.totalBudgetUsd.toFixed(2)}), so spend is reported as "too fast" rather than "out of money".`,
    );
  if (p.allowHostSuffixes.includes("*"))
    out.push(`allowHostSuffixes contains "*" — the host allowlist is disabled and the agent may pay any host.`);
  return out;
}

export class PolicyStore {
  private file: string;

  /**
   * Limits are per agent, but the first agent in a directory keeps the
   * unsuffixed `config.json` so a state dir written by an earlier version
   * still reads back with the same limits.
   */
  constructor(stateDir: string, agentName?: string) {
    fs.mkdirSync(stateDir, { recursive: true });
    this.file = path.join(stateDir, policyFileName(agentName));
    if (!fs.existsSync(this.file))
      fs.writeFileSync(this.file, JSON.stringify({ ...defaultPolicy, agentName: agentName ?? defaultPolicy.agentName }, null, 2));
  }

  load(): RuntimePolicy {
    const cfg = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<RuntimePolicy>;
    return { ...defaultPolicy, killSwitch: false, ...cfg };
  }

  save(patch: Partial<RuntimePolicy>): void {
    validatePolicyPatch(patch as Record<string, unknown>);
    const next = { ...this.load(), ...patch };
    fs.writeFileSync(this.file, JSON.stringify(next, null, 2));
  }
}

export type PolicyDecision =
  | { allowed: true }
  | {
      allowed: false;
      rule: PolicyRule;
      detail: string;
      /** True when retrying later, cheaper, or after a human decision can succeed. */
      recoverable: boolean;
      requestId?: string;
      /** The price the seller quoted, so an agent can decide how far over it was. */
      quotedMicro?: bigint;
      /** The limit that refused it, in the same units. */
      capMicro?: bigint;
      /** For time-based rails: how long to wait before the same call could pass. */
      retryAfterMs?: number;
    };

export interface PolicyContext {
  host: string;
  amountMicro: bigint;
  spendTotalMicro: bigint;
  topupsMicro: bigint;
  windowSpendMicro: bigint;
  /**
   * Live rails only: what the payer wallet actually holds on-chain, minus
   * anything already authorized and not yet settled. Left undefined on
   * practice money and whenever the chain could not be read, in which case the
   * allowance ledger is the only ceiling.
   */
  walletBalanceMicro?: bigint;
}

/** The spendable ceiling: you can never exceed what you funded, nor the configured budget. */
export function effectiveBudgetMicro(policy: RuntimePolicy, topupsMicro: bigint): bigint {
  const configured = usd(policy.totalBudgetUsd);
  return configured < topupsMicro ? configured : topupsMicro;
}

export function evaluatePolicy(policy: RuntimePolicy, ctx: PolicyContext): PolicyDecision {
  if (policy.killSwitch)
    return {
      allowed: false,
      rule: "kill_switch",
      detail: "human paused all spending for this agent",
      recoverable: true,
    };

  const bare = ctx.host.split(":")[0].toLowerCase();
  const matches = (suffix: string) => suffix === "*" || bare === suffix || bare.endsWith("." + suffix);
  if (!policy.allowHostSuffixes.some(matches))
    return {
      allowed: false,
      rule: "host_not_allowlisted",
      detail: `"${bare}" not in allowHostSuffixes [${policy.allowHostSuffixes.join(", ")}]`,
      recoverable: false,
      quotedMicro: ctx.amountMicro,
    };
  if (policy.blockedHosts.some(matches))
    return {
      allowed: false,
      rule: "host_blocked",
      detail: `"${bare}" appears in blockedHosts`,
      recoverable: false,
      quotedMicro: ctx.amountMicro,
    };

  const perCallCap = usd(policy.perCallMaxUsd);
  if (ctx.amountMicro > perCallCap)
    return {
      allowed: false,
      rule: "per_call_cap",
      detail: `price ${fmtUsd(ctx.amountMicro)} exceeds per-call cap of $${policy.perCallMaxUsd.toFixed(2)}`,
      recoverable: false,
      quotedMicro: ctx.amountMicro,
      capMicro: perCallCap,
    };

  const windowCap = usd(policy.windowLimitUsd);
  if (ctx.windowSpendMicro + ctx.amountMicro > windowCap)
    return {
      allowed: false,
      rule: "velocity_circuit_breaker",
      detail: `rolling ${policy.windowSeconds}s spend would exceed $${policy.windowLimitUsd.toFixed(2)} limit`,
      recoverable: true,
      quotedMicro: ctx.amountMicro,
      capMicro: windowCap,
      retryAfterMs: policy.windowSeconds * 1000,
    };

  const budget = effectiveBudgetMicro(policy, ctx.topupsMicro);
  const remaining = budget - ctx.spendTotalMicro;
  if (remaining < ctx.amountMicro) {
    const boundByConfig = usd(policy.totalBudgetUsd) < ctx.topupsMicro;
    return {
      allowed: false,
      rule: "budget_exhausted",
      detail:
        `remaining allowance ${fmtUsd(remaining < 0n ? 0n : remaining)} is below the ${fmtUsd(ctx.amountMicro)} price ` +
        (boundByConfig
          ? `(capped by totalBudgetUsd $${policy.totalBudgetUsd.toFixed(2)}; ${fmtUsd(ctx.topupsMicro)} funded)`
          : `(${fmtUsd(ctx.topupsMicro)} funded — top up with \`allowance topup <usd>\`)`),
      recoverable: true,
      quotedMicro: ctx.amountMicro,
      capMicro: budget,
    };
  }

  if (ctx.walletBalanceMicro !== undefined && ctx.walletBalanceMicro < ctx.amountMicro)
    return {
      allowed: false,
      rule: "insufficient_funds",
      detail:
        `the wallet holds ${fmtUsd(ctx.walletBalanceMicro < 0n ? 0n : ctx.walletBalanceMicro)} of spendable USDC, ` +
        `below the ${fmtUsd(ctx.amountMicro)} price. The allowance allows this payment; the wallet cannot cover it. ` +
        `Send USDC to the agent's wallet.`,
      recoverable: true,
      quotedMicro: ctx.amountMicro,
      capMicro: ctx.walletBalanceMicro < 0n ? 0n : ctx.walletBalanceMicro,
    };

  return { allowed: true };
}
