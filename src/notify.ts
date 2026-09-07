import fs from "node:fs";
import path from "node:path";
import { fmtUsdSmart } from "./money.ts";
import { RULE_LABELS, defaultPolicy, slug } from "./policy.ts";

/**
 * Notifications: the difference between a dashboard someone has to watch and a
 * guardrail that works while they sleep.
 *
 * Every channel here is an HTTP POST made with the platform's own `fetch`, so
 * the package keeps its promise of zero runtime dependencies. Email, SMS and
 * push all go through a provider's REST API rather than SMTP or a vendor SDK
 * for the same reason.
 *
 * Three rules hold everywhere in this file:
 *
 *   1. A notification must never fail a payment. Every delivery is wrapped, all
 *      errors are swallowed into a warning, and nothing here is awaited inside
 *      the ledger lock.
 *   2. Secrets are never written to disk. The address and the provider live in
 *      `notifications.json`; the API key is read from the environment at send
 *      time, so a config file is safe to read, copy or paste into an issue.
 *   3. A delivery that fails is retried and then written down. Alerts are still
 *      best-effort — but "best effort" now means three attempts and a record,
 *      not one attempt and silence.
 */

export type NotifyEvent = "threshold" | "blocked" | "approval";

/**
 * Wallie Cloud — the hosted control plane at api.onewallie.com. It is one more
 * channel, but a different kind: instead of alerting a human when a threshold is
 * crossed, it receives *every* decision the runtime makes (paid, blocked,
 * queued) plus a liveness heartbeat, so something off this machine can tell you
 * when this machine goes quiet. It never sees a key, a signature, or the power
 * to authorize a payment.
 */
export const CLOUD_ENV = "WALLIE_CLOUD_KEY";
export const CLOUD_DEFAULT_URL = "https://api.onewallie.com";

export interface CloudConfig {
  enabled: boolean;
  /** Base URL of the control plane. */
  url: string;
  /**
   * Name of the environment variable holding the workspace key — the key itself
   * is read at send time and never written to disk, exactly like the email and
   * SMS provider keys.
   */
  keyEnv: string;
}

/** The kinds the cloud feed carries. Unlike local alerts it wants every payment, not just threshold crossings. */
export type CloudEventKind = "payment" | "blocked" | "approval";

export interface CloudEvent {
  kind: CloudEventKind;
  agent: string;
  network?: string;
  mode?: "practice" | "live";
  subject: string;
  body: string;
  /** Structured detail. Any URL field is stripped of its query string before it leaves the machine (plan D-6). */
  data: Record<string, unknown>;
  at: string;
}

export interface NotifyConfig {
  /** Any URL that accepts a JSON POST: Slack, Discord, Zapier, your own server. */
  webhookUrl?: string;
  /** Where threshold, block and approval mail is sent. */
  email?: string;
  emailProvider?: "resend" | "postmark";
  /** Verified sender. Providers reject mail from a domain you do not own. */
  emailFrom?: string;
  /** Destination phone number in E.164 form, delivered over Twilio. */
  sms?: string;
  /** The Twilio number or messaging-service SID alerts are sent from. */
  smsFrom?: string;
  /** An ntfy topic (or a full ntfy-compatible URL) for phone push. */
  pushTopic?: string;
  /**
   * A dead-man's-switch URL pinged while the agent is alive. An outside monitor
   * — healthchecks.io, Cronitor, your own cron — is what turns silence into an
   * alarm when this machine is asleep.
   */
  heartbeatUrl?: string;
  /** How often to ping it. Defaults to every 60 seconds. */
  heartbeatSeconds?: number;
  /** Wallie Cloud: an outbound feed of every decision + a liveness heartbeat. Off unless set. */
  cloud?: CloudConfig;
  /** Percentages of the allowance that trigger a heads-up. */
  thresholds: number[];
  onBlock: boolean;
  onApproval: boolean;
  /** Highest threshold already announced, so a heads-up fires once, not per call. */
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

/** Twilio needs three values; all three stay in the environment. */
export const TWILIO_ENV = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM"] as const;

/** The env var that holds the key for a provider, for help text and errors. */
export function providerEnvVar(provider: "resend" | "postmark"): string {
  return PROVIDERS[provider].env;
}

export interface DeliveryResult {
  channel: string;
  ok: boolean;
  detail: string;
  /** How many attempts it took, or how many it burned before giving up. */
  attempts: number;
}

export interface DeliveryFailure {
  at: string;
  agent: string;
  event: NotifyEvent | "heartbeat" | "payment";
  subject: string;
  channel: string;
  detail: string;
  attempts: number;
}

export class NotifyStore {
  private file: string;
  private failureFile: string;

