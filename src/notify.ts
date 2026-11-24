import fs from "node:fs";
import path from "node:path";
import { fmtUsdSmart } from "./money.ts";
import { RULE_LABELS, defaultPolicy, slug } from "./policy.ts";
import type { ChannelRecord } from "./types.ts";

export type NotifyEvent = "threshold" | "blocked" | "approval";

export const CLOUD_ENV = "WALLIE_CLOUD_KEY";
export const CLOUD_DEFAULT_URL = "https://api.onewallie.com";

export interface CloudConfig {
  enabled: boolean;
  url: string;
  keyEnv: string;
}

export type CloudEventKind = "payment" | "blocked" | "approval" | "threshold" | "channel";

export type ChannelPhase = "opened" | "settled" | "refunded" | "orphaned" | "reclaimed";

export interface CloudEvent {
  kind: CloudEventKind;
  agent: string;
  network?: string;
  mode?: "practice" | "live";
  subject: string;
  body: string;
  data: Record<string, unknown>;
  at: string;
}

export interface NotifyConfig {
  webhookUrl?: string;
  email?: string;
  emailProvider?: "resend" | "postmark";
  emailFrom?: string;
  sms?: string;
  smsFrom?: string;
  pushTopic?: string;
  heartbeatUrl?: string;
  heartbeatSeconds?: number;
  cloud?: CloudConfig;
  thresholds: number[];
  onBlock: boolean;
  onApproval: boolean;
  highWater: number;
}

export const defaultNotifyConfig: NotifyConfig = {
  thresholds: [50, 80, 100],
  onBlock: true,
  onApproval: true,
  highWater: 0,
  heartbeatSeconds: 60,
};

const PROVIDERS = {
  resend: { env: "RESEND_API_KEY", url: "https://api.resend.com/emails" },
  postmark: { env: "POSTMARK_API_TOKEN", url: "https://api.postmarkapp.com/email" },
} as const;

export const TWILIO_ENV = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM"] as const;

export function providerEnvVar(provider: "resend" | "postmark"): string {
  return PROVIDERS[provider].env;
}

export interface DeliveryResult {
  channel: string;
  ok: boolean;
  detail: string;
  attempts: number;
}

export interface DeliveryFailure {
  at: string;
  agent: string;
  event: NotifyEvent | "heartbeat" | CloudEventKind;
  subject: string;
  channel: string;
  detail: string;
  attempts: number;
}

export class NotifyStore {
  private file: string;
  private failureFile: string;

  constructor(stateDir: string, agentName?: string) {
    fs.mkdirSync(stateDir, { recursive: true });
    this.file = path.join(stateDir, notifyFileName(agentName));
    this.failureFile = path.join(stateDir, "notify-failures.jsonl");
  }

  load(): NotifyConfig {
    if (!fs.existsSync(this.file)) return { ...defaultNotifyConfig };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<NotifyConfig>;
      return { ...defaultNotifyConfig, ...raw };
    } catch {
      return { ...defaultNotifyConfig };
    }
  }

  save(patch: Partial<NotifyConfig>): NotifyConfig {
    const next = { ...this.load(), ...patch };
    fs.writeFileSync(this.file, JSON.stringify(next, null, 2));
    return next;
  }

  configured(): boolean {
    const c = this.load();
    return Boolean(c.webhookUrl || c.email || c.sms || c.pushTopic);
  }

  recordFailures(failures: DeliveryFailure[]): void {
    if (!failures.length) return;
    fs.appendFileSync(this.failureFile, failures.map((f) => JSON.stringify(f)).join("\n") + "\n");
  }

  recentFailures(limit = 5): DeliveryFailure[] {
    try {
      const lines = fs.readFileSync(this.failureFile, "utf8").trim().split("\n").filter(Boolean);
      return lines
        .slice(-limit)
        .map((l) => {
          try {
            return JSON.parse(l) as DeliveryFailure;
          } catch {
            return null;
          }
        })
        .filter((f): f is DeliveryFailure => f !== null);
    } catch {
      return [];
    }
  }
}

