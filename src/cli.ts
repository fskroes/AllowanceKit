#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createAgent, decideApproval, allowanceRemaining, listAgents, topUp, DEFAULT_AGENT_NAME } from "./wallet.ts";
import { startDashboard } from "./dashboard-server.ts";
import { fmtUsd, fmtUsdSmart, usd } from "./money.ts";
import { POLICY_FIELDS, PolicyValidationError, RULE_LABELS, policyFileName, policyWarnings, type PolicyField } from "./policy.ts";
import { runDemo } from "./demo-run.ts";
import {
  deliver,
  deliverCloud,
  providerEnvVar,
  startHeartbeat,
  cloudWhoami,
  NotifyStore,
  CLOUD_ENV,
  CLOUD_DEFAULT_URL,
} from "./notify.ts";
import { describeMode, describeTopUp, readMode } from "./mode.ts";
import { NETWORKS, createLiveAgent } from "./live.ts";
import { runtimeVersion } from "./version.ts";
import { usdcBalanceMicro, RPC_DEFAULTS } from "./usdc.ts";
import { payingFetch } from "./payer.ts";
import { DEFAULT_GRANT_TTL_MS } from "./approvals.ts";
import type { LedgerEvent } from "./ledger.ts";
import { CLI, NAME } from "./cli-name.ts";

const HELP = `${NAME} — a spending allowance for your AI agent

Getting started
  ${CLI} init                    create the agent's wallet
  ${CLI} topup 5.00              fund the allowance
  ${CLI} demo                    watch the whole thing work, end to end
  ${CLI} dashboard               live spending, kill switch, approvals

Commands
  init                            provision the agent wallet in ./.allowance
  init --live [--network <net>]   provision for REAL MONEY on a live network (see below)
  topup <usd>                     add to the allowance
  pay <url>                       make one payment to an x402 URL, print the result
  doctor                          check your setup: node, viem, keys, RPC, permissions
  status                          what is left, what the limits are, what needs you
  policy                          show every limit
  policy <field> <value>          change one limit
  approvals                       payments waiting for your decision, and live grants
  approve <id> | deny <id>        decide one
  audit [--json]                  the full spending history
  notify                          where alerts are sent, and on what
  agents                          every agent sharing this state directory
  dashboard [--port <n>]          live dashboard (default http://localhost:4030)
  demo                            run the built-in demo into ./.allowance-demo

Real money in five commands (Base Sepolia is free testnet USDC)
  export AGENT_PRIVATE_KEY=0x...           your wallet key — read from the env, never stored
  ${CLI} init --live                  mark this directory live, print the wallet address
  # send USDC to that address, then:
  ${CLI} topup 5.00                   set the ceiling the agent may spend
  ${CLI} pay https://api.example.com/paid   make a real payment
  Mainnet (real money): ${CLI} init --live --network base   (asks you to confirm)

Limits you can set with \`policy\`
  totalBudgetUsd <usd>            hard lifetime cap on this agent's spending
  perCallMaxUsd <usd>             most it may pay for any single call
  windowLimitUsd <usd>            most it may spend inside a rolling window
  windowSeconds <n>               how long that window is
  requireApprovalAboveUsd <usd>   payments this size or larger wait for you
  allowHostSuffixes <hosts>       only these sites (comma-separated)
  blockedHosts <hosts>            never these sites (comma-separated)
  killSwitch true|false           freeze or unfreeze all spending

Approving
  approve <id>                    covers exactly that payment, for 24 hours
  approve <id> --budget 2.00      let the grant cover $2.00 of spend to that host
  approve <id> --expires 2h       or 30m, 7d, never

Alerts you can set with \`notify\`
  notify webhook <url>            POST every alert to Slack, Discord, Zapier, you
  notify email <address>          mail every alert (needs a provider key, see below)
  notify sms +31612345678         text every alert (needs Twilio keys, see below)
  notify push <topic>             phone push over ntfy.sh — no account needed
  notify cloud <workspace-key>    send every decision + a heartbeat to Wallie Cloud
  notify heartbeat <url>          ping a dead-man's switch while the agent runs
  notify test                     send one of each, right now, and report delivery
  notify off                      stop sending anything

Options
  --state <dir>                   state directory (default ./.allowance)
  --agent <name>                  which agent in that directory (default ${DEFAULT_AGENT_NAME})
  --port <n>                      dashboard port (default 4030)
  --json                          machine-readable output where offered
  --from <email|number>           verified sender for notify email / sms
  --via <resend|postmark>         email provider (default resend)
  --budget <usd>                  spend an approval grant may cover
  --expires <30m|2h|7d|never>     how long an approval grant lasts
  --network <base-sepolia|base>   live network for init --live (default base-sepolia)
  --rpc <url>                     override the JSON-RPC endpoint for balance reads
  --method <GET|POST>             HTTP method for pay (default GET, or POST with --body)
  --body <json>                   request body for pay
  --yes, -y                       skip the mainnet confirmation prompt (for scripts)
  -h, --help                      this text
  -v, --version                   print the version

Examples
  ${CLI} policy perCallMaxUsd 0.10
  ${CLI} policy allowHostSuffixes api.weather.com,api.search.com
  ${CLI} policy killSwitch true            # freeze everything, right now
  ${CLI} notify webhook https://hooks.slack.com/services/...
  ${CLI} notify email you@example.com --from alerts@yourdomain.com
  ${CLI} status --agent writer-agent       # a second agent, same directory

Keys live in your environment, never in a config file:
  RESEND_API_KEY=...      for --via resend (the default)
  POSTMARK_API_TOKEN=...  for --via postmark
  TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... TWILIO_FROM=+1...   for notify sms`;

