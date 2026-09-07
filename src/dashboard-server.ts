import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { AllowanceRuntime } from "./wallet.ts";
import { decideApproval, allowanceRemaining, createAgent, listAgents } from "./wallet.ts";
import { effectiveBudgetMicro, policyWarnings } from "./policy.ts";
import { describeMode, readMode } from "./mode.ts";
import { CLI } from "./cli-name.ts";

function ensureControlToken(stateDir: string): string {
  const file = path.join(stateDir, "dashboard-token");
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  }
  const token = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
  });
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

/**
 * A one-line answer to "if this blows the budget at 3am, who hears about it?"
 * — the question the dashboard cannot answer just by being open.
 */
function describeAlerts(rt: AllowanceRuntime): string[] {
  const cfg = rt.notifyStore.load();
  const out: string[] = [];
  if (cfg.webhookUrl) {
    try {
      out.push(`webhook to ${new URL(cfg.webhookUrl).host}`);
    } catch {
      out.push("webhook");
    }
  }
  if (cfg.email) out.push(`email to ${cfg.email}`);
  if (cfg.sms) out.push(`sms to ${cfg.sms}`);
  if (cfg.pushTopic) out.push(`push to ${cfg.pushTopic}`);
  return out;
}

/** One agent's slice of the dashboard state, from that agent's own stores. */
function stateFor(rt: AllowanceRuntime): unknown {
  const policy = rt.policy();
  const totals = rt.ledger.totals(rt.agentName, 0);
  return {
    agent: rt.agentName,
    address: rt.address,
    cli: CLI,
    alerts: describeAlerts(rt),
    alertFailures: rt.notifyStore.recentFailures(3),
    mode: rt.mode,
    network: describeMode(readMode(rt.stateDir)),
    remainingMicro: allowanceRemaining(rt).toString(),
    fundedMicro: totals.topupsMicro.toString(),
    budgetMicro: effectiveBudgetMicro(policy, totals.topupsMicro).toString(),
    totalBudgetUsd: policy.totalBudgetUsd,
    perCallMaxUsd: policy.perCallMaxUsd,
    requireApprovalAboveUsd: policy.requireApprovalAboveUsd,
    windowLimitUsd: policy.windowLimitUsd,
    windowSeconds: policy.windowSeconds,
    allowHostSuffixes: policy.allowHostSuffixes,
    blockedHosts: policy.blockedHosts,
    killSwitch: policy.killSwitch,
    spendTotalMicro: totals.spendTotalMicro.toString(),
    topupsMicro: totals.topupsMicro.toString(),
    inFlightMicro: rt.reservations.total(rt.agentName).toString(),
    warnings: policyWarnings(policy),
    approvals: rt.approvals.list(),
    grants: rt.approvals.activeGrants().map((g) => ({
      id: g.id,
      host: g.host,
      remainingMicro: rt.approvals.remainingMicro(g).toString(),
      expiresAt: g.expiresAt ?? null,
    })),
    // Each agent sees only its own history, so the switcher actually switches.
    events: rt.ledger.read().filter((e) => e.agent === rt.agentName),
  };
}

export function startDashboard(rt: AllowanceRuntime, port = 4030): Promise<{ server: http.Server; token: string }> {
  const htmlPath = path.join(import.meta.dirname ?? ".", "..", "public", "dashboard.html");
  const token = ensureControlToken(rt.stateDir);
  const html = fs.readFileSync(htmlPath, "utf8").replace("__ALLOWANCE_TOKEN__", token);
  const authorized = (req: http.IncomingMessage) => req.headers["x-allowance-token"] === token;

  // One runtime per agent in the directory, built on demand and reused across
  // polls. The stores each runtime holds always re-read from disk, so a cached
  // runtime never goes stale — caching only spares us rebuilding it every 1.2s.
  const runtimes = new Map<string, AllowanceRuntime>([[rt.agentName, rt]]);
  const runtimeFor = (name: string): AllowanceRuntime => {
    let r = runtimes.get(name);
    if (!r) runtimes.set(name, (r = createAgent(rt.stateDir, name)));
    return r;
  };

  // Every agent the directory knows about, with the one we were started for
  // always present even if it has not spent yet. This is what the UI lists.
  const agentNames = (): string[] => {
    const names = new Set(listAgents(rt.stateDir));
    names.add(rt.agentName);
    return [...names].sort();
  };

  // A mutation names its agent; fall back to the primary, reject an unknown one
  // rather than let a stray name reprovision a runtime.
  const resolveRuntime = (name: string | undefined): AllowanceRuntime | undefined => {
    const target = name ?? rt.agentName;
    return agentNames().includes(target) ? runtimeFor(target) : undefined;
  };

  const server = http.createServer(async (req, res) => {
    const url = (req.url ?? "/").split("?")[0];

    if (url === "/api/state") {
      if (req.method !== "GET") return json(res, 405, { ok: false, error: `use GET for ${url}` });
      if (!authorized(req)) return unauthorized(res);
      const names = agentNames();
      const states: Record<string, unknown> = {};
      for (const name of names) states[name] = stateFor(runtimeFor(name));
      return json(res, 200, { cli: CLI, selected: rt.agentName, agents: names, states });
    }

    if (url === "/api/kill") {
      if (req.method !== "POST") return json(res, 405, { ok: false, error: `use POST for ${url}` });
      if (!authorized(req)) return unauthorized(res);
      const { on, agent } = JSON.parse((await readBody(req)) || "{}") as { on?: boolean; agent?: string };
      const target = resolveRuntime(agent);
      if (!target) return json(res, 400, { ok: false, error: `no such agent: ${agent}` });
      const nextOn = Boolean(on);
      target.policyStore.save({ killSwitch: nextOn });
      target.ledger.append({
        t: "policy_change",
        at: new Date().toISOString(),
        agent: target.agentName,
        field: "killSwitch",
        value: nextOn,
      });
      return json(res, 200, { ok: true, killSwitch: nextOn, agent: target.agentName });
    }

    if (url === "/api/approvals") {
      if (req.method !== "POST") return json(res, 405, { ok: false, error: `use POST for ${url}` });
      if (!authorized(req)) return unauthorized(res);
      const { id, approve, agent } = JSON.parse((await readBody(req)) || "{}") as { id?: string; approve?: boolean; agent?: string };
      const target = resolveRuntime(agent);
      if (!target) return json(res, 400, { ok: false, error: `no such agent: ${agent}` });
      const req_ = id ? target.approvals.pending().find((r) => r.id === id) : undefined;
      if (!id || typeof approve !== "boolean" || !decideApproval(target, id, approve))
        return json(res, 400, { ok: false, error: "that payment is no longer waiting — it was already decided" });
      return json(res, 200, {
        ok: true,
        id,
        approved: approve,
        amountMicro: req_?.amountMicro ?? "0",
        host: req_?.host ?? "",
        agent: target.agentName,
      });
    }

    if (url.startsWith("/api/")) return json(res, 404, { ok: false, error: `no such endpoint: ${url}` });

    if (url !== "/") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });

  function unauthorized(res: http.ServerResponse): void {
    json(res, 401, { ok: false, error: "missing or invalid control token — restart the dashboard to pick up a fresh one" });
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve({ server, token });
    });
  });
}
