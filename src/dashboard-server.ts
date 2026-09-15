import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { AllowanceRuntime } from "./wallet.ts";
import { decideApproval, allowanceRemaining, createAgent, listAgents } from "./wallet.ts";
import { effectiveBudgetMicro, policyWarnings } from "./policy.ts";
import { describeMode, readMode } from "./mode.ts";
import { CLI } from "./cli-name.ts";
import { family } from "./live.ts";
import { ChannelStore, reconcileAndNotify, reclaimChannel, solanaAccountRpc, type ChannelLock } from "./channels.ts";
import { Notifier } from "./notify.ts";
import { solanaNetworkInfo, solanaSigner, normalizeSolanaKey } from "./solana.ts";
import { withLock } from "./lock.ts";

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
  // Escrow is a third money state (§3.3): show locked value and the channel book
  // next to spent and remaining. Empty and zero off Solana, so this is safe for
  // every agent. `dueForReclaim` marks the rows whose reclaim button is live.
  const channelStore = new ChannelStore(rt.stateDir);
  const channelRows = channelStore.list(rt.agentName);
  const due = new Set(channelStore.dueForReclaim(rt.agentName).map((c) => c.channelId));
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
    escrowedMicro: channelStore.escrowedMicro(rt.agentName).toString(),
    channels: channelRows.map((c) => ({
      channelId: c.channelId,
      host: c.host,
      status: c.status,
      depositMicro: c.depositMicro,
      settledMicro: c.settledMicro,
      refundMicro: c.refundMicro,
      withdrawDelay: c.withdrawDelay,
      at: c.at,
      reclaimable: due.has(c.channelId),
    })),
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

  // Resolve a runtime's Solana channel context, or null when it is not a live
  // Solana wallet (channels exist nowhere else). Read from mode.json, so a cached
  // runtime never masks a network change.
  const channelCtx = (
    target: AllowanceRuntime,
  ): { store: ChannelStore; rpcUrl: string; network: string; notifier: Notifier; lock: ChannelLock } | null => {
    const m = readMode(target.stateDir);
    if (m.mode !== "live" || family(m.network ?? "") !== "solana" || !m.network) return null;
    const rpcUrl = m.rpcUrl ?? solanaNetworkInfo(m.network)?.defaultRpc;
    if (!rpcUrl) return null;
    const store = new ChannelStore(target.stateDir);
    const notifier = new Notifier(target.notifyStore, target.agentName, undefined, { network: m.network, mode: "live" });
    // Share the allowance lock with the live agent, so a reconcile/reclaim write
    // never clobbers a concurrent open/settle in the agent's own process.
    const lockPath = path.join(target.stateDir, "allowance.lock");
    const lock: ChannelLock = (fn) => withLock(lockPath, fn);
    return { store, rpcUrl, network: m.network, notifier, lock };
  };

  // The escrow watchdog's dashboard half (§6): each state poll reconciles any
  // in-flight channel, but no more than once every 30 s and only when something
  // is actually open, so an idle dashboard never touches the chain. Background
  // and swallowed — a chain read must never make /api/state slow or fail.
  const lastReconcile = new Map<string, number>();
  const RECONCILE_EVERY_MS = 30_000;
  const maybeReconcile = (target: AllowanceRuntime): void => {
    const ctx = channelCtx(target);
    if (!ctx || !ctx.store.active(target.agentName).length) return;
    const now = Date.now();
    if (now - (lastReconcile.get(target.agentName) ?? 0) < RECONCILE_EVERY_MS) return;
    lastReconcile.set(target.agentName, now);
    void reconcileAndNotify(
      solanaAccountRpc(ctx.rpcUrl),
      ctx.store,
      (phase, rec) => ctx.notifier.channel(phase, rec),
      { agent: target.agentName, lock: ctx.lock, network: ctx.network },
    ).catch((e) => console.warn(`channel reconcile failed: ${e instanceof Error ? e.message : String(e)}`));
  };

  // Reclaim is the payer escape path (requestClose → grace → seal → withdrawPayer):
  // it can take the full grace period, far longer than an HTTP request should wait.
  // So the button starts it in the background and returns at once; the channel
  // becomes `reclaimed` and the table updates on the next poll. Deduped per channel.
  const reclaiming = new Set<string>();
  const startReclaim = (target: AllowanceRuntime, channelId: string): { ok: boolean; error?: string } => {
    if (reclaiming.has(channelId)) return { ok: true }; // already running — a double-click is a no-op
    const ctx = channelCtx(target);
    if (!ctx) return { ok: false, error: "channels are live only on a Solana live wallet" };
    const rec = ctx.store.get(channelId);
    if (!rec) return { ok: false, error: `no channel ${channelId} in the store` };
    const key = process.env.AGENT_PRIVATE_KEY;
    if (!key) return { ok: false, error: "AGENT_PRIVATE_KEY is not set in the dashboard's environment — reclaim needs the wallet key" };
    const signer = solanaSigner(normalizeSolanaKey(key));
    reclaiming.add(channelId);
    void reclaimChannel(rec, signer, { rpcUrl: ctx.rpcUrl, network: ctx.network })
      .then(async (result) => {
        if (result.reclaimed) {
          const updated = await ctx.lock(() => ctx.store.markReclaimed(channelId, result.refundMicro));
          ctx.notifier.channel("reclaimed", updated);
        }
      })
      .catch((e) => console.warn(`channel reclaim failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => reclaiming.delete(channelId));
    return { ok: true };
  };

  const server = http.createServer(async (req, res) => {
    const url = (req.url ?? "/").split("?")[0];

    if (url === "/api/state") {
      if (req.method !== "GET") return json(res, 405, { ok: false, error: `use GET for ${url}` });
      if (!authorized(req)) return unauthorized(res);
      const names = agentNames();
      const states: Record<string, unknown> = {};
      for (const name of names) {
        const target = runtimeFor(name);
        maybeReconcile(target); // background, throttled; safe off Solana
        states[name] = stateFor(target);
      }
      return json(res, 200, { cli: CLI, selected: rt.agentName, agents: names, states });
    }

    if (url === "/api/channels") {
      if (req.method !== "POST") return json(res, 405, { ok: false, error: `use POST for ${url}` });
      if (!authorized(req)) return unauthorized(res);
      const { action, agent, channelId } = JSON.parse((await readBody(req)) || "{}") as {
        action?: string;
        agent?: string;
        channelId?: string;
      };
      const target = resolveRuntime(agent);
      if (!target) return json(res, 400, { ok: false, error: `no such agent: ${agent}` });
      const ctx = channelCtx(target);
      if (!ctx) return json(res, 400, { ok: false, error: "channels are live only on a Solana live wallet" });

      if (action === "reconcile") {
        const changes = await reconcileAndNotify(
          solanaAccountRpc(ctx.rpcUrl),
          ctx.store,
          (phase, rec) => ctx.notifier.channel(phase, rec),
          { agent: target.agentName, lock: ctx.lock, network: ctx.network },
        );
        return json(res, 200, { ok: true, changed: changes.length, agent: target.agentName });
      }
      if (action === "reclaim") {
        if (!channelId) return json(res, 400, { ok: false, error: "which channel? pass channelId" });
        const started = startReclaim(target, channelId);
        if (!started.ok) return json(res, 400, { ok: false, error: started.error });
        return json(res, 202, { ok: true, started: true, channelId, agent: target.agentName });
      }
      return json(res, 400, { ok: false, error: `unknown channels action: ${action}` });
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