export function notifyFileName(agentName?: string): string {
  return !agentName || agentName === defaultPolicy.agentName
    ? "notifications.json"
    : `notifications.${slug(agentName)}.json`;
}

export interface Message {
  event: NotifyEvent;
  subject: string;
  body: string;
  data: Record<string, unknown>;
}

type Attempt = {
  ok: boolean;
  detail: string;
  retryable: boolean;
  retryAfterMs?: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry(channel: string, attempt: () => Promise<Attempt>, attempts = 3): Promise<DeliveryResult> {
  let last: Attempt = { ok: false, detail: "not attempted", retryable: false };
  for (let i = 1; i <= attempts; i++) {
    last = await attempt();
    if (last.ok) return { channel, ok: true, detail: last.detail, attempts: i };
    if (!last.retryable) return { channel, ok: false, detail: last.detail, attempts: i };
    if (i < attempts) {
      const backoff = 500 * 2 ** (i - 1);
      await sleep(Math.min(60_000, last.retryAfterMs ?? backoff));
    }
  }
  return { channel, ok: false, detail: `${last.detail} (after ${attempts} attempts)`, attempts };
}

export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const secs = Number(header.trim());
  if (Number.isFinite(secs)) return Math.max(0, Math.min(60_000, Math.round(secs * 1000)));
  const when = Date.parse(header);
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, Math.min(60_000, when - now));
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export async function deliver(
  cfg: NotifyConfig,
  msg: Message,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DeliveryResult[]> {
  const jobs: Promise<DeliveryResult>[] = [];
  if (cfg.webhookUrl) jobs.push(withRetry("webhook", () => postWebhook(cfg.webhookUrl!, msg)));
  if (cfg.email) jobs.push(withRetry("email", () => sendEmail(cfg, msg, env)));
  if (cfg.sms) jobs.push(withRetry("sms", () => sendSms(cfg, msg, env)));
  if (cfg.pushTopic) jobs.push(withRetry("push", () => sendPush(cfg.pushTopic!, msg)));
  return Promise.all(jobs);
}

async function postWebhook(url: string, msg: Message): Promise<Attempt> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `${msg.subject}\n${msg.body}`,
        content: `${msg.subject}\n${msg.body}`,
        event: msg.event,
        subject: msg.subject,
        body: msg.body,
        ...msg.data,
      }),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok
      ? { ok: true, detail: `${res.status}`, retryable: false }
      : { ok: false, detail: `HTTP ${res.status} from ${hostOf(url)}`, retryable: retryableStatus(res.status) };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e), retryable: true };
  }
}

async function sendEmail(cfg: NotifyConfig, msg: Message, env: NodeJS.ProcessEnv): Promise<Attempt> {
  const provider = cfg.emailProvider ?? "resend";
  const { env: envVar, url } = PROVIDERS[provider];
  const key = env[envVar];
  if (!key) return { ok: false, detail: `${envVar} is not set, so no mail was sent`, retryable: false };

  const from = cfg.emailFrom ?? "wallie@resend.dev";
  const body =
    provider === "resend"
      ? { from, to: [cfg.email], subject: msg.subject, text: msg.body }
      : { From: from, To: cfg.email, Subject: msg.subject, TextBody: msg.body, MessageStream: "outbound" };
  const headers: Record<string, string> =
    provider === "resend"
      ? { "Content-Type": "application/json", Authorization: `Bearer ${key}` }
      : { "Content-Type": "application/json", Accept: "application/json", "X-Postmark-Server-Token": key };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return { ok: true, detail: `sent to ${cfg.email}`, retryable: false };
    const detail = await res.text().catch(() => "");
    return {
      ok: false,
      detail: `HTTP ${res.status} from ${provider}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      retryable: retryableStatus(res.status),
    };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e), retryable: true };
  }
}

async function sendSms(cfg: NotifyConfig, msg: Message, env: NodeJS.ProcessEnv): Promise<Attempt> {
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  const from = cfg.smsFrom ?? env.TWILIO_FROM;
  if (!sid || !token)
    return { ok: false, detail: `TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are not set, so no SMS was sent`, retryable: false };
  if (!from)
    return { ok: false, detail: `no sender number — set TWILIO_FROM or pass --from`, retryable: false };

  const firstLine = msg.body.split("\n").find((l) => l.trim().length) ?? "";
  const text = `${msg.subject}\n${firstLine}`.slice(0, 300);
  const form = new URLSearchParams({ To: cfg.sms!, From: from, Body: text });

  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
      },
      body: form.toString(),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return { ok: true, detail: `sent to ${cfg.sms}`, retryable: false };
    const detail = await res.text().catch(() => "");
    return {
      ok: false,
      detail: `HTTP ${res.status} from twilio${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      retryable: retryableStatus(res.status),
    };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e), retryable: true };
  }
}