interface Flags {
  state: string;
  agent: string;
  port: number;
  json: boolean;
  from?: string;
  via?: string;
  budget?: number;
  expires?: string;
  live: boolean;
  network?: string;
  rpc?: string;
  yes: boolean;
  method?: string;
  body?: string;
  rest: string[];
}

function parseFlags(argv: string[]): Flags {
  const rest: string[] = [];
  let state = process.env.ALLOWANCE_STATE_DIR ?? ".allowance";
  let agentName = process.env.ALLOWANCE_AGENT ?? DEFAULT_AGENT_NAME;
  let port = 4030;
  let json = false;
  let from: string | undefined;
  let via: string | undefined;
  let budget: number | undefined;
  let expires: string | undefined;
  let live = false;
  let network: string | undefined;
  let rpc: string | undefined;
  let yes = false;
  let method: string | undefined;
  let body: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--state" || a === "--state-dir") state = required(argv[++i], "--state <dir>");
    else if (a.startsWith("--state=")) state = a.slice(8);
    else if (a === "--agent") agentName = required(argv[++i], "--agent <name>");
    else if (a.startsWith("--agent=")) agentName = a.slice(8);
    else if (a === "--port") port = Number(required(argv[++i], "--port <n>"));
    else if (a.startsWith("--port=")) port = Number(a.slice(7));
    else if (a === "--json") json = true;
    else if (a === "--from") from = required(argv[++i], "--from <email>");
    else if (a.startsWith("--from=")) from = a.slice(7);
    else if (a === "--via") via = required(argv[++i], "--via <resend|postmark>");
    else if (a.startsWith("--via=")) via = a.slice(6);
    else if (a === "--budget") budget = Number(required(argv[++i], "--budget <usd>"));
    else if (a.startsWith("--budget=")) budget = Number(a.slice(9));
    else if (a === "--expires") expires = required(argv[++i], "--expires <duration>");
    else if (a.startsWith("--expires=")) expires = a.slice(10);
    else if (a === "--live") live = true;
    else if (a === "--network" || a === "--net") network = required(argv[++i], "--network <net>");
    else if (a.startsWith("--network=")) network = a.slice(10);
    else if (a === "--rpc") rpc = required(argv[++i], "--rpc <url>");
    else if (a.startsWith("--rpc=")) rpc = a.slice(6);
    else if (a === "--yes" || a === "-y") yes = true;
    else if (a === "--method") method = required(argv[++i], "--method <GET|POST>");
    else if (a.startsWith("--method=")) method = a.slice(9);
    else if (a === "--body") body = required(argv[++i], "--body <json>");
    else if (a.startsWith("--body=")) body = a.slice(7);
    else rest.push(a);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UserError(`--port must be a number between 1 and 65535`);
  if (budget !== undefined && (!Number.isFinite(budget) || budget <= 0))
    throw new UserError(`--budget must be a positive dollar amount`);
  if (!agentName.trim()) throw new UserError(`--agent needs a name`);
  return { state: path.resolve(state), agent: agentName.trim(), port, json, from, via, budget, expires, live, network, rpc, yes, method, body, rest };
}

function required(value: string | undefined, usage: string): string {
  if (value === undefined) throw new UserError(`missing value for ${usage}`);
  return value;
}

/** An error caused by how the command was typed — printed plainly, without a stack. */
class UserError extends Error {}

function version(): string {
  return runtimeVersion();
}

function agent(stateDir: string, agentName = DEFAULT_AGENT_NAME) {
  return createAgent(stateDir, agentName);
}

/** `30m`, `2h`, `7d`, or `never`. Returns milliseconds, or null for "no expiry". */
function parseDuration(raw: string): number | null {
  const text = raw.trim().toLowerCase();
  if (text === "never" || text === "forever") return null;
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/.exec(text);
  if (!m) throw new UserError(`could not read "${raw}" as a duration — try 30m, 2h, 7d, or never`);
  const units = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return Math.round(Number(m[1]) * units[m[2] as keyof typeof units]);
}

/** Largest unit that reads naturally. A grant with 7,199,812ms left has "2h" left. */
function describeDuration(ms: number): string {
  const round = (n: number) => (Math.round(n * 10) / 10).toString();
  if (ms >= 86_400_000) return `${round(ms / 86_400_000)}d`;
  if (ms >= 3_600_000) return `${round(ms / 3_600_000)}h`;
  if (ms >= 60_000) return `${round(ms / 60_000)} min`;
  return `${Math.round(ms / 1000)}s`;
}

