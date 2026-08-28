#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createAgent, decideApproval, allowanceRemaining, topUp } from "./wallet.ts";
import { startDashboard } from "./dashboard-server.ts";
import { fmtUsd, fmtUsdSmart } from "./money.ts";
import { POLICY_FIELDS, PolicyValidationError, RULE_LABELS, policyWarnings, type PolicyField } from "./policy.ts";
import { runDemo } from "./demo-run.ts";
import type { LedgerEvent } from "./ledger.ts";

const CLI = "npx allowance-kit";
const PRACTICE = "Practice money — this is a local simulated ledger, no real money can move";

const HELP = `allowance-kit — a spending allowance for your AI agent

Getting started
  ${CLI} init                    create the agent's wallet
  ${CLI} topup 5.00              fund the allowance
  ${CLI} demo                    watch the whole thing work, end to end
  ${CLI} dashboard               live spending, kill switch, approvals

Commands
  init                            provision the agent wallet in ./.allowance
  topup <usd>                     add to the allowance
  status                          what is left, what the limits are, what needs you
  policy                          show every limit
  policy <field> <value>          change one limit
  approvals                       payments waiting for your decision
  approve <id> | deny <id>        decide one
  audit [--json]                  the full spending history
  dashboard [--port <n>]          live dashboard (default http://localhost:4030)
  demo                            run the built-in demo into ./.allowance-demo

Limits you can set with \`policy\`
  totalBudgetUsd <usd>            hard lifetime cap on this agent's spending
  perCallMaxUsd <usd>             most it may pay for any single call
  windowLimitUsd <usd>            most it may spend inside a rolling window
  windowSeconds <n>               how long that window is
  requireApprovalAboveUsd <usd>   payments this size or larger wait for you
  allowHostSuffixes <hosts>       only these sites (comma-separated)
  blockedHosts <hosts>            never these sites (comma-separated)
  killSwitch true|false           freeze or unfreeze all spending

Options
  --state <dir>                   state directory (default ./.allowance)
  --port <n>                      dashboard port (default 4030)
  --json                          machine-readable output where offered
  -h, --help                      this text
  -v, --version                   print the version

Examples
  ${CLI} policy perCallMaxUsd 0.10
  ${CLI} policy allowHostSuffixes api.weather.com,api.search.com
  ${CLI} policy killSwitch true            # freeze everything, right now`;

interface Flags {
  state: string;
  port: number;
  json: boolean;
  rest: string[];
}

function parseFlags(argv: string[]): Flags {
  const rest: string[] = [];
  let state = process.env.ALLOWANCE_STATE_DIR ?? ".allowance";
  let port = 4030;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--state" || a === "--state-dir") state = required(argv[++i], "--state <dir>");
    else if (a.startsWith("--state=")) state = a.slice(8);
    else if (a === "--port") port = Number(required(argv[++i], "--port <n>"));
    else if (a.startsWith("--port=")) port = Number(a.slice(7));
    else if (a === "--json") json = true;
    else rest.push(a);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UserError(`--port must be a number between 1 and 65535`);
  return { state: path.resolve(state), port, json, rest };
}

function required(value: string | undefined, usage: string): string {
  if (value === undefined) throw new UserError(`missing value for ${usage}`);
  return value;
}

/** An error caused by how the command was typed — printed plainly, without a stack. */
class UserError extends Error {}

function version(): string {
  for (const rel of ["../package.json", "../../package.json"]) {
    try {
      const file = path.join(import.meta.dirname ?? ".", rel);
      return (JSON.parse(fs.readFileSync(file, "utf8")) as { version: string }).version;
    } catch {}
  }
  return "unknown";
}

function agent(stateDir: string) {
  return createAgent(stateDir);
}

function ago(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

function shortPath(url: string): string {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch {
    return url;
  }
}

/** Parses a policy value from the command line into the shape that field expects. */
function parsePolicyValue(field: string, raw: string): unknown {
  const kind = POLICY_FIELDS[field as PolicyField];
  if (kind === "host-list") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
      try {
        return JSON.parse(trimmed);
      } catch {
        throw new UserError(
          `could not read ${field} as a JSON list.\n` +
            `Simplest form:  ${CLI} policy ${field} api.example.com,another.com`,
        );
      }
    }
    return trimmed
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean);
  }
  if (kind === "boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new UserError(`${field} must be true or false, got "${raw}"`);
  }
  if (kind === "usd" || kind === "seconds") {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new UserError(`${field} must be a number, got "${raw}"`);
    return n;
  }
  return raw;
}

function describeValue(field: string, value: unknown): string {
  const kind = POLICY_FIELDS[field as PolicyField];
  if (kind === "usd") return `$${Number(value).toFixed(2)}`;
  if (kind === "seconds") return `${value}s`;
  if (kind === "host-list") return (value as string[]).length ? (value as string[]).join(", ") : "(none)";
  return String(value);
}

