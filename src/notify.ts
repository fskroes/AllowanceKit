import fs from "node:fs";
import path from "node:path";
import { fmtUsdSmart } from "./money.ts";
import { RULE_LABELS } from "./policy.ts";

/**
 * Notifications: the difference between a dashboard someone has to watch and a
 * guardrail that works while they sleep.
 *
 * Every channel here is an HTTP POST made with the platform's own `fetch`, so
 * the package keeps its promise of zero runtime dependencies. Email goes
 * through a provider's REST API rather than SMTP for the same reason.
 *
 * Two rules hold everywhere in this file:
 *
 *   1. A notification must never fail a payment. Every delivery is wrapped, all
 *      errors are swallowed into a warning, and nothing here is awaited inside
 *      the ledger lock.
 *   2. Secrets are never written to disk. The address and the provider live in
 *      `notifications.json`; the API key is read from the environment at send
 *      time, so a config file is safe to read, copy or paste into an issue.
 */

export type NotifyEvent = "threshold" | "blocked" | "approval";

export interface NotifyConfig {
  /** Any URL that accepts a JSON POST: Slack, Discord, Zapier, your own server. */
  webhookUrl?: string;
  /** Where threshold, block and approval mail is sent. */
  email?: string;
  emailProvider?: "resend" | "postmark";
  /** Verified sender. Providers reject mail from a domain you do not own. */
  emailFrom?: string;
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
};

const PROVIDERS = {
  resend: { env: "RESEND_API_KEY", url: "https://api.resend.com/emails" },
  postmark: { env: "POSTMARK_API_TOKEN", url: "https://api.postmarkapp.com/email" },
} as const;

/** The env var that holds the key for a provider, for help text and errors. */
export function providerEnvVar(provider: "resend" | "postmark"): string {
  return PROVIDERS[provider].env;
}

export class NotifyStore {
  private file: string;

  constructor(stateDir: string) {
    fs.mkdirSync(stateDir, { recursive: true });
    this.file = path.join(stateDir, "notifications.json");
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
    return Boolean(c.webhookUrl || c.email);
  }
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
): Promise<{ channel: string; ok: boolean; detail: string }[]> {
  const jobs: Promise<{ channel: string; ok: boolean; detail: string }>[] = [];
  if (cfg.webhookUrl) jobs.push(postWebhook(cfg.webhookUrl, msg));
  if (cfg.email) jobs.push(sendEmail(cfg, msg, env));
  return Promise.all(jobs);
}

async function postWebhook(url: string, msg: Message): Promise<{ channel: string; ok: boolean; detail: string }> {
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
      ? { channel: "webhook", ok: true, detail: `${res.status}` }
      : { channel: "webhook", ok: false, detail: `HTTP ${res.status} from ${new URL(url).host}` };
  } catch (e) {
    return { channel: "webhook", ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

async function sendEmail(
  cfg: NotifyConfig,
  msg: Message,
  env: NodeJS.ProcessEnv,
): Promise<{ channel: string; ok: boolean; detail: string }> {
  const provider = cfg.emailProvider ?? "resend";
  const { env: envVar, url } = PROVIDERS[provider];
  const key = env[envVar];
  if (!key) return { channel: "email", ok: false, detail: `${envVar} is not set, so no mail was sent` };

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
    if (res.ok) return { channel: "email", ok: true, detail: `sent to ${cfg.email}` };
    const detail = await res.text().catch(() => "");
    return { channel: "email", ok: false, detail: `HTTP ${res.status} from ${provider}${detail ? `: ${detail.slice(0, 200)}` : ""}` };
  } catch (e) {
    return { channel: "email", ok: false, detail: e instanceof Error ? e.message : String(e) };
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

  constructor(
    store: NotifyStore,
    agentName: string,
    send: (cfg: NotifyConfig, msg: Message) => Promise<unknown> = deliver,
  ) {
    this.store = store;
    this.agentName = agentName;
    this.send = send;
  }

  private dispatch(cfg: NotifyConfig, msg: Message): void {
    // Deliberately not awaited: a slow webhook must not slow down a payment,
    // and a broken one must not fail it.
    void Promise.resolve(this.send(cfg, msg)).catch((e: unknown) => {
      console.warn(`notification not delivered: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  /** Call after a payment settles. Announces 50/80/100% of the allowance once each. */
  spendChanged(spentMicro: bigint, budgetMicro: bigint): void {
    const cfg = this.store.load();
    if (!cfg.webhookUrl && !cfg.email) return;
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
    if (!cfg.onBlock || (!cfg.webhookUrl && !cfg.email)) return;
    // An approval block already sends its own, more actionable message.
    if (rule === "human_approval_required") return;

    const label = RULE_LABELS[rule as keyof typeof RULE_LABELS] ?? rule;
    this.dispatch(cfg, {
      event: "blocked",
      subject: `${this.agentName} was stopped: ${label.toLowerCase()}`,
      body:
        `It tried to pay ${fmtUsdSmart(attemptedMicro)} to ${host} and your rails refused.\n\n` +
        `${detail}\n\nNothing moved. No action is needed unless you want to raise a limit.`,
      data: {
        agent: this.agentName,
        host,
        rule,
        detail,
        attemptedMicro: attemptedMicro.toString(),
      },
    });
  }

  /** Call when a payment is parked for a human decision. */
  approvalQueued(id: string, host: string, amountMicro: bigint, cli: string): void {
    const cfg = this.store.load();
    if (!cfg.onApproval || (!cfg.webhookUrl && !cfg.email)) return;
    this.dispatch(cfg, {
      event: "approval",
      subject: `${this.agentName} is waiting on you: ${fmtUsdSmart(amountMicro)} to ${host}`,
      body:
        `It wants to pay ${fmtUsdSmart(amountMicro)} to ${host} and that is at or above your approval threshold.\n\n` +
        `Nothing has moved yet. It waits until you decide.\n\n` +
        `Approve:  ${cli} approve ${id}\nDeny:     ${cli} deny ${id}\nOr use the dashboard: ${cli} dashboard`,
      data: { agent: this.agentName, requestId: id, host, amountMicro: amountMicro.toString() },
    });
  }
}