/** What the wallet actually holds, for a state dir wired to a live network. */
async function liveWalletLine(stateDir: string): Promise<string | undefined> {
  const mode = readMode(stateDir);
  if (mode.mode !== "live" || !mode.address || !mode.network) return undefined;
  const info = NETWORKS[mode.network];
  const rpc = mode.rpcUrl;
  if (!info || !rpc) return `wallet         ${mode.address} on ${mode.network} (balance unreadable: no RPC configured)`;
  try {
    const balance = await usdcBalanceMicro(rpc, info.usdc, mode.address);
    return `wallet         ${fmtUsd(balance)} USDC on ${mode.network}  (${mode.address})`;
  } catch (e) {
    return `wallet         ${mode.address} on ${mode.network} — balance unreadable: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** The payer's wallet key, read from the environment only — never from disk. */
function requireLiveKey(): string {
  const key = process.env.AGENT_PRIVATE_KEY;
  if (!key || !key.trim())
    throw new UserError(
      `live mode needs your wallet's private key in the environment:\n` +
        `  export AGENT_PRIVATE_KEY=0x...\n` +
        `It is read from the environment only — ${NAME} never writes it to any file.`,
    );
  return key.trim();
}

/** Ask once, on a real terminal, before anything touches Base mainnet. */
async function promptLine(question: string): Promise<string> {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** Mainnet is not practice: it takes a `--yes`, or typing the network name back. */
async function confirmMainnet(network: string, yes: boolean): Promise<void> {
  if (network !== "base" || yes) return;
  if (!process.stdin.isTTY)
    throw new UserError(
      `REAL MONEY — this signs USDC payments on Base mainnet, not practice.\n` +
        `Re-run with --yes to confirm in a script, or run it in a terminal to confirm by hand.`,
    );
  const answer = await promptLine(`REAL MONEY — payments will settle on Base mainnet.\nType "base" to confirm: `);
  if (answer.trim() !== "base") throw new UserError(`not confirmed — nothing was changed.`);
}

/** `init --live`: derive the payer address, mark the directory live, keep the key out of it. */
async function initLive(stateDir: string, flags: Flags): Promise<void> {
  const network = flags.network ?? "base-sepolia";
  if (!(network in NETWORKS))
    throw new UserError(`unknown network "${network}" — known: ${Object.keys(NETWORKS).join(", ")}`);
  const existing = readMode(stateDir);
  if (existing.mode === "live" && existing.network && existing.network !== network)
    throw new UserError(
      `${stateDir} is already live on ${existing.network}.\n` +
        `Use a separate --state directory for ${network}, or delete ${path.join(stateDir, "mode.json")} to re-point this one.`,
    );
  const key = requireLiveKey();
  await confirmMainnet(network, flags.yes);

  let live;
  try {
    live = await createLiveAgent({ stateDir, agentName: flags.agent, privateKey: key, network, rpcUrl: flags.rpc });
  } catch (e) {
    // viem missing, a malformed key, or an unknown network — surface it plainly.
    throw new UserError(e instanceof Error ? e.message : String(e));
  }

  console.log(describeMode(readMode(stateDir)));
  console.log(`agent    ${live.agentName}`);
  console.log(`wallet   ${live.address}`);
  console.log(`network  ${network}${flags.rpc ? ` (rpc ${hostOfUrl(flags.rpc)})` : ""}`);
  console.log(`\nFund it — send USDC to this address on ${network}:`);
  console.log(`  ${live.address}`);
  console.log(`Set the spending ceiling:  ${CLI} topup 5.00`);
  console.log(`See the balance and limits: ${CLI} status`);
  console.log(`Make one real payment:      ${CLI} pay <url>`);
}

function ago(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

function hostOfUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
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
      if (flags.live) {
        await initLive(stateDir, flags);
        break;
      }
      const existed = fs.existsSync(path.join(stateDir, "agent.json"));
      const rt = agent(stateDir, flags.agent);
      const mode = readMode(stateDir);
      console.log(`${existed ? "using existing" : "created"} agent wallet ${rt.address}`);
      console.log(`agent       ${rt.agentName}`);
      console.log(`mode        ${describeMode(mode)}`);
      console.log(`limits file ${path.join(stateDir, policyFileName(rt.agentName))}`);
      console.log(`\nnext: ${CLI} topup 5.00`);
      break;
    }

    case "topup": {
      const amount = Number(args[0]);
      if (!args.length) throw new UserError(`how much? e.g.  ${CLI} topup 5.00`);
      if (!Number.isFinite(amount) || amount <= 0)
        throw new UserError(`top-up must be a positive dollar amount, got "${args[0]}" — e.g. ${CLI} topup 5.00`);
      const rt = agent(stateDir, flags.agent);
      const mode = readMode(stateDir);
      if (mode.mode === "live" && mode.network === "base" && amount > 50 && !flags.yes)
        throw new UserError(
          `REAL MONEY — raising the ceiling to ${fmtUsd(usd(amount))} on Base mainnet.\n` +
            `Re-run with --yes to confirm. (Amounts up to $50.00 do not need it.)`,
        );
      const remaining = topUp(rt, amount, "human::cli");
      console.log(`added ${fmtUsd(usd(amount))} to ${rt.agentName}'s allowance`);
      console.log(`the agent can now spend up to ${fmtUsd(remaining)}`);
      console.log(`mode  ${describeTopUp(mode)}`);
      if (mode.mode === "live") {
        const wallet = await liveWalletLine(stateDir);
        if (wallet) console.log(wallet.replace(/^wallet\s+/, "wallet  "));
      }
      break;
    }

    case "status": {
      const rt = agent(stateDir, flags.agent);
      const p = rt.policy();
      const totals = rt.ledger.totals(rt.agentName, 0);
      const remaining = allowanceRemaining(rt);
      const pending = rt.approvals.pending();
      const funded = totals.topupsMicro;

      console.log(`agent          ${rt.agentName}  (wallet ${rt.address.slice(0, 10)}…${rt.address.slice(-4)})`);
      console.log(`mode           ${describeMode(readMode(stateDir))}`);
      const walletLine = await liveWalletLine(stateDir);
      if (walletLine) console.log(walletLine);
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
      const grants = rt.approvals.activeGrants();
      if (grants.length)
        console.log(
          `grants         ${grants.length} live approval${grants.length > 1 ? "s" : ""} — ` +
            grants
              .map((g) => `${fmtUsdSmart(rt.approvals.remainingMicro(g))} left for ${g.host}`)
              .slice(0, 3)
              .join(", "),
        );
      const failures = rt.notifyStore.recentFailures(1);
      if (failures.length)
        console.log(`alerts         last delivery failed: ${failures[0].channel} — ${failures[0].detail}`);
      const cloudCfg = rt.notifyStore.load().cloud;
      if (cloudCfg?.enabled) {
        if (process.env[cloudCfg.keyEnv]) {
          const who = await cloudWhoami(cloudCfg);
          console.log(
            who.ok
              ? `cloud          connected as ${who.workspace ?? "your workspace"}`
              : `cloud          ${hostOfUrl(cloudCfg.url)} — ${who.detail}`,
          );
        } else {
          console.log(`cloud          ${hostOfUrl(cloudCfg.url)} — ${cloudCfg.keyEnv} is NOT set, nothing will send`);
        }
      }
      printWarnings(policyWarnings(p));
      break;
    }

    case "agents": {
      const names = listAgents(stateDir);
      if (!names.length) {
        console.log(`no agents in ${stateDir} yet. Start with:  ${CLI} init`);
        break;
      }
      for (const name of names) {
        const rt = agent(stateDir, name);
        const totals = rt.ledger.totals(name, 0);
        const mark = name === flags.agent ? "*" : " ";
        console.log(
          `${mark} ${name.padEnd(20)} ${fmtUsd(allowanceRemaining(rt)).padStart(9)} left · ` +
            `${fmtUsdSmart(totals.spendTotalMicro)} spent across ${totals.payments} payments`,
        );
      }
      console.log(`\nswitch with:  ${CLI} status --agent <name>`);
      break;
    }

    case "policy": {
      const rt = agent(stateDir, flags.agent);
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
      const pmode = readMode(stateDir);
      if (pmode.mode === "live" && pmode.network === "base")
        console.log(`\n  ! REAL MONEY — this limit governs USDC on Base mainnet.`);
      break;
    }

    case "approvals": {
      const rt = agent(stateDir, flags.agent);
      const pending = rt.approvals.pending();
      const grants = rt.approvals.activeGrants();
      if (!pending.length && !grants.length) {
        console.log("no payments waiting on you, and no live grants");
        break;
      }
      for (const r of pending) {
        console.log(`${fmtUsdSmart(BigInt(r.amountMicro))} → ${shortPath(r.url)}   (asked ${ago(r.at)})`);
        console.log(`    approve: ${CLI} approve ${r.id}    ·    deny: ${CLI} deny ${r.id}\n`);
      }
      if (grants.length) {
        console.log(`live grants — spending you have already said yes to:`);
        for (const g of grants) {
          const expiry = g.expiresAt ? `expires ${describeDuration(Math.max(0, Date.parse(g.expiresAt) - Date.now()))} from now` : "never expires";
          console.log(`  ${fmtUsdSmart(rt.approvals.remainingMicro(g))} left for ${g.host}   (${expiry})`);
        }
      }
      break;
    }

    case "approve":
    case "deny": {
      const id = args[0];
      if (!id) throw new UserError(`which one? list them with:  ${CLI} approvals`);
      const rt = agent(stateDir, flags.agent);
      const req = rt.approvals.pending().find((r) => r.id === id);
      const expiresInMs = flags.expires === undefined ? DEFAULT_GRANT_TTL_MS : parseDuration(flags.expires);
      const budgetMicro = flags.budget === undefined ? undefined : usd(flags.budget);
      if (!decideApproval(rt, id, cmd === "approve", { expiresInMs, budgetMicro }))
        throw new UserError(`no payment is waiting under id "${id}" — list them with: ${CLI} approvals`);
      if (cmd === "approve") {
        const covers = budgetMicro ?? BigInt(req?.amountMicro ?? "0");
        console.log(`approved ${fmtUsdSmart(BigInt(req?.amountMicro ?? "0"))} to ${req?.host ?? "that site"}.`);
        console.log(
          `this grant covers ${fmtUsdSmart(covers)} of spending to ${req?.host ?? "that host"}` +
            `${expiresInMs === null ? " and never expires" : ` for the next ${describeDuration(expiresInMs)}`}, then it stops.`,
        );
        console.log(`nothing has moved yet — the agent completes this payment on its next attempt.`);
      } else {
        console.log(`denied. The agent will keep being blocked on that payment.`);
      }
      break;
    }

    case "audit": {
      const rt = agent(stateDir, flags.agent);
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

    case "notify": {
      const rt = agent(stateDir, flags.agent);
      const [sub, value] = args;

      if (!sub) {
        const c = rt.notifyStore.load();
        console.log(`webhook   ${c.webhookUrl ?? "not set"}`);
        if (c.email) {
          const provider = c.emailProvider ?? "resend";
          const envVar = providerEnvVar(provider);
          const key = process.env[envVar] ? "key found" : `${envVar} is NOT set — no mail will send`;
          console.log(`email     ${c.email}  (via ${provider}, from ${c.emailFrom ?? "wallie@resend.dev"}, ${key})`);
        } else {
          console.log(`email     not set`);
        }
        if (c.sms) {
          const ready = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN;
          const from = c.smsFrom ?? process.env.TWILIO_FROM;
          console.log(
            `sms       ${c.sms}  (via twilio, from ${from ?? "no sender set"}, ` +
              `${ready ? "keys found" : "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are NOT set — no text will send"})`,
          );
        } else {
          console.log(`sms       not set`);
        }
        console.log(`push      ${c.pushTopic ? `${c.pushTopic} (via ntfy)` : "not set"}`);
        if (c.cloud?.enabled) {
          if (process.env[c.cloud.keyEnv]) {
            const who = await cloudWhoami(c.cloud);
            console.log(
              who.ok
                ? `cloud     connected as ${who.workspace ?? "your workspace"} (${hostOfUrl(c.cloud.url)})`
                : `cloud     ${hostOfUrl(c.cloud.url)} — ${who.detail}`,
            );
          } else {
            console.log(`cloud     ${hostOfUrl(c.cloud.url)} — ${c.cloud.keyEnv} is NOT set, nothing will send`);
          }
        } else {
          console.log(`cloud     not set`);
        }
        console.log(
          c.heartbeatUrl
            ? `heartbeat every ${c.heartbeatSeconds}s to ${hostOfUrl(c.heartbeatUrl)} while the dashboard runs`
            : `heartbeat not set — nothing tells you when this machine goes quiet`,
        );
        console.log(`telling you about`);
        console.log(`  spending  at ${c.thresholds.join("%, ")}% of the allowance`);
        console.log(`  blocks    ${c.onBlock ? "yes — every payment your rails refuse" : "no"}`);
        console.log(`  approvals ${c.onApproval ? "yes — every payment waiting on you" : "no"}`);
        if (!rt.notifyStore.configured())
          console.log(
            `\nnothing is set up, so nothing is sent. Start with:\n  ${CLI} notify webhook <url>\n` +
              `  ${CLI} notify email you@example.com\n  ${CLI} notify push ${rt.agentName}-alerts`,
          );
        const recent = rt.notifyStore.recentFailures(3);
        if (recent.length) {
          console.log(`\nalerts that did not arrive (the ledger is still the record):`);
          for (const f of recent) console.log(`  ${ago(f.at)}  ${f.channel}  ${f.detail}`);
        }
        break;
      }

      if (sub === "off") {
        rt.notifyStore.save({
          webhookUrl: undefined,
          email: undefined,
          sms: undefined,
          pushTopic: undefined,
          heartbeatUrl: undefined,
          cloud: undefined,
        });
        console.log(`alerts off — nothing will be sent`);
        break;
      }

      if (sub === "cloud") {
        if (!value)
          throw new UserError(
            `which workspace key? e.g.  ${CLI} notify cloud wk_live_...\n` +
              `It is in your Wallie Cloud welcome email. Or "${CLI} notify cloud off" to disconnect.`,
          );
        if (value === "off") {
          rt.notifyStore.save({ cloud: undefined });
          console.log(`cloud off — no events or heartbeats will be sent`);
          break;
        }
        if (!/^wk_(live|test)_[A-Za-z0-9]{8,}$/.test(value))
          throw new UserError(
            `"${value.slice(0, 12)}…" is not a Wallie Cloud workspace key — it should look like wk_live_…`,
          );
        // Store only the wiring, never the key: it is read from the environment
        // at send time, so notifications.json stays safe to paste in a bug report.
        rt.notifyStore.save({ cloud: { enabled: true, url: CLOUD_DEFAULT_URL, keyEnv: CLOUD_ENV } });
        console.log(`cloud set — every decision and a heartbeat go to ${hostOfUrl(CLOUD_DEFAULT_URL)}`);
        console.log(`\nThe key is never written to disk. Export it so the runtime can read it:`);
        console.log(`  export ${CLOUD_ENV}=${value}`);
        console.log(`\ncheck it now with:  ${CLI} notify test`);
        break;
      }

      if (sub === "sms") {
        if (!value) throw new UserError(`which number? e.g.  ${CLI} notify sms +31612345678`);
        if (value === "off") {
          rt.notifyStore.save({ sms: undefined });
          console.log(`sms alerts off`);
          break;
        }
        if (!/^\+[1-9]\d{6,14}$/.test(value))
          throw new UserError(`"${value}" is not an E.164 phone number — it should look like +31612345678`);
        rt.notifyStore.save({ sms: value, smsFrom: flags.from ?? rt.notifyStore.load().smsFrom });
        console.log(`sms set — alerts will text ${value}`);
        const missing = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"].filter((v) => !process.env[v]);
        if (missing.length) {
          console.log(`\nnothing will send yet: ${missing.join(" and ")} not set in your environment.`);
          console.log(`Get them from twilio.com, then:  export TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=...`);
        }
        if (!flags.from && !process.env.TWILIO_FROM)
          console.log(`\nno sender number yet: set TWILIO_FROM=+1... or pass --from +1...`);
        console.log(`check it now with:  ${CLI} notify test`);
        break;
      }

      if (sub === "push") {
        if (!value) throw new UserError(`which topic? e.g.  ${CLI} notify push ${rt.agentName}-alerts`);
        if (value === "off") {
          rt.notifyStore.save({ pushTopic: undefined });
          console.log(`push alerts off`);
          break;
        }
        if (/^https?:\/\//.test(value)) {
          try {
            new URL(value);
          } catch {
            throw new UserError(`"${value}" is not a URL`);
          }
        } else if (!/^[A-Za-z0-9_-]{3,64}$/.test(value)) {
          throw new UserError(`"${value}" is not a usable ntfy topic — letters, numbers, - and _ only`);
        }
        rt.notifyStore.save({ pushTopic: value });
        console.log(`push set — alerts go to ${/^https?:\/\//.test(value) ? value : `ntfy.sh/${value}`}`);
        console.log(`Install the ntfy app, subscribe to that topic, and it lands on your lock screen.`);
        console.log(`Anyone who knows the topic name can read it — pick something unguessable.`);
        console.log(`check it now with:  ${CLI} notify test`);
        break;
      }

      if (sub === "heartbeat") {
        if (!value)
          throw new UserError(
            `which URL? e.g.  ${CLI} notify heartbeat https://hc-ping.com/<uuid>\n` +
              `An outside monitor pings you when this stops arriving — which is the only way to hear about it when this machine is off.`,
          );
        if (value === "off") {
          rt.notifyStore.save({ heartbeatUrl: undefined });
          console.log(`heartbeat off`);
          break;
        }
        let parsed: URL;
        try {
          parsed = new URL(value);
        } catch {
          throw new UserError(`"${value}" is not a URL — it should start with https://`);
        }
        if (parsed.protocol !== "https:" && parsed.hostname !== "localhost")
          throw new UserError(`the heartbeat URL must be https (got ${parsed.protocol}//)`);
        const seconds = args[2] ? Number(args[2]) : (rt.notifyStore.load().heartbeatSeconds ?? 60);
        if (!Number.isFinite(seconds) || seconds < 10) throw new UserError(`heartbeat interval must be at least 10 seconds`);
        rt.notifyStore.save({ heartbeatUrl: value, heartbeatSeconds: seconds });
        console.log(`heartbeat set — ${CLI} dashboard will ping ${parsed.host} every ${seconds}s while it runs`);
        console.log(`Point healthchecks.io, Cronitor or your own monitor at it and it will alert you when the pings stop.`);
        break;
      }

      if (sub === "webhook") {
        if (!value) throw new UserError(`which URL? e.g.  ${CLI} notify webhook https://hooks.slack.com/services/...`);
        if (value === "off") {
          rt.notifyStore.save({ webhookUrl: undefined });
          console.log(`webhook alerts off`);
          break;
        }
        let parsed: URL;
        try {
          parsed = new URL(value);
        } catch {
          throw new UserError(`"${value}" is not a URL — it should start with https://`);
        }
        if (parsed.protocol !== "https:" && parsed.hostname !== "localhost")
          throw new UserError(`webhooks must be https (got ${parsed.protocol}//) — alerts name what your agent pays for`);
        rt.notifyStore.save({ webhookUrl: value });
        console.log(`webhook set — every alert will POST to ${parsed.host}`);
        console.log(`check it now with:  ${CLI} notify test`);
        break;
      }

      if (sub === "email") {
        if (!value) throw new UserError(`which address? e.g.  ${CLI} notify email you@example.com`);
        if (value === "off") {
          rt.notifyStore.save({ email: undefined });
          console.log(`email alerts off`);
          break;
        }
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) throw new UserError(`"${value}" does not look like an email address`);
        const provider = (flags.via ?? rt.notifyStore.load().emailProvider ?? "resend") as "resend" | "postmark";
        if (provider !== "resend" && provider !== "postmark")
          throw new UserError(`--via must be resend or postmark, got "${provider}"`);
        rt.notifyStore.save({ email: value, emailProvider: provider, emailFrom: flags.from ?? rt.notifyStore.load().emailFrom });
        console.log(`email set — alerts go to ${value} via ${provider}`);
        const envVar = providerEnvVar(provider);
        if (!process.env[envVar]) {
          console.log(`\nnothing will send yet: ${envVar} is not set in your environment.`);
          console.log(`Get a key from ${provider === "resend" ? "resend.com" : "postmarkapp.com"}, then:`);
          console.log(`  export ${envVar}=...`);
        }
        if (!flags.from) console.log(`\nsending from the provider's shared address. Use --from you@yourdomain.com once you have verified a domain.`);
        console.log(`check it now with:  ${CLI} notify test`);
        break;
      }

      if (sub === "test") {
        const cfg = rt.notifyStore.load();
        if (!rt.notifyStore.configured() && !cfg.cloud?.enabled)
          throw new UserError(`nothing to test — set a channel first:  ${CLI} notify webhook <url>`);
        console.log(`sending one test alert on every configured channel…`);
        const results = await deliver(cfg, {
          event: "threshold",
          subject: `Test alert from ${rt.agentName}`,
          body:
            `This is ${CLI} checking that alerts reach you.\n\n` +
            `If you are reading this, you will also hear about: spending at ${cfg.thresholds.join("%, ")}%, ` +
            `every payment your rails refuse, and every payment waiting on your approval.`,
          data: { agent: rt.agentName, test: true },
        });
        // The cloud test verifies the key authenticates (GET /v1/me) rather than
        // injecting a fake payment into the feed.
        if (cfg.cloud?.enabled) {
          const who = await cloudWhoami(cfg.cloud);
          results.push({
            channel: "cloud",
            ok: who.ok,
            detail: who.ok ? `connected as ${who.workspace ?? "your workspace"}` : who.detail,
            attempts: 1,
          });
        }
        let failed = false;
        for (const r of results) {
          const tries = r.attempts > 1 ? ` (${r.attempts} attempts)` : "";
          console.log(`  ${r.ok ? "delivered" : "FAILED   "}  ${r.channel.padEnd(8)} ${r.detail}${tries}`);
          if (!r.ok) failed = true;
        }
        if (failed) process.exitCode = 1;
        break;
      }

      throw new UserError(`unknown notify command "${sub}" — try: webhook, email, sms, push, cloud, heartbeat, test, off`);
    }

    case "pay": {
      const url = args[0];
      if (!url) throw new UserError(`which URL? e.g.  ${CLI} pay https://api.example.com/paid`);
      try {
        new URL(url);
      } catch {
        throw new UserError(`"${url}" is not a URL — it should start with https://`);
      }
      const method = (flags.method ?? (flags.body !== undefined ? "POST" : "GET")).toUpperCase();
      const init: RequestInit = { method };
      if (flags.body !== undefined) {
        init.body = flags.body;
        init.headers = { "Content-Type": "application/json" };
      }

      const mode = readMode(stateDir);
      let ctx;
      if (mode.mode === "live") {
        const key = requireLiveKey();
        let live;
        try {
          live = await createLiveAgent({
            stateDir,
            agentName: flags.agent,
            privateKey: key,
            network: mode.network,
            rpcUrl: mode.rpcUrl,
          });
        } catch (e) {
          throw new UserError(e instanceof Error ? e.message : String(e));
        }
        ctx = live.ctx;
        console.log(describeMode(mode));
      } else {
        ctx = agent(stateDir, flags.agent).ctx;
      }

      const res = await payingFetch(ctx, url, init);
      const preview = (s: string) => (s ? `\n${s.slice(0, 200)}${s.length > 200 ? "…" : ""}` : "");
      if (res.txHash || res.costMicro > 0n) {
        console.log(
          `PAID     ${fmtUsdSmart(res.costMicro)}  ${shortPath(url)}` +
            (res.txHash ? `  ${String(res.txHash).slice(0, 18)}…` : ""),
        );
        console.log(preview(res.raw).trimStart());
        process.exitCode = 0;
      } else if (res.blockedBy) {
        const label = RULE_LABELS[res.blockedBy.rule as keyof typeof RULE_LABELS] ?? res.blockedBy.rule;
        console.log(`BLOCKED  ${label}`);
        console.log(res.blockedBy.detail);
        process.exitCode = 2;
      } else if (res.error) {
        console.log(`ERROR    ${res.error}`);
        process.exitCode = 1;
      } else {
        console.log(`${res.ok ? "OK" : `HTTP ${res.status}`}   ${shortPath(url)} — no payment was required${preview(res.raw)}`);
        process.exitCode = res.ok ? 0 : 1;
      }
      break;
    }

    case "doctor": {
      const mode = readMode(stateDir);
      const lines: string[] = [];
      let bad = false;
      const ok = (label: string, detail: string) => lines.push(`  ok    ${label.padEnd(14)} ${detail}`);
      const warn = (label: string, detail: string) => lines.push(`  warn  ${label.padEnd(14)} ${detail}`);
      const fail = (label: string, detail: string) => {
        bad = true;
        lines.push(`  FAIL  ${label.padEnd(14)} ${detail}`);
      };

      const [maj, min] = process.versions.node.split(".").map(Number);
      if (maj > 20 || (maj === 20 && min >= 11)) ok("node", `v${process.versions.node}`);
      else fail("node", `v${process.versions.node} — the package needs Node ≥ 20.11 (running the TS sources needs Node 24)`);

      try {
        await import("viem/accounts");
        ok("viem", "installed — live signing available");
      } catch {
        (mode.mode === "live" ? fail : warn)("viem", "not installed — run `npm i viem` (needed only for live networks)");
      }

      try {
        fs.accessSync(stateDir, fs.constants.W_OK);
        ok("state dir", stateDir);
      } catch {
        warn("state dir", `${stateDir} is missing or not writable — run \`${CLI} init\``);
      }

      ok("mode", describeMode(mode));

      if (mode.mode === "live") {
        if (process.env.AGENT_PRIVATE_KEY?.trim())
          ok("wallet key", "AGENT_PRIVATE_KEY is set (read from the environment only, never stored)");
        else fail("wallet key", "AGENT_PRIVATE_KEY is not set — export AGENT_PRIVATE_KEY=0x... before you can pay");

        const info = mode.network ? NETWORKS[mode.network] : undefined;
        const rpc = mode.rpcUrl ?? (mode.network ? RPC_DEFAULTS[mode.network] : undefined);
        if (!info) fail("network", `unknown network "${mode.network}"`);
        else if (!rpc) warn("rpc", `no RPC for ${mode.network} — the wallet balance will be unreadable`);
        else if (mode.address) {
          try {
            const bal = await usdcBalanceMicro(rpc, info.usdc, mode.address);
            ok("rpc", `${hostOfUrl(rpc)} reachable — wallet holds ${fmtUsd(bal)} USDC on ${mode.network}`);
          } catch (e) {
            warn("rpc", `${hostOfUrl(rpc)} unreachable: ${e instanceof Error ? e.message : String(e)} (spend falls back to the allowance)`);
          }
        }
      }

      const cfg = new NotifyStore(stateDir, flags.agent).load();
      if (cfg.email) {
        const envVar = providerEnvVar(cfg.emailProvider ?? "resend");
        process.env[envVar]
          ? ok("email", `${cfg.email} — ${envVar} is set`)
          : warn("email", `${cfg.email} — ${envVar} is NOT set, no mail will send`);
      }
      if (cfg.sms) {
        const missing = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"].filter((v) => !process.env[v]);
        missing.length
          ? warn("sms", `${cfg.sms} — ${missing.join(" and ")} NOT set, no text will send`)
          : ok("sms", `${cfg.sms} — Twilio keys set`);
      }

      // Cloud channel (C-10): report the key and whether the workspace answers.
      // A warn, never a fail — the cloud is optional, so a misconfigured cloud
      // channel must not flip `doctor`'s exit code (L-05: fail only on the wallet key).
      if (cfg.cloud?.enabled) {
        if (!process.env[cfg.cloud.keyEnv]) {
          warn("cloud", `${cfg.cloud.keyEnv} is NOT set — nothing will reach ${hostOfUrl(cfg.cloud.url)}`);
        } else {
          const who = await cloudWhoami(cfg.cloud);
          who.ok
            ? ok("cloud", `connected as ${who.workspace ?? "your workspace"} (${hostOfUrl(cfg.cloud.url)})`)
            : warn("cloud", `${hostOfUrl(cfg.cloud.url)} — ${who.detail}`);
        }
      }

      console.log(lines.join("\n"));
      console.log(bad ? `\nSomething needs fixing above.` : `\nAll checks passed.`);
      if (bad) process.exitCode = 1;
      break;
    }

    case "demo": {
      const demoDir = flags.rest[0] ? path.resolve(flags.rest[0]) : path.resolve(".allowance-demo");
      await runDemo(demoDir);
      break;
    }

    case "dashboard": {
      const rt = agent(stateDir, flags.agent);
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
      const stopHeartbeat = startHeartbeat(rt.notifyStore.load(), rt.agentName);
      process.on("SIGINT", () => {
        stopHeartbeat();
        rt.stopHeartbeat?.();
        process.exit(0);
      });
      console.log(`dashboard → http://localhost:${port}`);
      console.log(`watching  ${stateDir}  (agent ${rt.agentName})`);
      console.log(`mode      ${describeMode(readMode(stateDir))}`);
      const hb = rt.notifyStore.load();
      if (hb.heartbeatUrl) console.log(`heartbeat pinging ${hostOfUrl(hb.heartbeatUrl)} every ${hb.heartbeatSeconds}s while this runs`);
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