  /** Alert settings are per agent; the first agent in a directory keeps the unsuffixed file. */
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
      // A hand-edited file that no longer parses must not take the agent down.
      return { ...defaultNotifyConfig };
    }
  }

  save(patch: Partial<NotifyConfig>): NotifyConfig {
    const next = { ...this.load(), ...patch };
    fs.writeFileSync(this.file, JSON.stringify(next, null, 2));
    return next;
  }

  /** True when at least one channel is configured. */
  configured(): boolean {
    const c = this.load();
    return Boolean(c.webhookUrl || c.email || c.sms || c.pushTopic);
  }

  /**
   * Records alerts that never arrived. The ledger stays the record of what the
   * agent *did*; this is the record of what you were not told about it.
   */
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
  /** One line, suitable for a phone's lock screen. */
  subject: string;
  /** A few lines of plain text. No markup: it has to survive every channel. */
  body: string;
  /** Structured detail for a webhook consumer that wants to act on it. */
  data: Record<string, unknown>;
}

/** One attempt at one channel. `retryable` separates "the network blinked" from "your key is wrong". */
type Attempt = { ok: boolean; detail: string; retryable: boolean };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retries only what retrying can fix: timeouts, dropped connections, 429s and
 * 5xx. A 401 is retried zero times, because three identical rejections help
 * nobody and delay the record that the key is wrong.
 */
async function withRetry(channel: string, attempt: () => Promise<Attempt>, attempts = 3): Promise<DeliveryResult> {
  let last: Attempt = { ok: false, detail: "not attempted", retryable: false };
  for (let i = 1; i <= attempts; i++) {
    last = await attempt();
    if (last.ok) return { channel, ok: true, detail: last.detail, attempts: i };
    if (!last.retryable) return { channel, ok: false, detail: last.detail, attempts: i };
    if (i < attempts) await sleep(500 * 2 ** (i - 1));
  }
  return { channel, ok: false, detail: `${last.detail} (after ${attempts} attempts)`, attempts };
}

/** HTTP status codes worth trying again. */
function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Sends a message on every configured channel.
 *
 * Resolves once all channels have settled, and never rejects. Callers that do
 * not want to wait can ignore the promise; callers that do — `notify test` —
 * get the per-channel outcome back.
 */
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
      // `text` is what Slack and Discord render; the rest is for everyone else.
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

/**
 * SMS over Twilio's REST API. Twilio is the one channel that costs money per
 * message, so the body is trimmed to the subject plus the single most useful
 * line rather than the full text.
 */
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

/**
 * Push over ntfy. Chosen because it needs no account and no key: a topic name
 * is the whole setup, which is the only push channel a zero-dependency tool can
 * honestly promise works in one command.
 */
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

/**
 * Pings a dead-man's-switch URL while this process lives.
 *
 * This is the honest answer to "who tells me when my laptop is shut?" — nothing
 * running on that laptop can. An outside monitor watching for the ping to stop
 * can. Returns a stop function; the timer is unref'd so it never keeps a
 * process alive on its own.
 */
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

/**
 * Strips the query string from a URL so a value that may be personal — `?city=lisbon`,
 * `?token=…` — never leaves the machine on its way to the cloud (plan D-6). Falls
 * back to a plain split for anything that is not a parseable URL.
 */
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

/** POSTs one decision to the cloud's event feed. The key is read from the environment at send time. */
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
    return res.ok
      ? { ok: true, detail: `sent to ${hostOf(cloud.url)}`, retryable: false }
      : { ok: false, detail: `HTTP ${res.status} from ${hostOf(cloud.url)}`, retryable: retryableStatus(res.status) };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e), retryable: true };
  }
}

/** Sends one cloud event with the same retry policy as every other channel. Exported for `notify test`. */
export function deliverCloud(cloud: CloudConfig, evt: CloudEvent, env: NodeJS.ProcessEnv = process.env): Promise<DeliveryResult> {
  return withRetry("cloud", () => postCloudEvent(cloud, evt, env));
}

/** What a heartbeat tells the cloud about the agent that is still alive. */
export interface CloudHeartbeat {
  agent: string;
  network?: string;
  mode?: "practice" | "live";
  version?: string;
}

/**
 * Beats to the cloud's `/v1/heartbeat` while this process lives, so the watchdog
 * on the other end can raise the alarm this machine cannot raise about itself.
 * The timer is unref'd — it never keeps a process alive on its own — and returns
 * a stop function. A no-op when the cloud channel is off.
 */