async function sendPush(topic: string, msg: Message): Promise<Attempt> {
  const url = /^https?:\/\//.test(topic) ? topic : `https://ntfy.sh/${encodeURIComponent(topic)}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        Title: msg.subject.replace(/[\r\n]+/g, " ").slice(0, 200),
        Priority: msg.event === "approval" ? "high" : "default",
        Tags: msg.event === "blocked" ? "no_entry" : msg.event === "approval" ? "bell" : "moneybag",
      },
      body: msg.body,
      signal: AbortSignal.timeout(8000),
    });
    return res.ok
      ? { ok: true, detail: `pushed to ${hostOf(url)}`, retryable: false }
      : { ok: false, detail: `HTTP ${res.status} from ${hostOf(url)}`, retryable: retryableStatus(res.status) };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e), retryable: true };
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function startHeartbeat(
  cfg: NotifyConfig,
  agentName: string,
  send: (url: string) => Promise<unknown> = pingHeartbeat,
): () => void {
  if (!cfg.heartbeatUrl) return () => undefined;
  const url = cfg.heartbeatUrl;
  const everyMs = Math.max(10, cfg.heartbeatSeconds ?? 60) * 1000;
  const beat = () => {
    void Promise.resolve(send(url)).catch(() => undefined);
  };
  beat();
  const timer = setInterval(beat, everyMs);
  timer.unref?.();
  void agentName;
  return () => clearInterval(timer);
}

async function pingHeartbeat(url: string): Promise<void> {
  await fetch(url, { method: "POST", signal: AbortSignal.timeout(8000) }).catch(() => undefined);
}

export function stripQuery(value: string): string {
  try {
    const u = new URL(value);
    u.search = "";
    return u.toString();
  } catch {
    const q = value.indexOf("?");
    return q === -1 ? value : value.slice(0, q);
  }
}

function cloudUrl(base: string, route: string): string {
  return base.replace(/\/+$/, "") + route;
}

async function postCloudEvent(cloud: CloudConfig, evt: CloudEvent, env: NodeJS.ProcessEnv): Promise<Attempt> {
  const key = env[cloud.keyEnv];
  if (!key) return { ok: false, detail: `${cloud.keyEnv} is not set, so nothing reached the cloud`, retryable: false };
  try {
    const res = await fetch(cloudUrl(cloud.url, "/v1/events"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(evt),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return { ok: true, detail: `sent to ${hostOf(cloud.url)}`, retryable: false };
    return {
      ok: false,
      detail: `HTTP ${res.status} from ${hostOf(cloud.url)}`,
      retryable: retryableStatus(res.status),
      retryAfterMs: res.status === 429 ? parseRetryAfter(res.headers.get("retry-after")) : undefined,
    };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e), retryable: true };
  }
}

export function deliverCloud(cloud: CloudConfig, evt: CloudEvent, env: NodeJS.ProcessEnv = process.env): Promise<DeliveryResult> {
  return withRetry("cloud", () => postCloudEvent(cloud, evt, env));
}