function printWarnings(warnings: string[]): void {
  for (const w of warnings) console.log(`\n  ! ${w}`);
}

function auditLine(e: LedgerEvent): string {
  const t = new Date(e.at).toLocaleTimeString();
  switch (e.t) {
    case "topup":
      return `${t}  TOPUP    ${fmtUsdSmart(BigInt(e.amountMicro)).padStart(9)}  added to the allowance`;
    case "payment":
      return `${t}  PAID     ${fmtUsdSmart(BigInt(e.amountMicro)).padStart(9)}  ${shortPath(e.url).padEnd(38)} ${String(e.txHash).slice(0, 12)}…`;
    case "blocked":
      return `${t}  BLOCKED  ${fmtUsdSmart(BigInt(e.attemptedMicro)).padStart(9)}  ${shortPath(e.url).padEnd(38)} ${RULE_LABELS[e.rule as keyof typeof RULE_LABELS] ?? e.rule}`;
    case "policy_change":
      return `${t}  LIMIT    ${"".padStart(9)}  ${e.field} changed to ${describeValue(e.field, e.value)}`;
    case "approval_requested":
      return `${t}  ASKED    ${fmtUsdSmart(BigInt(e.amountMicro)).padStart(9)}  ${shortPath(e.url).padEnd(38)} waiting for you (${e.id})`;
    case "approval_decided":
      return `${t}  ${e.approved ? "OK'D    " : "DENIED  "} ${fmtUsdSmart(BigInt(e.amountMicro)).padStart(9)}  ${e.host.padEnd(38)} you decided (${e.id})`;
  }
}