export function startCloudHeartbeat(
  cloud: CloudConfig | undefined,
  meta: CloudHeartbeat,
  opts: {
    env?: NodeJS.ProcessEnv;
    everyMs?: number;
    send?: (cloud: CloudConfig, meta: CloudHeartbeat, env: NodeJS.ProcessEnv) => Promise<unknown>;
  } = {},
): () => void {
  if (!cloud?.enabled) return () => undefined;
  const env = opts.env ?? process.env;
  const send = opts.send ?? postCloudHeartbeat;
  const everyMs = Math.max(250, opts.everyMs ?? 60_000);
  const beat = () => void Promise.resolve(send(cloud, meta, env)).catch(() => undefined);
  beat();
  const timer = setInterval(beat, everyMs);
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

/**
 * Asks the cloud who this key belongs to (`GET /v1/me`), so `notify` and `status`
 * can say "connected as <workspace>" rather than just "a key is set".
 */
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

/**
 * Decides what is worth telling a human about, and remembers what it already
 * said.
 *
 * The threshold rule is a high-water mark rather than a per-call comparison:
 * crossing 80% announces itself once, not on every payment after it. Topping up
 * the allowance moves the mark back down, so the next 80% is announced too.
 */
export class Notifier {
  private store: NotifyStore;
  private agentName: string;
  /** Overridable so tests can assert without reaching the network. */
  private send: (cfg: NotifyConfig, msg: Message) => Promise<unknown>;
  /** The cloud transport, overridable for tests, separate from the human channels. */
  private sendCloud: (cloud: CloudConfig, evt: CloudEvent) => Promise<DeliveryResult>;
  /** Tagged onto every cloud event so the feed knows which rail this agent runs on. */
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

  /**
   * Sends one decision to the cloud feed, if the channel is on. Independent of
   * the human channels and of the threshold logic: the cloud wants every paid,
   * blocked and queued row, not only the ones worth waking a human for. Never
   * awaited, never able to fail a payment; a failure is warned and written down.
   */
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

  /**
   * Call after a payment settles. The cloud feed records every paid row (the
   * local channels do not — they only speak up at a threshold). Cloud-only.
   */
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

  private dispatch(cfg: NotifyConfig, msg: Message): void {
    // Deliberately not awaited: a slow webhook must not slow down a payment,
    // and a broken one must not fail it. What it can do is leave a trace.
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

  /** Call after a payment settles. Announces 50/80/100% of the allowance once each. */
  spendChanged(spentMicro: bigint, budgetMicro: bigint): void {
    const cfg = this.store.load();
    if (!this.store.configured()) return;
    if (budgetMicro <= 0n) return;

    const pct = Number((spentMicro * 10000n) / budgetMicro) / 100;
    const ladder = [...cfg.thresholds].sort((a, b) => a - b);
    const crossed = ladder.filter((t) => pct >= t);
    const highest = crossed.length ? crossed[crossed.length - 1]! : 0;

    if (highest === cfg.highWater) return;
    this.store.save({ highWater: highest });
    // Falling below a mark (a top-up raised the budget) just rearms it quietly.
    if (highest < cfg.highWater || highest === 0) return;

    const left = budgetMicro - spentMicro;
    const subject =
      highest >= 100
        ? `${this.agentName} has used its whole allowance`
        : `${this.agentName} has spent ${highest}% of its allowance`;
    this.dispatch(cfg, {
      event: "threshold",
      subject,
      body:
        highest >= 100
          ? `${fmtUsdSmart(spentMicro)} of ${fmtUsdSmart(budgetMicro)} is gone and no further payments will go through.\n` +
            `Top up to keep it working, or leave it — it cannot spend anything more on its own.`
          : `${fmtUsdSmart(spentMicro)} of ${fmtUsdSmart(budgetMicro)} spent. ${fmtUsdSmart(left)} left.`,
      data: {
        agent: this.agentName,
        percent: highest,
        spentMicro: spentMicro.toString(),
        budgetMicro: budgetMicro.toString(),
        remainingMicro: left.toString(),
      },
    });
  }

  /** Call whenever a rail refuses a payment. */
  blocked(host: string, rule: string, detail: string, attemptedMicro: bigint): void {
    const cfg = this.store.load();
    // An approval block already sends its own, more actionable message — on both
    // the human channels and the cloud — so this one stays quiet for it.
    if (rule === "human_approval_required") return;

    const label = RULE_LABELS[rule as keyof typeof RULE_LABELS] ?? rule;
    const subject = `${this.agentName} was stopped: ${label.toLowerCase()}`;
    const body =
      `It tried to pay ${fmtUsdSmart(attemptedMicro)} to ${host} and your rails refused.\n\n` +
      `${detail}\n\nNothing moved. No action is needed unless you want to raise a limit.`;
    const data = { agent: this.agentName, host, rule, detail, attemptedMicro: attemptedMicro.toString() };

    // The cloud feed gets every block, regardless of the human alert preferences.
    this.emitCloud(cfg, "blocked", subject, body, data);
    if (!cfg.onBlock || !this.store.configured()) return;
    this.dispatch(cfg, { event: "blocked", subject, body, data });
  }

  /** Call when a payment is parked for a human decision. */
  approvalQueued(id: string, host: string, amountMicro: bigint, cli: string): void {
    const cfg = this.store.load();
    const subject = `${this.agentName} is waiting on you: ${fmtUsdSmart(amountMicro)} to ${host}`;
    const body =
      `It wants to pay ${fmtUsdSmart(amountMicro)} to ${host} and that is at or above your approval threshold.\n\n` +
      `Nothing has moved yet. It waits until you decide.\n\n` +
      `Approve:  ${cli} approve ${id}\nDeny:     ${cli} deny ${id}\nOr use the dashboard: ${cli} dashboard`;
    const data = { agent: this.agentName, requestId: id, host, amountMicro: amountMicro.toString() };

    // The cloud feed gets every queued payment, regardless of the human alert preferences.
    this.emitCloud(cfg, "approval", subject, body, data);
    if (!cfg.onApproval || !this.store.configured()) return;
    this.dispatch(cfg, { event: "approval", subject, body, data });
  }
}