export interface CloudHeartbeat {
  agent: string;
  network?: string;
  mode?: "practice" | "live";
  version?: string;
  escrowedMicro?: string;
}

export function startCloudHeartbeat(
  cloud: CloudConfig | undefined,
  meta: CloudHeartbeat,
  opts: {
    env?: NodeJS.ProcessEnv;
    everyMs?: number;
    send?: (cloud: CloudConfig, meta: CloudHeartbeat, env: NodeJS.ProcessEnv) => Promise<unknown>;
    beat?: () => Partial<CloudHeartbeat> | void | Promise<Partial<CloudHeartbeat> | void>;
  } = {},
): () => void {
  if (!cloud?.enabled && !opts.beat) return () => undefined;
  const env = opts.env ?? process.env;
  const send = opts.send ?? postCloudHeartbeat;
  const everyMs = Math.max(250, opts.everyMs ?? 60_000);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      let extra: Partial<CloudHeartbeat> | void;
      try {
        extra = opts.beat ? await opts.beat() : undefined;
      } catch {
        extra = undefined;
      }
      const body = extra ? { ...meta, ...extra } : meta;
      if (cloud?.enabled) await Promise.resolve(send(cloud, body, env)).catch(() => undefined);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function postCloudHeartbeat(cloud: CloudConfig, meta: CloudHeartbeat, env: NodeJS.ProcessEnv): Promise<void> {
  const key = env[cloud.keyEnv];
  if (!key) return;
  await fetch(cloudUrl(cloud.url, "/v1/heartbeat"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(meta),
    signal: AbortSignal.timeout(8000),
  }).catch(() => undefined);
}

export async function cloudWhoami(
  cloud: CloudConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; workspace?: string; detail: string }> {
  const key = env[cloud.keyEnv];
  if (!key) return { ok: false, detail: `${cloud.keyEnv} is not set` };
  try {
    const res = await fetch(cloudUrl(cloud.url, "/v1/me"), {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status} from ${hostOf(cloud.url)}` };
    const body = (await res.json().catch(() => ({}))) as { workspace?: { name?: string }; name?: string };
    return { ok: true, workspace: body.workspace?.name ?? body.name, detail: "connected" };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

function channelMessage(
  agent: string,
  phase: ChannelPhase,
  rec: ChannelRecord,
  deposit: bigint,
  settled: bigint,
  refund: bigint,
): { subject: string; body: string } {
  const tx = rec.txHash ? `\ntx ${rec.txHash}` : "";
  switch (phase) {
    case "opened":
      return {
        subject: `${agent} opened a channel to ${rec.host}`,
        body:
          `${fmtUsdSmart(deposit)} is escrowed for one metered request to ${rec.host}. ` +
          `The seller settles the actual amount, up to that ceiling; anything unused comes back.` +
          tx,
      };
    case "settled":
      return {
        subject: `${agent} settled ${fmtUsdSmart(settled)} to ${rec.host}`,
        body:
          `${fmtUsdSmart(settled)} of the ${fmtUsdSmart(deposit)} escrow went to ${rec.host}; ` +
          `${fmtUsdSmart(refund)} came back to your wallet.` +
          tx,
      };
    case "refunded":
      return {
        subject: `${agent}: ${rec.host} charged nothing`,
        body: `The ${fmtUsdSmart(deposit)} escrow to ${rec.host} was returned in full: the seller settled with amount 0.` + tx,
      };
    case "orphaned":
      return {
        subject: `${agent} has an unsettled channel to ${rec.host}`,
        body:
          `${fmtUsdSmart(deposit)} is still escrowed to ${rec.host} and the seller has not settled. ` +
          `The reclaim clock (${rec.withdrawDelay}s) is running; the deposit can be taken back once it elapses.`,
      };
    case "reclaimed":
      return {
        subject: `${agent} reclaimed ${fmtUsdSmart(refund)} from ${rec.host}`,
        body:
          `The escape path returned ${fmtUsdSmart(refund)} of the ${fmtUsdSmart(deposit)} escrow to ` +
          `${rec.host} back to your wallet.` +
          tx,
      };
  }
}

export class Notifier {
  private store: NotifyStore;
  private agentName: string;
  private send: (cfg: NotifyConfig, msg: Message) => Promise<unknown>;
  private sendCloud: (cloud: CloudConfig, evt: CloudEvent) => Promise<DeliveryResult>;
  private network?: string;
  private mode?: "practice" | "live";

  constructor(
    store: NotifyStore,
    agentName: string,
    send: (cfg: NotifyConfig, msg: Message) => Promise<unknown> = deliver,
    opts: {
      sendCloud?: (cloud: CloudConfig, evt: CloudEvent) => Promise<DeliveryResult>;
      network?: string;
      mode?: "practice" | "live";
    } = {},
  ) {
    this.store = store;
    this.agentName = agentName;
    this.send = send;
    this.sendCloud = opts.sendCloud ?? ((cloud, evt) => deliverCloud(cloud, evt));
    this.network = opts.network;
    this.mode = opts.mode;
  }

  private emitCloud(
    cfg: NotifyConfig,
    kind: CloudEventKind,
    subject: string,
    body: string,
    data: Record<string, unknown>,
  ): void {
    const cloud = cfg.cloud;
    if (!cloud?.enabled) return;
    const clean = { ...data };
    if (typeof clean.url === "string") clean.url = stripQuery(clean.url);
    const evt: CloudEvent = {
      kind,
      agent: this.agentName,
      network: this.network,
      mode: this.mode,
      subject,
      body,
      data: clean,
      at: new Date().toISOString(),
    };
    void Promise.resolve(this.sendCloud(cloud, evt))
      .then((res) => {
        if (!res || res.ok) return;
        console.warn(`cloud event not delivered: ${res.detail}`);
        this.store.recordFailures([
          {
            at: new Date().toISOString(),
            agent: this.agentName,
            event: kind,
            subject,
            channel: "cloud",
            detail: res.detail,
            attempts: res.attempts ?? 1,
          },
        ]);
      })
      .catch((e: unknown) => {
        console.warn(`cloud event not delivered: ${e instanceof Error ? e.message : String(e)}`);
      });
  }

  paid(url: string, host: string, amountMicro: bigint, txHash?: string): void {
    const cfg = this.store.load();
    if (!cfg.cloud?.enabled) return;
    this.emitCloud(
      cfg,
      "payment",
      `${this.agentName} paid ${fmtUsdSmart(amountMicro)} to ${host}`,
      `${fmtUsdSmart(amountMicro)} settled to ${host}.` + (txHash ? `\ntx ${txHash}` : ""),
      { agent: this.agentName, host, url, amountMicro: amountMicro.toString(), txHash },
    );
  }

  channel(phase: ChannelPhase, rec: ChannelRecord): void {
    const cfg = this.store.load();
    if (!cfg.cloud?.enabled) return;
    const deposit = BigInt(rec.depositMicro);
    const settled = BigInt(rec.settledMicro);
    const refund = BigInt(rec.refundMicro);
    const { subject, body } = channelMessage(this.agentName, phase, rec, deposit, settled, refund);
    this.emitCloud(cfg, "channel", subject, body, {
      agent: this.agentName,
      phase,
      channelId: rec.channelId,
      host: rec.host,
      network: rec.network,
      depositMicro: rec.depositMicro,
      settledMicro: rec.settledMicro,
      refundMicro: rec.refundMicro,
      withdrawDelay: rec.withdrawDelay,
      ...(rec.txHash ? { txHash: rec.txHash } : {}),
    });
  }

  private dispatch(cfg: NotifyConfig, msg: Message): void {
    void Promise.resolve(this.send(cfg, msg))
      .then((results) => {
        if (!Array.isArray(results)) return;
        const failed = (results as DeliveryResult[]).filter((r) => r && r.ok === false);
        if (!failed.length) return;
        for (const f of failed) console.warn(`alert not delivered on ${f.channel}: ${f.detail}`);
        this.store.recordFailures(
          failed.map((f) => ({
            at: new Date().toISOString(),
            agent: this.agentName,
            event: msg.event,
            subject: msg.subject,
            channel: f.channel,
            detail: f.detail,
            attempts: f.attempts ?? 1,
          })),
        );
      })
      .catch((e: unknown) => {
        console.warn(`notification not delivered: ${e instanceof Error ? e.message : String(e)}`);
      });
  }

  spendChanged(spentMicro: bigint, budgetMicro: bigint): void {
    const cfg = this.store.load();
    if (budgetMicro <= 0n) return;
    const cloudOn = !!cfg.cloud?.enabled;
    if (!this.store.configured() && !cloudOn) return;

    const pct = Number((spentMicro * 10000n) / budgetMicro) / 100;
    const ladder = [...cfg.thresholds].sort((a, b) => a - b);
    const crossed = ladder.filter((t) => pct >= t);
    const highest = crossed.length ? crossed[crossed.length - 1]! : 0;

    if (highest === cfg.highWater) return;
    const goingUp = highest > cfg.highWater;
    this.store.save({ highWater: highest });
    if (!goingUp || highest === 0) return;

    const left = budgetMicro - spentMicro;
    const subject =
      highest >= 100
        ? `${this.agentName} has used its whole allowance`
        : `${this.agentName} has spent ${highest}% of its allowance`;
    const body =
      highest >= 100
        ? `${fmtUsdSmart(spentMicro)} of ${fmtUsdSmart(budgetMicro)} is gone and no further payments will go through.\n` +
          `Top up to keep it working, or leave it — it cannot spend anything more on its own.`
        : `${fmtUsdSmart(spentMicro)} of ${fmtUsdSmart(budgetMicro)} spent. ${fmtUsdSmart(left)} left.`;
    const data = {
      agent: this.agentName,
      percent: highest,
      spentMicro: spentMicro.toString(),
      budgetMicro: budgetMicro.toString(),
      remainingMicro: left.toString(),
    };

    this.emitCloud(cfg, "threshold", subject, body, data);

    if (!this.store.configured()) return;
    this.dispatch(cfg, { event: "threshold", subject, body, data });
  }

  blocked(host: string, rule: string, detail: string, attemptedMicro: bigint): void {
    const cfg = this.store.load();
    if (rule === "human_approval_required") return;

    const label = RULE_LABELS[rule as keyof typeof RULE_LABELS] ?? rule;
    const subject = `${this.agentName} was stopped: ${label.toLowerCase()}`;
    const body =
      `It tried to pay ${fmtUsdSmart(attemptedMicro)} to ${host} and your rails refused.\n\n` +
      `${detail}\n\nNothing moved. No action is needed unless you want to raise a limit.`;
    const data = { agent: this.agentName, host, rule, detail, attemptedMicro: attemptedMicro.toString() };

    this.emitCloud(cfg, "blocked", subject, body, data);
    if (!cfg.onBlock || !this.store.configured()) return;
    this.dispatch(cfg, { event: "blocked", subject, body, data });
  }

  approvalQueued(id: string, host: string, amountMicro: bigint, cli: string): void {
    const cfg = this.store.load();
    const subject = `${this.agentName} is waiting on you: ${fmtUsdSmart(amountMicro)} to ${host}`;
    const body =
      `It wants to pay ${fmtUsdSmart(amountMicro)} to ${host} and that is at or above your approval threshold.\n\n` +
      `Nothing has moved yet. It waits until you decide.\n\n` +
      `Approve:  ${cli} approve ${id}\nDeny:     ${cli} deny ${id}\nOr use the dashboard: ${cli} dashboard`;
    const data = { agent: this.agentName, requestId: id, host, amountMicro: amountMicro.toString() };

    this.emitCloud(cfg, "approval", subject, body, data);
    if (!cfg.onApproval || !this.store.configured()) return;
    this.dispatch(cfg, { event: "approval", subject, body, data });
  }
}
