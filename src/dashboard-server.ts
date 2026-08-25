import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { AgentRuntime } from "./wallet.ts";
import { allowanceRemaining } from "./wallet.ts";
import { fmtUsdExact, fmtUsd } from "./money.ts";

export function startDashboard(rt: AgentRuntime, port = 4030): Promise<http.Server> {
  const htmlPath = path.join(import.meta.dirname ?? ".", "..", "public", "dashboard.html");
  const html = fs.readFileSync(htmlPath, "utf8");

  const server = http.createServer((req, res) => {
    if (req.url === "/api/state") {
      const policy = rt.policy();
      const events = rt.ledger.read();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        agent: rt.agentName,
        address: rt.address,
        remainingMicro: allowanceRemaining(rt).toString(),
        totalBudgetUsd: policy.totalBudgetUsd,
        perCallMaxUsd: policy.perCallMaxUsd,
        windowLimitUsd: policy.windowLimitUsd,
        windowSeconds: policy.windowSeconds,
        allowHostSuffixes: policy.allowHostSuffixes,
        killSwitch: policy.killSwitch,
        spendTotalMicro: rt.ledger.spendTotal(rt.agentName).toString(),
        topupsMicro: rt.ledger.topups(rt.agentName).toString(),
        events,
      }));
      return;
    }
    if (req.url === "/api/kill" && req.method === "POST") {
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
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });

  void fmtUsd;
  void fmtUsdExact;
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}
