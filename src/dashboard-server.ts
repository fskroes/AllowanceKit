import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { AgentRuntime } from "./wallet.ts";
import { decideApproval, allowanceRemaining } from "./wallet.ts";

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

export function startDashboard(rt: AgentRuntime, port = 4030): Promise<{ server: http.Server; token: string }> {
  const htmlPath = path.join(import.meta.dirname ?? ".", "..", "public", "dashboard.html");
  const token = ensureControlToken(rt.stateDir);
  const html = fs.readFileSync(htmlPath, "utf8").replace("__ALLOWANCE_TOKEN__", token);
  const authorized = (req: http.IncomingMessage) => req.headers["x-allowance-token"] === token;

  const server = http.createServer((req, res) => {
    if (req.url === "/api/state") {
      const policy = rt.policy();
      const events = rt.ledger.read();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        agent: rt.agentName,
        address: rt.address,
        network: "mock-ledger (simulated funds)",
        remainingMicro: allowanceRemaining(rt).toString(),
        totalBudgetUsd: policy.totalBudgetUsd,
        perCallMaxUsd: policy.perCallMaxUsd,
        requireApprovalAboveUsd: policy.requireApprovalAboveUsd,
        windowLimitUsd: policy.windowLimitUsd,
        windowSeconds: policy.windowSeconds,
        allowHostSuffixes: policy.allowHostSuffixes,
        killSwitch: policy.killSwitch,
        spendTotalMicro: rt.ledger.spendTotal(rt.agentName).toString(),
        topupsMicro: rt.ledger.topups(rt.agentName).toString(),
        approvals: rt.approvals.list(),
        events,
      }));
      return;
    }
    if (req.url === "/api/kill" && req.method === "POST") {
      if (!authorized(req)) return unauthorized(res);
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { on } = JSON.parse(body || "{}") as { on?: boolean };
        const nextOn = Boolean(on);
        rt.policyStore.save({ killSwitch: nextOn });
        rt.ledger.append({
          t: "policy_change",
          at: new Date().toISOString(),
          agent: rt.agentName,
          field: "killSwitch",
          value: nextOn,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, killSwitch: nextOn }));
      });
      return;
    }
    if (req.url === "/api/approvals" && req.method === "POST") {
      if (!authorized(req)) return unauthorized(res);
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { id, approve } = JSON.parse(body || "{}") as { id?: string; approve?: boolean };
        if (!id || typeof approve !== "boolean" || !decideApproval(rt, id, approve)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "unknown or already-decided approval request id" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, id, approved: approve }));
      });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });

  function unauthorized(res: http.ServerResponse): void {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "missing or invalid x-allowance-token header (token: .allowance/dashboard-token)" }));
  }

  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, token })));
}
