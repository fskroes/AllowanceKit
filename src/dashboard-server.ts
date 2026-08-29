import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { AllowanceRuntime } from "./wallet.ts";
import { decideApproval, allowanceRemaining } from "./wallet.ts";
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

export function startDashboard(rt: AllowanceRuntime, port = 4030): Promise<{ server: http.Server; token: string }> {
  const htmlPath = path.join(import.meta.dirname ?? ".", "..", "public", "dashboard.html");
  const token = ensureControlToken(rt.stateDir);
  const html = fs.readFileSync(htmlPath, "utf8").replace("__ALLOWANCE_TOKEN__", token);
  const authorized = (req: http.IncomingMessage) => req.headers["x-allowance-token"] === token;

  const server = http.createServer(async (req, res) => {
    const url = (req.url ?? "/").split("?")[0];

    if (url === "/api/state") {
      if (req.method !== "GET") return json(res, 405, { ok: false, error: `use GET for ${url}` });
      const policy = rt.policy();
      const totals = rt.ledger.totals(rt.agentName, 0);
      return json(res, 200, {
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
        events: rt.ledger.read(),
      });
    }

    if (url === "/api/kill") {
      if (req.method !== "POST") return json(res, 405, { ok: false, error: `use POST for ${url}` });
      if (!authorized(req)) return unauthorized(res);
      const { on } = JSON.parse((await readBody(req)) || "{}") as { on?: boolean };
      const nextOn = Boolean(on);
      rt.policyStore.save({ killSwitch: nextOn });
      rt.ledger.append({
        t: "policy_change",
        at: new Date().toISOString(),
        agent: rt.agentName,
        field: "killSwitch",
        value: nextOn,
      });
      return json(res, 200, { ok: true, killSwitch: nextOn });
    }

    if (url === "/api/approvals") {
      if (req.method !== "POST") return json(res, 405, { ok: false, error: `use POST for ${url}` });
      if (!authorized(req)) return unauthorized(res);
      const { id, approve } = JSON.parse((await readBody(req)) || "{}") as { id?: string; approve?: boolean };
      const req_ = id ? rt.approvals.pending().find((r) => r.id === id) : undefined;
      if (!id || typeof approve !== "boolean" || !decideApproval(rt, id, approve))
        return json(res, 400, { ok: false, error: "that payment is no longer waiting — it was already decided" });
      return json(res, 200, {
        ok: true,
        id,
        approved: approve,
        amountMicro: req_?.amountMicro ?? "0",
        host: req_?.host ?? "",
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