async function main(): Promise<void> {
  const [, , cmd, ...rawArgs] = process.argv;

  if (cmd === undefined || cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(HELP);
    return;
  }
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    console.log(version());
    return;
  }

  const flags = parseFlags(rawArgs);
  const args = flags.rest;
  const stateDir = flags.state;

  switch (cmd) {
    case "init": {
      const existed = fs.existsSync(path.join(stateDir, "agent.json"));
      const rt = agent(stateDir);
      console.log(`${existed ? "using existing" : "created"} agent wallet ${rt.address}`);
      console.log(`mode        ${PRACTICE}`);
      console.log(`limits file ${path.join(stateDir, "config.json")}`);
      console.log(`\nnext: ${CLI} topup 5.00`);
      break;
    }

    case "topup": {
      const amount = Number(args[0]);
      if (!args.length) throw new UserError(`how much? e.g.  ${CLI} topup 5.00`);
      if (!Number.isFinite(amount) || amount <= 0)
        throw new UserError(`top-up must be a positive dollar amount, got "${args[0]}" — e.g. ${CLI} topup 5.00`);
      const rt = agent(stateDir);
      const remaining = topUp(rt, amount, "human::cli");
      console.log(`added ${fmtUsd(BigInt(Math.round(amount * 1e6)))} to the allowance`);
      console.log(`the agent can now spend up to ${fmtUsd(remaining)}`);
      console.log(`mode  ${PRACTICE}`);
      break;
    }

    case "status": {
      const rt = agent(stateDir);
      const p = rt.policy();
      const totals = rt.ledger.totals(rt.agentName, 0);
      const remaining = allowanceRemaining(rt);
      const pending = rt.approvals.pending();
      const funded = totals.topupsMicro;

      console.log(`agent          ${rt.agentName}  (wallet ${rt.address.slice(0, 10)}…${rt.address.slice(-4)})`);
      console.log(`mode           ${PRACTICE}`);
      if (funded === 0n) {
        console.log(`allowance      nothing funded yet — run: ${CLI} topup 5.00`);
      } else {
        const cap = fmtUsd(funded) === `$${p.totalBudgetUsd.toFixed(2)}` ? fmtUsd(funded) : `${fmtUsd(funded)} funded, capped at $${p.totalBudgetUsd.toFixed(2)}`;
        console.log(`allowance      ${fmtUsd(remaining)} left of ${cap}`);
        console.log(`spent          ${fmtUsdSmart(totals.spendTotalMicro)} across ${totals.payments} payments · ${totals.blocks} blocked`);
      }
      console.log(
        `limits         at most $${p.perCallMaxUsd.toFixed(2)} per payment · $${p.windowLimitUsd.toFixed(2)} per ${p.windowSeconds}s · your approval needed at $${p.requireApprovalAboveUsd.toFixed(2)}+`,
      );
      console.log(`sites          only ${p.allowHostSuffixes.join(", ")}${p.blockedHosts.length ? ` · never ${p.blockedHosts.join(", ")}` : ""}`);
      console.log(
        p.killSwitch
          ? `spending       FROZEN by you — resume with: ${CLI} policy killSwitch false`
          : `spending       active — freeze everything with: ${CLI} policy killSwitch true`,
      );
      if (pending.length) {
        const first = pending[0];
        console.log(
          `waiting on you ${pending.length} payment${pending.length > 1 ? "s" : ""} — ` +
            `${fmtUsdSmart(BigInt(first.amountMicro))} to ${first.host}${pending.length > 1 ? " and others" : ""}  (see: ${CLI} approvals)`,
        );
      }
      printWarnings(policyWarnings(p));
      break;
    }

    case "policy": {
      const rt = agent(stateDir);
      const [field, ...rest] = args;
      if (!field) {
        const p = rt.policy();
        for (const key of Object.keys(POLICY_FIELDS)) {
          if (key === "agentName") continue;
          console.log(`  ${key.padEnd(24)} ${describeValue(key, p[key as keyof typeof p])}`);
        }
        printWarnings(policyWarnings(p));
        break;
      }
      if (!(field in POLICY_FIELDS)) {
        const guess = Object.keys(POLICY_FIELDS).find((k) => k.toLowerCase() === field.toLowerCase());
        throw new UserError(
          `unknown limit "${field}"${guess ? ` — did you mean "${guess}"?` : ""}\n` +
            `you can set: ${Object.keys(POLICY_FIELDS).filter((k) => k !== "agentName").join(", ")}`,
        );
      }
      if (!rest.length) throw new UserError(`what should ${field} be? e.g.  ${CLI} policy ${field} <value>`);

      const before = rt.policy();
      const value = parsePolicyValue(field, rest.join(" "));
      rt.policyStore.save({ [field]: value });
      rt.ledger.append({ t: "policy_change", at: new Date().toISOString(), agent: rt.agentName, field, value });
      console.log(
        `${field}: ${describeValue(field, before[field as keyof typeof before])} → ${describeValue(field, value)}` +
          `   (takes effect on the agent's next call)`,
      );
      printWarnings(policyWarnings(rt.policy()));
      break;
    }

    case "approvals": {
      const rt = agent(stateDir);
      const pending = rt.approvals.pending();
      if (!pending.length) {
        console.log("no payments waiting on you");
        break;
      }
      for (const r of pending) {
        console.log(`${fmtUsdSmart(BigInt(r.amountMicro))} → ${shortPath(r.url)}   (asked ${ago(r.at)})`);
        console.log(`    approve: ${CLI} approve ${r.id}    ·    deny: ${CLI} deny ${r.id}\n`);
      }
      break;
    }

    case "approve":
    case "deny": {
      const id = args[0];
      if (!id) throw new UserError(`which one? list them with:  ${CLI} approvals`);
      const rt = agent(stateDir);
      const req = rt.approvals.pending().find((r) => r.id === id);
      if (!decideApproval(rt, id, cmd === "approve"))
        throw new UserError(`no payment is waiting under id "${id}" — list them with: ${CLI} approvals`);
      if (cmd === "approve") {
        console.log(`approved ${fmtUsdSmart(BigInt(req?.amountMicro ?? "0"))} to ${req?.host ?? "that site"}.`);
        console.log(`nothing has moved yet — the agent completes this payment on its next attempt.`);
      } else {
        console.log(`denied. The agent will keep being blocked on that payment.`);
      }
      break;
    }

    case "audit": {
      const rt = agent(stateDir);
      const events = rt.ledger.read();
      if (flags.json) {
        for (const e of events) console.log(JSON.stringify(e));
        break;
      }
      if (!events.length) {
        console.log(`nothing has happened yet. Start with:  ${CLI} topup 5.00`);
        break;
      }
      for (const e of events) console.log(auditLine(e));
      console.log(`\n${events.length} entries · full machine-readable log: ${CLI} audit --json`);
      break;
    }

    case "demo": {
      const demoDir = flags.rest[0] ? path.resolve(flags.rest[0]) : path.resolve(".allowance-demo");
      await runDemo(demoDir);
      break;
    }

    case "dashboard": {
      const rt = agent(stateDir);
      const port = args[0] ? Number(args[0]) : flags.port;
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UserError(`"${args[0]}" is not a port number`);
      try {
        await startDashboard(rt, port);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EADDRINUSE")
          throw new UserError(
            `port ${port} is already in use — another dashboard may already be running.\n` +
              `Try:  ${CLI} dashboard --port ${port + 1}`,
          );
        throw e;
      }
      console.log(`dashboard → http://localhost:${port}`);
      console.log(`watching  ${stateDir}`);
      console.log(`the kill switch and approval buttons are protected by a local token in ${path.join(stateDir, "dashboard-token")}`);
      console.log(`press Ctrl-C to stop`);
      setInterval(() => undefined, 1 << 30);
      break;
    }

    default:
      throw new UserError(`unknown command "${cmd}" — run \`${CLI} --help\` to see what's available`);
  }
}

main().catch((e) => {
  if (e instanceof UserError || e instanceof PolicyValidationError) console.error(e.message);
  else console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
