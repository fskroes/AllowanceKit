# AllowanceKit / Wallie — release-readiness plan

Written 2026-09-07 against `feat/live-money-0.4.0` (commit `6acd145`); **updated the same
day after `allowance-kit@0.5.0` shipped** (`main` at `a827b40`). This document is
the work order for making the product **released** (a trustworthy, versioned, CI-tested
package that real money can go through) and **buyable** (the €20/mo Wallie Cloud that the
website already sells actually exists, provisions itself, and delivers something a laptop
cannot).

It is written for implementing agents. Every ticket has an owner, a dependency list, the
files it touches, and a "done when" that can be checked mechanically. Terms in **bold
italics** on first use are defined in [GLOSSARY.md](GLOSSARY.md). Read the glossary first.

**Status (2026-09-08, post-0.5.0).** Deliverable **A is shipped**: every `R`, `M`, `L` ticket
and `C-05` is done and marked `✓` below with its commit. Deliverable **C's core now exists**:
the cloud repo `~/dev/wallie-cloud` was created and pushed to the private GitHub repo
`fskroes/wallie-cloud` (D-10, CI green on `main` 2026-09-08) and `C-01` (schema + migrations) and
`C-03` (ingest endpoints + `/v1/me`) are done; `C-04` (fan-out + watchdog) is **code-complete
and tested with fakes** — the watchdog silent/back transitions and the delivery retry
classification pass, but the real Resend/Twilio sends are unverified because they need
Fernando's provider credentials. The suite is 21/21 including a `runtime-compat` test that
drives the *actual published 0.5.0 client* against the new handlers (the C-03 "done when"
proof). Still open: `C-02`, `C-06`–`C-08`, `C-10`, the Neon-branch half of `C-09`, `B-*`,
`S-*`, and any step needing a live `api.onewallie.com` (Stripe, DNS, deploy). **New blocker
found 2026-09-08 (C-08):** the Vercel team is on the **Hobby** plan, which refuses the
per-minute cron the watchdog needs and forbids commercial use; upgrading to Pro is a human
step (§6 item 3) before anything can be deployed. The §7 gate is still half met — released,
the cloud core is built and CI-tested but not yet deployed or buyable.

**One rule that changed because 0.5.0 is public:** the runtime side of the cloud (`C-05`) is
published and cannot be reshaped without a release, so **the server adapts to the runtime's
wire contract (§3.1.1), never the reverse.** Read §3.1.1 before touching `C-01`, `C-03`, `C-04`.

---

## 0. How to work from this document

**Repo conventions (non-negotiable, from CONTRIBUTING.md and the code):**

- Zero runtime dependencies in `allowance-kit`. `viem` stays an optional peer dependency.
  Anything that needs a library must argue for it in the PR, and the answer is usually no.
- TypeScript sources run natively on Node ≥ 24 (`node src/cli.ts`). The npm package ships
  compiled `dist/` for Node ≥ 20.11. `npm run build` is `tsc -p tsconfig.json`.
- Tests are `node --test "test/*.test.ts"`, zero-dependency, in `test/`. As of today: 65
  pass. A ticket that touches a money path (`chain.ts`, `seller.ts`, `payer.ts`, `live.ts`,
  `wallet.ts`, `reservations.ts`, `policy.ts`) must add tests proving: happy path settles
  exactly once, replay is rejected, insufficient funds are rejected, the relevant rail blocks.
- No secret is ever written to disk by the tool. Keys come from the environment. Config
  files (`notifications.json`, `mode.json`, `config.json`) must stay safe to paste in a bug
  report.
- x402 wire shapes in `types.ts` stay v1-compatible unless a ticket explicitly says spec bump.
- Plain-English user-facing text. Rules are shown through `RULE_LABELS`, never as raw enum
  names. "Practice money" and "REAL MONEY" banners must survive every change.
- The README is the changelog today: each release gets a "Changes in X.Y.Z" section
  (breaking / fixed / added). Ticket R-03 adds a real `CHANGELOG.md`; until then keep both.
- Money amounts are integer *micro-dollars* (`bigint`, 1 USD = 1_000_000n). Never floats.

**Owner labels:**

- `agent` — an implementing agent can do the whole ticket.
- `human` — only Fernando can do it (funding a wallet, entering credentials into Stripe /
  Vercel / npm, DNS, accepting provider terms). Agents must never move funds, enter
  credentials, or accept terms on his behalf. They prepare everything up to that step and
  hand over an exact checklist.
- `agent+human` — agent builds, human flips a switch at the end.

**Ticket sizes:** S (< 2 h), M (half a day), L (1–2 days). Ordering inside a workstream is
the implementation order. Workstreams can run in parallel where the dependency list allows.

**Definition of "released and buyable" (the exit gate, section 7):** all `R`, `M`, `L`,
`C`, `B`, `S` tickets marked *gate* are done. `O` and `X` tickets can follow launch.

---

## 1. Verified current state (2026-09-08)

| Area | State |
|---|---|
| Package | `allowance-kit@0.5.0` published 2026-09-07 (`latest`), from `main` (`8c943b9`, tag `v0.5.0`). ~~0.4.0 unmerged, unpublished~~ |
| Alias | `wallie@0.5.0` on npm pins `allowance-kit@^0.5.0`. Source now lives in `packages/wallie/` (R-05) and is published by `scripts/release.sh`. |
| Tags | Six annotated tags, `v0.1.0`–`v0.5.0` (R-01). |
| CI | `.github/workflows/ci.yml` — build, pack, audit on Node 20.11/22/24, full tests on 24 (R-02). Green on `main`. |
| Tests | 91/91 pass locally on Node 24 (`node --test "test/*.test.ts"`). |
| Release docs | `CHANGELOG.md` (Keep a Changelog), `SECURITY.md`, README badge (R-03). Release procedure: `docs/release-0.5.0-runbook.md`. **Known drift:** the 0.5.0 changelog's "Known" section was written before M-02/L-02 landed and still says no third-party seller was paid and mainnet never ran; both are false. Correct it in the next release entry, do not rewrite the published one. |
| Practice path | Complete: CLI, SDK, dashboard, demo, alerts, approvals with expiring grants, multi-agent state dirs. |
| Live path (SDK) | `createLiveAgent` signs real x402 **v1** EVM payloads (EIP-3009) on `base-sepolia` and `base`. On-chain USDC balance check over public JSON-RPC, 15 s cache, fail-open. Network is a hard constraint. |
| Live path (CLI) | `init --live [--network base-sepolia\|base] [--rpc]`, `pay <url>`, `doctor` (L-03/L-04/L-05, commit `eab18f5`). Mainnet guardrails: typed confirmation or `--yes`, top-up > $50 needs `--yes`, `policy` prints a REAL MONEY line (M-04). Key never written to disk (tested). |
| Mainnet | **Exercised 2026-09-07 (M-02).** `scripts/canary.ts --buyer --network base` settled a real $0.01 USDC payment on Base; tx `0x044245c0eb2d88350bf80d936e53185056f78f3afcf28eac942332894302648e`, recorded in `docs/canary-runs/2026-09-07-base.md`. Testnet canary passed 2026-08-29. |
| x402 version | **Buyer speaks v1 and v2** (L-02): detects `x402Version`, reads the challenge from the `PAYMENT-REQUIRED` header or body, answers with `PAYMENT-SIGNATURE`, maps CAIP-2 ↔ bare names, picks the cheapest plain-USDC `exact` offer on its own chain, echoes the offer verbatim. The live ecosystem is v2-only (L-01, `docs/x402-compat.md`). **Seller (`paymentGate`) is still v1 only**; `CdpFacilitator` has a v2 body that has not been round-tripped against real CDP. Settled against a real third-party v2 seller (Mart402, Base Sepolia, `docs/canary-runs/2026-09-07-base-sepolia-mart402.md`). |
| Facilitator | Coinbase CDP only (`facilitator-cdp.ts`, ES256 JWT). Sellers' side. Buyers depend on whatever facilitator the seller uses. |
| Dashboard | Loopback only; reads **and** mutations token-gated; state carries every agent and the UI has an agent switcher (L-06, `01b8cdb`). |
| Cloud channel (runtime) | **Shipped in 0.5.0** (C-05, `49d5610`): `notify cloud <wk_…>`, `CloudEvent` feed to `POST /v1/events`, 60 s heartbeat to `POST /v1/heartbeat` from `createAgent`/`createLiveAgent`, `GET /v1/me` for "connected as". Default URL `https://api.onewallie.com`, which **does not resolve to anything yet**. Exact contract in §3.1.1. |
| Wallie Cloud (service) | **Core built and CI-green, not deployed.** Repo `~/dev/wallie-cloud` (own git, `15689aa`) is pushed to the **private** GitHub repo `fskroes/wallie-cloud`; CI (Node 24: test + typecheck + audit) passed on `main` 2026-09-08. Built: schema + migrations (C-01), ingest `POST /v1/events`, `POST /v1/heartbeat`, `GET /v1/me` (C-03), fan-out + watchdog (C-04, tested with fake fetch). 21/21 tests on in-memory PGlite incl. a runtime-compat test against the published 0.5.0 client. **No Vercel project, no deploy, no DNS** for `api.`/`app.onewallie.com`; no Stripe (C-02), templates (C-06), app (C-07), or live provider sends yet. The Vercel team (`fernando-silva-kroes-projects`) is on **Hobby**, which cannot run the `* * * * *` cron and is non-commercial — Pro upgrade required before C-08. |
| Website | `~/dev/onewallie-site` (Vercel, static + 2 functions), unchanged since `3d7d848`. Sells **"€20 /mo workspace + 1% volume"** through one Stripe Payment Link (`buy.stripe.com/14AcN4…`) in six places (3× `index.html`, 3× `docs.html`). The pricing card lists **multi-agent allowances & team roles, Slack alerts, fiat top-up, spend analytics, managed facilitator routing, free under $25/mo** — none of which is in any `C` ticket. The "How Wallie Cloud works" block describes a policy plane and managed settlement, not the §3.2 control plane. A buyer today gets a Stripe receipt and a "personal onboarding within 24h" promise (`index.html:287`, `:373`). `terms.html:52` also states the 1% volume fee. `api/waitlist.js` creates Stripe customers; `api/mrr.js` reads MRR. |
| Site docs | `docs.html:178` roadmap note still says "CDP facilitator adapter → npm package → Wallie Cloud … subscribers vote on the roadmap" although the first two shipped. The tutorial ends at "the road to real money" (`docs.html:171`) with no `init --live` / `pay` / `notify cloud` chapter (S-03). The site half of M-03 is folded into S-02. |
| Business model | BUSINESS.md: Cloud = hosted alerting that fires when your machine is off + SMS + escalation; compliance pack (enterprise, by email); facilitator revenue share (future). Price settled at €20. |
| Legal | `privacy.html` lists processors Stripe, Vercel, GitHub, Google Fonts; retention covers waitlist emails and billing only. No Neon, Resend, Twilio, no event-data retention, no deletion-after-cancel — all B-02. `terms.html` has the 1% volume fee and "no partial-period refunds" (B-02 wants a 14-day first-month refund). Both dated 2026-08-26. |
| Support | `SUPPORT.md` points at GitHub Issues/Discussions and hello@onewallie.com. **Discussions is enabled** on `fskroes/AllowanceKit` (verified via the GitHub API 2026-09-07); O-03's check is satisfied. |

**The two facts that decide the plan:**

1. ~~The open-source runtime is close to done.~~ **Done in 0.5.0**: mainnet proof, a CLI
   front door for real money, release hygiene, and the client half of the cloud channel.
2. The thing being sold still does not exist. Either build a minimal Wallie Cloud that delivers
   exactly what BUSINESS.md says is paid (alerts that fire when the laptop is off), or stop
   selling it. This plan builds it, scoped to the minimum that is honestly worth €20. Until
   it ships, every Stripe purchase is a manual-onboarding promise with nothing behind it.

---

## 2. Release definition

Three deliverables, shipped together:

**A. `allowance-kit@0.5.0` + `wallie@0.5.0`** — "mainnet-proven". Same runtime as 0.4.0 plus:
a CLI live mode, a mainnet canary that has actually passed, x402 version compatibility
verified against real sellers, CI, tags, changelog, security policy, provenance-signed
publish. Optional `cloud` notify channel that talks to deliverable B.

**B. Wallie Cloud v1** — a hosted *control plane* at `api.onewallie.com` + `app.onewallie.com`
that a purchase provisions automatically within minutes. It receives *ledger events* and
*heartbeats* from any number of local agents and is the one component that can alert when
the agent's machine is silent. Non-custodial: it never sees a private key, never signs,
never moves money. Flat €20/mo in v1. The "1% of volume" is deferred (decision D-2).

**C. onewallie.com** — the funnel matches what exists: purchase leads to a working account,
docs describe the cloud channel, the roadmap note is current, pricing text matches Stripe.

---

## 3. Target architecture

### 3.1 Runtime (all of this exists as of 0.5.0)

```
 human ─── CLI (allowance-kit / wallie) ─── local dashboard (127.0.0.1:4030)
                    │                              │
                    ▼  reads/writes                ▼
            .allowance/ state directory  (config.json, agent.json, ledger.jsonl,
                    │                     approvals, reservations, mode.json,
                    │                     notifications.json, dashboard-token)
                    ▼
 agent code ──▶ payingFetch(ctx, url) ── policy rails ── reservation ── sign ── settle
                    │                                        │
                    │  402 challenge (x402 v1 or v2, seller   │ live: EIP-3009 via viem
                    │  chooses; buyer answers in kind, L-02 ✓)│ practice: MockChain
                    ▼                                        ▼
              seller API  ──▶  facilitator (CDP)  ──▶  USDC on Base / Base Sepolia
                                                            ▲
                    live balance check (JSON-RPC, 15 s cache)┘
                    │
                    ▼  after every decision (never inside the ledger lock)
              Notifier ──▶ webhook · email · sms · push · heartbeat   (human channels)
                       ──▶ cloud (C-05 ✓) ──▶ Wallie Cloud            (every decision + beat)
```

Runtime pieces added in 0.5.0 (all shipped):

- **CLI live mode** (`init --live --network <net>`, L-03 ✓): derives the payer address from
  `AGENT_PRIVATE_KEY` in the environment, writes `mode.json`, never writes the key.
  `pay <url>` (L-04 ✓) lets a non-coder make one real payment from the shell; `doctor`
  (L-05 ✓) checks the setup.
- **`cloud` notify channel** (C-05 ✓): every *decision* (`payment`, `blocked`, `approval` —
  **not** the `threshold` heads-ups, see C-10) plus a heartbeat every 60 s is POSTed to the
  cloud with a *workspace key*. It is one more entry in `NotifyConfig`; config holds the key
  **by environment variable name**, not value (`WALLIE_CLOUD_KEY`).
- **Heartbeat lives in the runtime** (C-05 ✓): `createAgent` / `createLiveAgent` start the
  cloud beat (unref'd) and expose `stopHeartbeat()`. The older `notify heartbeat <url>`
  dead-man's switch is unchanged and still only pings while `dashboard` runs.

#### 3.1.1 The cloud wire contract as shipped in 0.5.0 (`src/notify.ts`, tests in `test/cloud.test.ts`)

This is what `api.onewallie.com` must accept. It is frozen by the 0.5.0 publish; change it
only with a runtime release and a version-negotiation story.

**Authentication.** Every request carries `Authorization: Bearer <key>`. The CLI only
accepts keys matching `^wk_(live|test)_[A-Za-z0-9]{8,}$` (`src/cli.ts`), so C-02 must mint
keys in that alphabet (32 random bytes base32 = 52 chars of `A–Z2–7`, fine). The key is read
from `process.env[keyEnv]` at send time; the config on disk is exactly
`{"cloud":{"enabled":true,"url":"https://api.onewallie.com","keyEnv":"WALLIE_CLOUD_KEY"}}`.

**`POST /v1/events`** — body is one `CloudEvent`:

```ts
{ kind: "payment" | "blocked" | "approval",
  agent: string,                      // agent name
  network?: string,                   // "base" | "base-sepolia" | undefined (practice)
  mode?: "practice" | "live",         // practice agents send too — show the badge, do not alert as money
  subject: string, body: string,      // the same human-readable text the webhook channel sends
  data: Record<string, unknown>,      // per kind, below; `data.url` has its query string stripped client-side
  at: string }                        // ISO-8601, the runtime's clock → events.occurred_at
```

`data` per kind (all money as decimal strings of micro-dollars):

| kind | `data` fields | maps to `events` columns |
|---|---|---|
| `payment` | `agent, host, url, amountMicro, txHash?` | `host`, `amount_micro ← amountMicro`, `tx_hash` |
| `blocked` | `agent, host, rule, detail, attemptedMicro` | `host`, `rule`, `amount_micro ← attemptedMicro` |
| `approval` | `agent, requestId, host, amountMicro` | `host`, `request_id`, `amount_micro ← amountMicro` |

`rule` is a `PolicyRule` enum name. **The real values (`src/policy.ts`) are `kill_switch`,
`host_not_allowlisted`, `host_blocked`, `per_call_cap`, `velocity_circuit_breaker`,
`budget_exhausted`, `insufficient_funds`, `settlement_rejected`** — this paragraph originally
listed `killSwitch`/`blockedHosts`, which are wrong, and `test/cloud.test.ts` even sends
`"host_not_allowed"`, in no enum at all. **So the server stores `rule` as free text and never
validates it** (D-9); the cloud implementation (`lib/ingest.ts`, `sql/001_init.sql`) does exactly
this. `human_approval_required` never arrives as `blocked` because the runtime sends `approval`
instead. Store the whole object in `payload jsonb` as well.

**`POST /v1/heartbeat`** — body `{ agent: string, network?: string, mode?: "practice"|"live",
version?: string }`. **`version` is not sent by 0.5.0** (`wallet.ts`/`live.ts` do not pass it;
C-10 adds it). No timestamp: use receipt time for `last_seen_at`. Sent immediately on runtime
creation and then every 60 s; the timer is unref'd, so a one-shot CLI command produces exactly
one beat and exits. Failures are swallowed silently — the runtime never retries a heartbeat.

**`GET /v1/me`** — the runtime reads `body.workspace.name` (fallback `body.name`) and prints
"connected as <name>". Anything non-2xx is reported as `HTTP <status>`. This call is also what
`notify test` uses for the cloud row — **it never posts a test event** — so gate line
"`notify test` shows `delivered cloud`" is satisfied by `/v1/me` alone. `status` and `notify`
call it too, so it must be cheap and must not count toward the rate limit in any way a user
would notice.

**Responses the runtime understands.** Any 2xx is success (body ignored). Events are retried
**3 times with 500 ms / 1 s backoff** only on network errors and on `408, 425, 429, 5xx`; every
other 4xx (`401`, `402`, `403`, `413`) is final and lands in `notify-failures.jsonl` with
`channel: "cloud"`. `Retry-After` is **not** parsed. Per-attempt timeout is 8 s, so answer
before doing any fan-out. `402` for a revoked or non-active workspace (C-03) is therefore
correct: not retried, surfaced to the user by `status`.

**Privacy.** Only the `url` key of `data` is stripped client-side (`stripQuery`); the server
must strip the query string from **any** string field that parses as a URL, and must cap the
body (8 KB, C-03). No key, signature or request body ever leaves the machine.

### 3.2 Wallie Cloud v1 (new)

```
                     Stripe (Payment Link → Checkout)
                              │ webhook: checkout.session.completed,
                              │          customer.subscription.{updated,deleted}
                              ▼
   ┌──────────────────────────────────────────────────────────────┐
   │ api.onewallie.com   (Vercel Functions, Node, zero framework)   │
   │                                                                │
   │  POST /v1/stripe/webhook   → provision / suspend workspace     │
   │  POST /v1/events           → ingest NotifyEvent  (Bearer key)  │
   │  POST /v1/heartbeat        → touch agent.last_seen (Bearer key)│
   │  GET  /v1/me               → workspace, agents, key status     │
   │  POST /v1/auth/magic-link  → email a sign-in link              │
   │  GET  /v1/auth/callback    → session cookie                    │
   │  POST /v1/alerts/rules     → where to send what                │
   │  cron every minute: watchdog → "agent X silent for N min"      │
   │                                                                │
   │  fan-out (Wallie's own provider keys): Resend email, Twilio    │
   │  SMS, Slack/Discord webhook. Retried, delivery recorded.       │
   └───────────────┬────────────────────────────────────────────────┘
                   ▼
        Postgres (Neon via Vercel Marketplace)
        workspaces · workspace_keys · agents · events · alert_rules
        deliveries · magic_links · sessions · stripe_events · rate_limits
        (Stripe customer/subscription ids live on `workspaces`, C-01)

   app.onewallie.com  (static HTML + fetch, same wallie.css design system)
        sign in by magic link → key reveal / rotate → agents & last seen
        → event feed (read-only) → alert rules → billing portal link
```

Trust boundaries:

- The cloud never receives a private key, a signed payload, or the ability to authorize a
  payment. It receives *decisions already made* (paid / blocked / queued) and liveness.
- Event payloads strip query strings from URLs before leaving the machine (`?city=lisbon`
  can be personal data). C-05 enforces this client-side (done, `data.url` only); C-03 enforces
  it server-side on every URL-shaped field.
- Practice-mode agents report too (`mode: "practice"`). The cloud shows them with a
  "practice" badge and must never word an alert about them as real money.
- Workspace keys are shown once, stored hashed (SHA-256), rotatable.
- Approving a queued payment **from the cloud is out of scope for v1** (decision D-3). The
  alert carries the exact `approve <id>` command instead.

### 3.3 Delivery pipeline (new)

```
 PR → GitHub Actions: test (Node 20, 22, 24) · build · pack · npm audit
 merge to main → tag vX.Y.Z → publish allowance-kit (provenance) → rebuild & publish wallie
              → onewallie.com deploy + alias set (see memory: pinned aliases)
```

---

## 4. Workstreams and tickets

### R — Release hygiene (gate)

**R-01 Merge 0.4.0 and tag it.** `agent` · S · depends: —
> ✓ done — `main` contains `6acd145`; tags `v0.1.0`–`v0.4.0` (plus `v0.5.0`) exist.
Merge `feat/live-money-0.4.0` into `main` (no squash; history is the changelog), create
annotated tag `v0.4.0` at the merge, push both. Also tag historical releases from commit
messages: `v0.1.0`→`501049d`, `v0.1.1`→`8549c02`, `v0.2.0`→`46aac54`, `v0.3.0`→`e74f4da`.
*Done when:* `git tag` lists five tags, `main` contains `6acd145`, `npm test` on `main` is 65/65.

**R-02 CI workflow.** `agent` · M · depends: R-01
> ✓ done — `85ec2ed`. Tests run on Node 24 only (sources need 24); 20/22 build, pack and audit.
Add `.github/workflows/ci.yml`: on push and PR, matrix Node `20.11`, `22`, `24`; steps
`npm ci`, `npm run build`, `npm test` (on Node 20/22 the tests must run against `dist/` or
be skipped with a clear reason, since sources need Node 24 — decide and document in the
workflow), `npm pack --dry-run`, `npm audit --omit=dev --audit-level=high`. Add a status
badge to README.
*Done when:* a PR shows three green checks; a deliberately failing test turns it red.

**R-03 CHANGELOG.md and SECURITY.md.** `agent` · S · depends: R-01
> ✓ done — `85ec2ed`.
Create `CHANGELOG.md` (Keep a Changelog format) by lifting the "Changes in 0.4.0 / 0.3.0 /
0.2.0" sections out of README, with 0.1.0 and 0.1.1 reconstructed from commits. README keeps
one short "See CHANGELOG.md" line plus the current version's highlights. Create `SECURITY.md`:
report to hello@onewallie.com, 48 h acknowledgement, supported versions table, scope (money
paths), disclosure policy. Link it from CONTRIBUTING.md and SUPPORT.md.
*Done when:* both files exist, README's per-version sections are gone, links resolve.

**R-04 Release script.** `agent` · M · depends: R-01, R-03
> ✓ done — `243bfaa`. Local runs publish **without** `--provenance` (only set under `$GITHUB_ACTIONS`); a tag-triggered publish job is still future work.
Add `scripts/release.sh <version>`: asserts clean tree on `main`, runs tests and build,
bumps `package.json`, prepends a CHANGELOG entry stub, commits, tags `v<version>`, publishes
`allowance-kit` with `--provenance` (requires CI-based publish or `npm login`; document
both), then rebuilds and publishes the `wallie` alias (procedure in memory: unpack last
tarball, bump `version` and the `allowance-kit` range, publish with
`--userconfig ./.npmrc`). Script must refuse to run if `NPM_ACCESS_TOKEN` is unset and
print the exact export line from memory (`export NPM_ACCESS_TOKEN=$(grep '^NPM_ACCESS_TOKEN=' .env | cut -d= -f2-)`).
*Done when:* `scripts/release.sh --dry-run 0.5.0` prints every step it would take without
side effects.

**R-05 Bring the `wallie` alias into the repo.** `agent` · S · depends: R-04
> ✓ done — `63f7e5f`, `packages/wallie/`.
Add `packages/wallie/` containing the alias's `package.json`, `cli.js` (imports
`allowance-kit/dist/cli.js` in-process so `cli-name.ts` sees `wallie`), `index.js`
(re-exports), README. The release script publishes from here instead of unpacking a
tarball. Not part of the root `files`.
*Done when:* `npm pack` in `packages/wallie` produces a tarball equivalent to `wallie@0.3.0`
except version and dependency range.

**R-06 Publish 0.5.0.** `agent+human` · S · depends: everything marked gate in R, M, L, C-05
> ✓ done — `8c943b9`, 2026-09-07; both packages resolve to 0.5.0 (`docs/release-0.5.0-runbook.md`).
Human exports the npm token; agent runs the release script. Then verify from a clean
directory: `npx allowance-kit@0.5.0 --version`, `npx wallie@0.5.0 --version`, `npx wallie demo`.
*Done when:* both packages resolve to 0.5.0 on the registry and the demo passes from `npx`.

### M — Mainnet proof (gate)

**M-01 Fund the canary wallet.** `human` · S · depends: —
> ✓ done — 2026-09-07, $1.00 USDC on Base to `0xe48f…425B`. No ETH was needed (facilitator pays gas).
Send a small amount of USDC on Base (≥ $1.00) plus enough ETH on Base for nothing — EIP-3009
transfers are facilitator-paid, so no ETH is needed by the payer; confirm this in the CDP
docs before funding ETH at all — to the address printed by
`node --env-file=.env scripts/canary.ts --buyer --network base` (it prints the address and
stops when the balance is zero). Agents must not do this.
*Done when:* `allowance-kit status` on the canary directory shows a non-zero USDC balance on `base`.

**M-02 Run the mainnet canary and record it.** `agent+human` · S · depends: M-01
> ✓ done — `b276bb8`, `docs/canary-runs/2026-09-07-base.md`, tx `0x044245…2648e`.
Run the buyer canary on `base`. Save the output (tx hash, ledger rows) to
`docs/canary-runs/2026-MM-DD-base.md`. Fix whatever fails; every fix gets a test.
*Done when:* the canary exits 0 on mainnet, the ledger shows exactly one payment and one
block, the BaseScan link for the tx hash resolves.

**M-03 Update every "not yet on mainnet" statement.** `agent` · S · depends: M-02
> ✓ done for this repo — `73ebe7f`. **Open for the site**: `docs.html` still has no mainnet statement; folded into S-02/S-03.
README "Honest limitations" and "Live networks", USABILITY-REPORT "What is genuinely left",
`docs.html` on the site. Replace with the date and tx hash of the canary run.
*Done when:* `grep -rn "mainnet" README.md` returns no sentence claiming it has not run.

**M-04 Mainnet guardrails in the CLI.** `agent` · M · depends: L-03
> ✓ done — `eab18f5`, tests in `test/cli-live.test.ts`.
When `mode.json` says `network: "base"`: `topup` above $50 requires `--yes`; `policy` prints
a one-line REAL MONEY reminder on every change; `init --live --network base` requires typing
`base` again at a prompt (or `--yes` for scripts). Tests for each.
*Done when:* tests cover the three prompts and the `--yes` bypass.

### L — Live path usable without writing code (gate)

**L-01 Verify x402 wire compatibility against real sellers.** `agent` · M · depends: —
> ✓ done — `01d703c`, `docs/x402-compat.md`. Verdict: the live ecosystem is v2-only; keep v1 (D-5). Re-verify by 2026-12-07.
Research ticket, output is a document, not code. Determine from primary sources
(github.com/coinbase/x402, x402.org, the CDP facilitator docs) whether x402 **v2** is now
what live sellers and the CDP facilitator speak (header names, `x402Version`, network
identifiers such as CAIP-2 `eip155:8453`, payload shape), and whether v1 is still accepted.
Test against at least two public x402 endpoints found in the x402 ecosystem directory: record
the raw 402 response each returns. Write `docs/x402-compat.md` with findings and the exact
shape differences. Do not guess; quote the spec.
*Done when:* the document states, with sources, which version(s) to support and the diff.

**L-02 Support the wire version L-01 requires.** `agent` · L · depends: L-01
> ✓ done — `1a40254`, `6911e43`, `444cf2c`, `4985baa`; settled against Mart402 on Base Sepolia (`docs/x402-compat.md` §9). **Buyer only**: `paymentGate` still advertises v1 only, and the `CdpFacilitator` v2 body is unverified against real CDP — both are post-launch (add to X if a v2 seller is ever needed).
If v2 is required: extend `types.ts` with the v2 shapes alongside v1 (do not remove v1),
teach `payingFetch` to detect which the seller sent and answer in kind, teach `paymentGate`
to advertise both, map network ids both ways (`base` ↔ `eip155:8453`) in `live.ts`, and
extend `CdpFacilitator` to the v2 facilitator contract if it differs. Every shape gets a
wire test in `test/wire.test.ts`. If L-01 concludes v1 is sufficient, this ticket closes
with a note in `docs/x402-compat.md` and a date to re-check.
*Done when:* the buyer canary passes against one real third-party x402 seller (not our own
`paymentGate`), on Base Sepolia, and that run is recorded under `docs/canary-runs/`.

**L-03 `init --live` in the CLI.** `agent` · M · depends: —
> ✓ done — `eab18f5`.
`allowance-kit init --live [--network base-sepolia|base] [--rpc <url>]` reads
`AGENT_PRIVATE_KEY` from the environment (error with a plain explanation if unset or if
`viem` is missing, including the `npm i viem` line), derives the address exactly as
`createLiveAgent` does (reuse its code; do not duplicate), writes `mode.json`, prints the
address, the network, the REAL MONEY banner, the funding instruction ("send USDC to this
address"), and refuses if the directory is already live on a different network. Never
writes the key. `status` must then show the wallet balance line (already does when
`mode.json` is live).
*Done when:* tests prove the key never appears in any file under the state dir, and
`init --live` followed by `status` prints a real balance on Base Sepolia.

**L-04 `pay <url>` command.** `agent` · M · depends: L-03
> ✓ done — `eab18f5`. The site tutorial (S-03) does not use it yet.
`allowance-kit pay <url> [--method GET|POST] [--body <json>]` builds the runtime for the
directory's mode (practice: `createAgent`; live: `createLiveAgent` with the env key), runs
`payingFetch`, prints the result the way `audit` prints a row (paid: cost, tx hash, first
200 bytes of body; blocked: the `RULE_LABELS` sentence and what to do). Exit 0 on paid, 2 on
blocked, 1 on error. This is how a non-coder proves their first real payment and how the
tutorial will demonstrate it.
*Done when:* practice and live tests exist; the site tutorial (S-03) uses it.

**L-05 Key handling documentation and `doctor`.** `agent` · S · depends: L-03
> ✓ done — `eab18f5` (`doctor`), `2855b7c` (README section).
`allowance-kit doctor` checks: Node version, `viem` presence, env vars for the configured
channels and for live mode, RPC reachability, state-dir permissions, whether the directory
is live and on which network, and prints one line per check with a fix. README gets a
"Real money in five commands" section: `init --live`, fund, `topup`, `policy`, `pay`.
*Done when:* `doctor` exits non-zero on a missing key and zero on a working setup.

**L-06 Dashboard: authenticate reads, show all agents.** `agent` · M · depends: —
> ✓ done — `01b8cdb`, `test/dashboard-auth.test.ts`.
`GET /api/state` requires the same token as mutations (the served page already has it).
State returns every agent in the directory; the UI gets an agent switcher. Keep it
loopback-only.
*Done when:* an unauthenticated GET returns 401; the switcher lists agents from `listAgents`.

### C — Wallie Cloud v1 (gate)

Default stack (decision D-1): Vercel project `wallie-cloud`, Node functions, no framework,
Postgres on Neon through the Vercel Marketplace, Resend for email, Twilio for SMS. Every
function is a single file under `api/`, plain `fetch`, no ORM (use `@neondatabase/serverless`
or the `pg` driver, whichever the marketplace integration installs). Repo:
`~/dev/wallie-cloud` (D-10 — exists, pushed to `fskroes/wallie-cloud`, private). Same design
system as the site (`wallie.css` and `wallie.js` live at `~/dev/onewallie-site/assets/`; copy,
see memory about 1yc.dev tokens).

**Read §3.1.1 first.** The runtime half of this workstream (C-05) shipped in 0.5.0, so the
server's wire contract is fixed by a public npm package: `POST /v1/events` takes a
`CloudEvent`, `POST /v1/heartbeat` takes `{agent, network?, mode?, version?}`, `GET /v1/me`
returns `{workspace: {name}}`, bearer keys match `wk_(live|test)_[A-Za-z0-9]{8,}`, and the
client retries only on 408/425/429/5xx with an 8 s timeout. The fastest way to prove
compatibility is to run `test/cloud.test.ts` from this repo against the C-03 handlers.

Suggested order: C-01 → C-03 (with `/v1/me`) → C-04 → C-02 + C-06 → C-07 → C-08 → C-09; B-03
and S-01 slot in after C-02. C-03 and C-04 can be built and tested end to end with the
published runtime before any Stripe work exists, which is where the €20 value actually is.

**What the built code already gives the remaining tickets (read before starting C-02/C-06/C-07/C-08):**
- Handlers are framework-agnostic Node `(req, res)` default exports under `api/`, TypeScript run
  natively on Node ≥ 24 with **explicit `.ts` import extensions** (`allowImportingTsExtensions`,
  `noEmit`, `"type": "module"`). New endpoints follow the same shape so `test/helpers.ts` can
  mount them on a local `http.createServer` over PGlite.
- `lib/db.ts` exposes `Db {query, exec}` + `configureDb` (PGlite in tests, `pg` Pool from
  `DATABASE_URL` in prod). `lib/http.ts` has `readBody(req, cap)` (raw body, 8 KB cap → needed
  verbatim for Stripe signature checks), `sendJson`, `bearer`, `iso`.
- Tables already in `sql/001_init.sql` for the pending tickets: `stripe_events(id, type,
  received_at)` (C-02 idempotency), `magic_links` and `sessions` (C-07), `workspaces` with
  `stripe_customer_id`, `stripe_subscription_id`, `status` + verbatim `stripe_status`.
  `workspace_keys` has `key_hash`, `prefix` (12 chars), `revoked_at`; `lib/auth.ts` already
  looks keys up by SHA-256 hash with the 24 h rotation grace — C-02 only needs the **minting**
  side. `scripts/dev-server.ts` seeds `wk_test_devkey0123456789` for local smoke.
- `lib/senders.ts` sends email via Resend REST from `ALERT_EMAIL_FROM ?? alerts@onewallie.com`
  (reply-to `hello@onewallie.com`) and SMS via Twilio REST. C-06 templates plug in there; the
  alert body today is the plain `subject`/`body` text from the event.
- The site already calls Stripe with raw `fetch` and no SDK (`~/dev/onewallie-site/api/waitlist.js`,
  form-encoded, `STRIPE_SECRET_KEY`); reuse that pattern for C-02 and for the Customer Portal
  link in C-07.

**C-01 Schema and migrations.** `agent` · M · depends: —
> ✓ done — `wallie-cloud@15689aa`, `sql/001_init.sql` + `scripts/migrate.ts`. `rule`/`kind` are
> free text (no CHECK). `migrate.test.ts` proves a second run applies nothing.
`sql/001_init.sql` creating: `workspaces(id, name, stripe_customer_id, stripe_subscription_id,
status[active|past_due|canceled], created_at)`, `workspace_keys(id, workspace_id, key_hash,
prefix, created_at, revoked_at)`, `agents(id, workspace_id, name, state_dir_hint, network,
last_seen_at, first_seen_at)`, `events(id, workspace_id, agent_id, kind, rule, amount_micro,
host, tx_hash, request_id, payload jsonb, occurred_at, received_at)`, `alert_rules(id,
workspace_id, channel[email|sms|webhook], target, events[] , silent_after_seconds, enabled)`,
`deliveries(id, workspace_id, rule_id, event_id, status, attempts, last_error, sent_at)`,
`magic_links(token_hash, email, workspace_id, expires_at, used_at)`, `sessions(id,
workspace_id, email, expires_at)`, **`stripe_events(id text primary key, type, received_at)`**
(C-02 idempotency), **`rate_limits(key_id, window_start, count)`** (C-03, decision D-8).
Also **`agents.silent_since timestamptz null`** (the watchdog's "already flagged" state, C-04),
**`workspaces.stripe_status`** kept verbatim next to the mapped `status`, and
**`workspace_keys.revoked_at` may be set in the future** (rotation keeps the old key valid
for 24 h: lookups accept `revoked_at is null or revoked_at > now()`). `events.mode`
(`practice|live`) and `events.network` are columns, not only payload, so the feed can filter.
Indexes on `(workspace_id, occurred_at)`, `(workspace_id, last_seen_at)`, `(key_hash)`.
A `scripts/migrate.js` that applies files in order and records them in `schema_migrations`.
*Done when:* `node scripts/migrate.js` is idempotent against an empty Neon branch.

**C-02 Stripe webhook → provisioning.** `agent+human` · M · depends: C-01
> ○ not started (2026-09-08). Groundwork in place: `stripe_events` table, `readBody` raw-body
> helper, key hashing/lookup in `lib/auth.ts`. Write it as `api/v1/stripe/webhook.ts` (the repo
> is TS with `.ts` imports, not `.js`). **Vercel note:** if Vercel's Node helpers pre-parse the
> body the raw bytes for the HMAC check are gone — C-08 must set `NODEJS_HELPERS=0` (or verify
> the helper leaves the stream untouched) before this can be signature-tested on a preview.
`api/v1/stripe/webhook.js` verifies the signature with `STRIPE_WEBHOOK_SECRET` (implement
HMAC-SHA256 over the raw body per Stripe docs; no SDK). On `checkout.session.completed`:
upsert workspace by customer id, generate a workspace key (`wk_live_` + 32 random bytes
base32, store SHA-256), send the welcome email (C-06) with the key **once** and the sign-in
link. On `customer.subscription.updated` map Stripe status to workspace status. On
`customer.subscription.deleted` set `canceled`, revoke keys after a 7-day grace, email a
notice. Idempotent on Stripe event id (store processed ids). Human: create the webhook
endpoint in Stripe, paste the secret into Vercel env, keep the existing Payment Link (it
already collects email and fires these events).
*Done when:* Stripe CLI `stripe trigger checkout.session.completed` against a preview
deploy creates a workspace and sends the email to a test inbox.

**C-03 Ingest endpoints.** `agent` · M · depends: C-01
> ✓ done — `wallie-cloud@15689aa`. `api/v1/{events,heartbeat,me}.ts` + `lib/{auth,ratelimit,url,ingest,heartbeat}.ts`.
> 401/402/413/429 as specified; server-side URL stripping on every URL-shaped field; 24 h key
> rotation grace. **The C-03 proof holds**: `test/runtime-compat.test.ts` runs the C-03 handlers
> in-process (PGlite) and drives the published `Notifier`/`startCloudHeartbeat`/`cloudWhoami` at
> them — a paid/blocked/approval + heartbeat + whoami all land correctly. Rate limit is 600/min
> per key; `/v1/me` is exempt.
`POST /v1/events` and `POST /v1/heartbeat`, `Authorization: Bearer wk_…`. Look up key by
hash, reject revoked or non-active workspaces with 402 (fitting) and a JSON reason. Body of
`/v1/events` is exactly the `CloudEvent` in **§3.1.1** (field names `agent`, not `agentName`);
validate `kind`, require `agent`, `subject`, `body`, `at`; server strips query strings from
any URL-shaped string field again, caps payload at 8 KB (413, final), stores one row, upserts
the agent (`name`, `network`, `mode`), and enqueues deliveries for matching rules (C-04).
`/v1/heartbeat` body is `{agent, network?, mode?, version?}` (§3.1.1) and updates
`last_seen_at` (server clock) and clears `silent_since` via the C-04 "back" transition.
`GET /v1/me` returns `{workspace: {name, status}, agents: [...], key: {prefix, createdAt}}` —
the runtime reads `workspace.name`. Rate limit 600 req/min per key (D-8) with 429 +
`Retry-After`; the runtime retries a 429 three times without reading `Retry-After`, so a
limit that trips often costs three requests, not one. Return `{ok:true}` within well under
the runtime's 8 s timeout; never do fan-out inline.
*Done when:* integration test posts 100 events and 10 heartbeats with a valid key and sees
them in the feed; invalid key gets 401; revoked gets 402; and **the real runtime's own tests
pass against it**: point `test/cloud.test.ts`'s `CloudConfig.url` at a preview deploy (or run
the C-03 handlers in-process) and all seven assertions hold.

**C-04 Fan-out and watchdog.** `agent` · L · depends: C-03
> ◐ code-complete, live sends unverified — `wallie-cloud@15689aa`. `lib/senders.ts` (webhook/Resend/Twilio,
> ported from `notify.ts` with the same retry classification), `lib/fanout.ts` (`drainDeliveries`,
> 3 attempts, none on 401), `lib/watchdog.ts` + `api/cron/watchdog.ts` (one per-minute cron does
> both the silent-scan and the delivery drain; `vercel.json` schedules it). `silent`/`back` events
> are created and enqueued; SMS is bounded to `blocked`/`approval`/`silent`. `fanout.test.ts` and
> `watchdog.test.ts` cover retry classification, SMS suppression, and the silent→back transitions
> with a fake fetch. **Still needs the human:** verify a real email arrives via Resend and one SMS
> via Twilio (their "done when" clause) once the domain and number exist and the service is deployed.
`lib/fanout.js`: for each pending delivery, send by channel — email via Resend REST (Wallie's
`RESEND_API_KEY`, from `alerts@onewallie.com`, human verifies the domain), SMS via Twilio REST
(Wallie's account and number), webhook via POST with the same Slack/Discord-shaped `text` +
flat fields the local `Notifier` already produces (reuse the formatting; port
`formatMessage` from `notify.ts` verbatim). Retry policy identical to the runtime: 3 attempts
with backoff, none on 401, record failures. Triggered by `/v1/events` through a Vercel
background function or by a cron every minute draining `deliveries.status = pending`.
`api/cron/watchdog.js` (Vercel Cron, `* * * * *`): for every agent whose `last_seen_at` is
older than the workspace rule's `silent_after_seconds` (default 300) and not already
flagged, create a `silent` event and deliveries; clear the flag when a heartbeat returns and
send a `back` event. SMS is limited to `blocked`, `approval`, and `silent` by default to keep
costs bounded; `budget 100%` joins that list once C-10 makes the runtime send `threshold`
events (0.5.0 does not). Event kinds the cloud itself creates: `silent`, `back`.
*Done when:* a test workspace with an email rule receives: one email per synthetic block,
one "agent silent" email 5 minutes after heartbeats stop, one "agent back" email after they
resume. Twilio path tested with a real number once by human.

**C-05 The `cloud` channel in the runtime.** `agent` · M · depends: C-03 (for a live target),
> ✓ done — `49d5610`, shipped in 0.5.0, 7 tests in `test/cloud.test.ts` against a local `http.createServer`. **Deviations from the text below, now authoritative (§3.1.1):** the body is a `CloudEvent`, not `NotifyMessage` + extras; kinds are `payment|blocked|approval` and `threshold` is **not** sent; the heartbeat omits `version`; `notify test` checks `GET /v1/me` rather than posting an event; a `notify cloud off` subcommand exists.
can be built against a local mock server first
In `allowance-kit`: `notify cloud <workspace-key>` stores **only** `{cloud: {enabled: true,
url: "https://api.onewallie.com", keyEnv: "WALLIE_CLOUD_KEY"}}` in `notifications.json` and
prints the export line for the key; the key itself is read from `process.env[keyEnv]` at send
time, like the email providers. `Notifier` gains the channel: POST every `NotifyEvent` (all
kinds, including `payment` — the cloud feed needs paid rows too, unlike local alert
thresholds) to `/v1/events` with the Bearer key, query strings stripped from URLs, same
retry/failure recording as other channels, never awaited inside the ledger lock. `createAgent`
and `createLiveAgent` start the 60 s heartbeat to `/v1/heartbeat` when the cloud channel is
enabled and stop it on process exit (unref the timer). `notify test` includes the cloud.
`notify` and `status` show "cloud: connected as <workspace name>" by calling `GET /v1/me`.
Exported: `CLOUD_ENV`, `CloudConfig` type.
*Done when:* tests use a local `http.createServer` as the cloud; a paid, a blocked, a queued
event and two heartbeats arrive with the right shape; the key never appears in
`notifications.json`; the demo run with `WALLIE_CLOUD_KEY` unset behaves exactly as today.

**C-06 Transactional email templates.** `agent` · S · depends: C-02
> ○ not started (2026-09-08). No `templates/` dir exists; `lib/senders.ts` currently sends the
> event's `subject`/`body` as plain text. Templates should feed `sendEmail` there so the fan-out
> tests keep passing with a fake fetch.
Plain-text-first, with a minimal HTML twin in the site's typography: welcome (key, the three
commands `npm i -g allowance-kit`, `export WALLIE_CLOUD_KEY=…`, `allowance-kit notify cloud …`,
sign-in link), magic link, alert (one template, the `text` body from fan-out), silent /
back, subscription canceled. All from `alerts@onewallie.com`, reply-to hello@.
*Done when:* each template renders with fixture data in a `templates.test.js`.

**C-07 Magic-link auth and the account app.** `agent` · L · depends: C-01, C-06
> ○ not started (2026-09-08). `magic_links` and `sessions` tables exist (C-01); no `api/v1/auth/*`
> handlers, no static pages, no `SESSION_SECRET` use yet. `GET /v1/me` already returns
> `{workspace, agents, key}` and can back the Overview page. Design system source:
> `~/dev/onewallie-site/assets/wallie.css` + `wallie.js`.
`app.onewallie.com` static pages + `api/v1/auth/*`: enter email → magic link (15 min,
single use) → session cookie (`HttpOnly; Secure; SameSite=Lax`, 30 days). Pages: **Overview**
(workspace name, status, agents with last-seen and mode/network badge, REAL MONEY badge when
any agent is live, "practice" badge otherwise), **Key** (prefix shown, "rotate" creates a new key and revokes the old
after 24 h, copy-to-clipboard of the three setup commands), **Events** (read-only feed, newest
first, filter by agent and kind, 50 per page), **Alerts** (rules CRUD: channel, target,
which events, silence threshold; "send test"), **Billing** (link to Stripe Customer Portal,
human enables the portal in Stripe). No framework; `fetch` against `/v1/*`; `textContent`
only, never `innerHTML` (the local dashboard rule).
*Done when:* a Playwright-free manual script in `docs/qa-cloud.md` can be followed end to
end on a preview deploy, and every mutation endpoint rejects a request without a session.

**C-08 Deployment, domains, environment.** `agent+human` · M · depends: C-01..C-07
> ○ not started (2026-09-08); no Vercel project exists for the cloud. `vercel.json` is written
> (rewrite `/v1/(.*)` → `/api/v1/$1`, cron `/api/cron/watchdog` at `* * * * *`, `maxDuration`
> 10 s for the API, 60 s for the cron). **Verified Vercel platform facts (docs, 2026-09-08)** that
> change this ticket:
> 1. **Plan.** Per-minute crons need **Pro**; Hobby allows one run per day with ±59 min precision
>    and the deployment *fails* with a `* * * * *` schedule. Hobby is also **non-commercial** —
>    "requesting or processing payment" is explicitly commercial use. The team
>    `fernando-silva-kroes-projects` is on Hobby (checked via the Vercel API 2026-09-08). Upgrade
>    to Pro is a human step (§6 item 3) and a recurring cost to record in BUSINESS.md.
> 2. **Crons run only on production deployments.** Preview deploys never tick; smoke the
>    watchdog with `vercel crons run /api/cron/watchdog` or a manual `curl`.
> 3. **Cron auth.** `api/cron/watchdog.ts` currently has **no auth check** — anyone who guesses
>    the path can drain deliveries early. Add `CRON_SECRET` to the env list and require
>    `Authorization: Bearer ${CRON_SECRET}` (Vercel sends it automatically when the var is set).
> 4. **Body parsing.** The handlers read the raw stream via `readBody`. Vercel's Node helpers add
>    a lazy `request.body` getter; whether that pre-consumes the stream is **unverified** — set
>    `NODEJS_HELPERS=0` in the project env (documented Vercel switch) or confirm on a preview
>    deploy that `/v1/events` still receives bytes. Required for C-02's signature check either way.
> 5. **TS bundling.** Vercel supports TypeScript in `api/`, and `engines.node >=24` in
>    `package.json` selects the Node version; **unverified** whether its bundler resolves the
>    explicit `.ts` extension imports from `lib/` — check on the first preview deploy before
>    anything else.
> 6. The site's domains are pinned aliases (memory `onewallie-deploy-pinned-alias`); expect the
>    same for `api.`/`app.` and document the alias step in the README.
`vercel.json` with the cron, function timeouts, and the two hostnames. Env vars documented
in `README.md` of the cloud repo: `DATABASE_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`RESEND_API_KEY`, `TWILIO_*`, `ALERT_EMAIL_FROM` (optional), `SESSION_SECRET`, `APP_ORIGIN`,
`API_ORIGIN`, `CRON_SECRET`, `NODEJS_HELPERS=0`. Human: upgrade the Vercel team to Pro, add DNS
for `api.` and `app.`, set env in Vercel, verify Resend domain, buy/verify the Twilio number.
Note in the README that the site's domains are pinned aliases (memory) and check whether the
cloud project's are too after first deploy.
*Done when:* `curl https://api.onewallie.com/v1/me` without a key returns a JSON 401, and
`app.onewallie.com` loads the sign-in page over HTTPS.

**C-09 Cloud test suite and CI.** `agent` · M · depends: C-03, C-04
> ◐ partial — `wallie-cloud@15689aa`. The `node --test` suite exists and is 21/21 (auth, ingest,
> ratelimit, watchdog, fanout, migrate, runtime-compat) but runs against **in-memory PGlite**, not
> a Neon branch, so it needs no secret and runs anywhere. `.github/workflows/ci.yml` mirrors R-02
> (Node 24, test + typecheck + audit). Repo pushed 2026-09-08; **CI has run and is green** on
> `main` (run `34201788502`). **Open:** the Neon-branch job (stubbed as a comment in the workflow)
> once a `NEON_API_KEY` secret exists, and the "broken webhook signature fails CI" clause, which
> lands with C-02.
`node --test` suite against a Neon branch created in CI (`neonctl branches create`), covering
webhook idempotency, key hashing/rotation, ingest validation, watchdog transitions, delivery
retry classification. GitHub Actions on the cloud repo mirrors R-02.
*Done when:* CI is green on the cloud repo and a broken webhook signature check fails it.

**C-10 Runtime follow-ups the cloud needs (0.5.1).** `agent` · S · depends: — (not gate)
In `allowance-kit`: (1) add `"threshold"` to `CloudEventKind` and emit it from
`Notifier.spent()` for every crossing (the cloud wants 50/80/100 % rows and C-04's
"budget 100 %" SMS needs them); (2) pass `version` (from `package.json`, the same value
`--version` prints) in the heartbeat from `createAgent` and `createLiveAgent`; (3) honour
`Retry-After` on a 429 from the cloud, bounded to 60 s; (4) make `doctor` report the cloud
row (`WALLIE_CLOUD_KEY` set or not, and `/v1/me` reachable) when the channel is enabled.
Extend `test/cloud.test.ts` for each.
Ship as `0.5.1`; the cloud must keep accepting 0.5.0 clients that send neither.
*Done when:* the local cloud stub in the tests receives a `threshold` event and a heartbeat with
`version: "0.5.1"`, and the existing seven tests still pass.

### B — Billing and legal (gate)

**B-01 Stripe product hygiene.** `human` · S · depends: —
In Stripe: confirm the Payment Link's product is "Wallie Cloud", €20/month, recurring; enable
Stripe Tax (EU VAT on a digital service sold from NL) and the Customer Portal (cancel,
update card, invoices); set the statement descriptor to `WALLIE`; set the success URL to
`https://app.onewallie.com/welcome` (S-01) and cancel URL to the pricing section. Turn on
email receipts. Record the price id in the cloud repo README.
*Done when:* a test-mode purchase shows VAT on the receipt and lands on the welcome page.

**B-02 Terms and privacy for Cloud.** `agent+human` · S · depends: C-03
Update `terms.html` and `privacy.html`: what event data the cloud stores (host, amount,
rule, tx hash, agent name, no query strings, no keys), retention (90 days of events,
deletable on request, deleted 30 days after cancellation), sub-processors (Vercel, Neon,
Stripe, Resend, Twilio), that Wallie is non-custodial and never holds funds or keys, the
14-day refund policy for the first month (replacing today's "no partial-period refunds"
line), governing law NL; remove the "Volume fee … 1 %" bullet from `terms.html:52` (D-2).
Human reviews before deploy.
*Done when:* both pages list the sub-processors and retention numbers above, and the
welcome email links to them.

**B-03 Refund and cancellation handling.** `agent` · S · depends: C-02
`customer.subscription.deleted` and `charge.refunded` both mark the workspace and stop
ingest after the grace period; the account app shows the state and the date access ends.
*Done when:* Stripe CLI triggers for both events produce the expected workspace status.

### S — Site and docs (gate)

**S-01 Post-purchase page.** `agent` · S · depends: B-01, C-02
`app.onewallie.com/welcome`: "Check your inbox for your key", the three setup commands,
link to the tutorial's cloud step, hello@ for anything wrong. No key on the page (it is in
the email, once).
*Done when:* Stripe's success redirect lands here and the page renders without a session.

**S-02 Pricing and claims.** `agent` · S · depends: D-2
In `~/dev/onewallie-site`. Every "€20 /mo workspace + 1% volume" becomes "€20/mo per
workspace" (footnote: usage pricing may come later, with notice): `index.html:286` price
line, `:322` footnote, and the `terms.html:52` bullet (with B-02). The pricing card bullets
(`index.html:288–295`) are replaced by what C-03/C-04/C-07 deliver: every agent's decisions
in one feed, alerts by email / SMS / webhook, an "agent silent" watchdog when the machine goes
quiet, any number of agents per workspace, non-custodial. Drop "multi-agent allowances & team
roles", "fiat top-up", "spend analytics", "managed facilitator routing", "free under $25/mo".
The "How Wallie Cloud works" four-node flow (`index.html:314–323`) becomes: your agents
(`notify cloud`) → the feed (`/v1/events` + heartbeat) → alerts + watchdog → your keys and
funds never leave your machine. "Onboarded personally within 24h" (`index.html:287`, `:373`)
becomes "provisioned automatically, key by email within minutes" (or stays, per D-4).
Remove "subscribers vote on the roadmap" (`docs.html:178`) unless Fernando keeps that
promise (D-4). Roadmap note in `docs.html` updated: CDP adapter ✓, npm ✓, mainnet ✓ (link the
canary record), Cloud ✓ (alerts + watchdog), next: approve-from-phone, compliance exports.
Also the `docs.html:339` "x402 v1 today" sentence → "x402 v1 and v2".
*Done when:* `grep -rn "1%" index.html docs.html terms.html` is empty, `grep -c vote docs.html`
is 0 (or D-4 says keep), and every Cloud claim on the pricing card maps to a shipped ticket.

**S-03 Tutorial: real money and cloud chapters.** `agent` · M · depends: L-03, L-04, C-05, M-02
`docs.html` gains two steps after the practice chapters: "Go live on Base Sepolia" (`init
--live`, faucet link, `topup`, `policy`, `pay`) and "Get told when it stops" (`notify cloud`).
Each block copy-pastable. Mainnet gets one paragraph pointing at the canary record.
*Done when:* a fresh reader following it verbatim on a clean machine reaches a real testnet
payment and a cloud alert; record the run as `docs/qa-tutorial.md`.

**S-04 Deploy the site correctly.** `agent+human` · S · depends: S-01..S-03
Deploy, then `npx vercel alias set <deployment-url> onewallie.com` and `www.onewallie.com`
(memory: pinned aliases). Verify with `npx vercel alias ls` and a `curl` of the live pricing
text.
*Done when:* `curl -s https://onewallie.com | grep -c "1%"` prints 0 and
`curl -s https://onewallie.com/terms.html | grep -c "1%"` prints 0.

### O — Operations (first week after launch)

**O-01 Uptime and error alerting for the cloud.** `agent+human` · S
Healthchecks.io (or Cronitor) ping from the watchdog cron itself, so the watchdog watching
customers' agents is itself watched. Vercel log drain or built-in alerts for 5xx spikes to
hello@ or a Slack webhook.

**O-02 Backups and restore drill.** `agent+human` · S
Neon point-in-time restore is on by default; document the restore command and run it once
against a branch. Record in the cloud README.

**O-03 Support runbook.** `agent` · S
`docs/support-runbook.md` in the cloud repo: how to look up a workspace by email, resend the
welcome email, rotate a key for a customer, refund via Stripe, delete a workspace's data on
request (B-02), what "agent silent" false positives look like (laptop sleep) and the stock
reply. GitHub Discussions is already enabled on `fskroes/AllowanceKit` (verified 2026-09-07).

**O-04 Metrics.** `agent` · S
Extend `api/mrr.js` on the site (or move it to the cloud) to also report active workspaces,
agents seen in 24 h, events in 24 h, delivery failure rate. Private endpoint, session-gated.

### X — Post-launch product (not gate; ordered by value)

**X-01 Approve or deny from the alert.** Signed one-time links in the email/SMS that record
a decision in the cloud; the local runtime polls `/v1/decisions` (or the CLI runs
`approvals --sync`) and applies it through `decideApproval`. Closes the loop BUSINESS.md
calls "escalation".

**X-02 Compliance export.** `allowance-kit audit --export` producing a signed digest
(SHA-256 chain over `ledger.jsonl` rows + policy version at each row) and the cloud's
`/v1/export` producing the same for uploaded events. The paid "compliance pack".

**X-03 Volume pricing.** Metered billing on `payment` events reported to the cloud, via
Stripe usage records. Requires the cloud channel to be on, which is why it is deferred.

**X-04 Hosted dashboard parity.** Live balance from the chain per agent (public RPC read,
address only), policy view (read-only), per-agent budget meters.

**X-05 Per-agent locks.** Replace the single state-dir lock with per-agent locks so a busy
agent does not serialise the others.

---

## 5. Decisions taken in this plan (change them here, not in tickets)

- **D-1 Cloud stack:** Vercel Functions + Neon Postgres + Resend + Twilio, no framework, no
  ORM. Reason: the site is already Vercel + Stripe, Fernando has the accounts, and the
  runtime's zero-dependency habit keeps the surface small for agents to reason about.
- **D-2 Pricing at launch:** flat €20/month per workspace. The "1% of settled volume" is
  removed from the site until X-03 exists, because it cannot be metered honestly today.
- **D-3 Approvals from the cloud are out of v1.** Alerts carry the `approve <id>` command.
  Reason: it requires a decision channel back into local state and a security review; v1
  ships the part that is purely outbound.
- **D-4 "Subscribers vote on the roadmap"** is removed unless Fernando says otherwise.
- **D-5 x402 v1 stays supported** whatever L-01 finds; v2 is added alongside, never instead.
- **D-6 The cloud never stores query strings, private keys, signed payloads, or full
  request bodies.** Enforced on both ends.
- **D-7 Versioning:** 0.5.0 for deliverable A (shipped 2026-09-07). 1.0.0 is reserved for
  the release after the first paying customer has run for 30 days with no money-path bug.
  Runtime changes the cloud needs (C-10) go out as 0.5.x patches.
- **D-8 Rate limiting store:** a `rate_limits` row per key per minute in Postgres (D-1 has no
  Redis). Best-effort is acceptable: a serverless in-memory counter would reset per instance
  and under-count, which is worse than one extra round-trip.
- **D-9 The runtime's wire contract wins.** `allowance-kit@0.5.0` is public; the server
  implements §3.1.1 as-is. Anything the server wants differently becomes a runtime ticket
  (C-10 pattern) and must stay backward-compatible with 0.5.0 clients.
- **D-10 Cloud repo:** `~/dev/wallie-cloud`, its own git repo (created 2026-09-07, initial commit
  `15689aa`, branch `main`), pushed 2026-09-08 to the **private** GitHub repo
  `fskroes/wallie-cloud`; CI green there. It stays private (it is the paid half). Not a package
  in this repo, so the zero-dependency rule here is untouched: the cloud uses `pg` (prod) and
  `@electric-sql/pglite` (tests).

## 6. Human-only checklist (hand to Fernando in this order)

1. ~~M-01: fund the canary wallet on Base with USDC.~~ Done 2026-09-07.
2. B-01: Stripe Tax, Customer Portal, success URL, statement descriptor.
3. C-08 first: **upgrade the Vercel team `fernando-silva-kroes-projects` to Pro** (Hobby refuses
   the per-minute watchdog cron and forbids commercial use), create the `wallie-cloud` Vercel
   project from the GitHub repo, set `CRON_SECRET` and `NODEJS_HELPERS=0` with the other env vars.
   Then C-02 / C-08: create the Stripe webhook, paste secrets and all env vars into Vercel, DNS
   for `api.` and `app.onewallie.com`, verify `onewallie.com` in Resend, buy a Twilio number.
4. ~~R-06: export `NPM_ACCESS_TOKEN` and run the release script.~~ Done 2026-09-07.
5. S-04: run the alias commands after the site deploy.
6. B-02: read the updated terms and privacy pages before they go live.
7. ~~O-03: enable GitHub Discussions if it is off.~~ Already on.

## 7. Launch gate

All of the following are true, each verifiable by a command or a URL:

- [x] `npx wallie@latest --version` and `npx allowance-kit@latest --version` print `0.5.0`.
      (Published + verified 2026-09-07; `latest` dist-tag is `0.5.0`, wallie pins `allowance-kit@^0.5.0`.)
- [x] `docs/canary-runs/` contains a passing mainnet run with a BaseScan link.
      (M-02: `docs/canary-runs/2026-09-07-base.md`, tx `0x044245…2648e`.)
- [x] `docs/x402-compat.md` exists and the testnet canary passed against a third-party seller.
      (Mart402, Base Sepolia, 2026-09-07 — `docs/canary-runs/2026-09-07-base-sepolia-mart402.md`.)
- [x] CI is green on `main` for both repos. (allowance-kit: green on `a827b40`. Cloud repo: green on `15689aa`, run `34201788502`, 2026-09-08. The Neon-branch job and the webhook-signature check are still open under C-09 but are not part of this line.)
- [ ] A test-mode Stripe purchase produces a welcome email with a working key within 2 minutes. (C-01, C-02, C-06, C-08, B-01)
- [ ] `allowance-kit notify cloud <key>` followed by `notify test` shows `delivered cloud`. (Handler built + proven in-process via runtime-compat; still needs a live `api.onewallie.com` — C-08.)
- [ ] Stopping the agent produces an "agent silent" email within 6 minutes. (Watchdog + fan-out built and tested with fakes; needs deploy + real Resend send — C-04 human step, C-08.)
- [ ] `curl -s https://onewallie.com | grep -c "1%"` prints 0. (S-02, S-04)
- [ ] Terms and privacy list the sub-processors and retention. (B-02)
- [ ] `app.onewallie.com/welcome` is where a Stripe purchase lands. (S-01, B-01)
- [x] `SECURITY.md`, `CHANGELOG.md`, five git tags, and a README badge exist.
      (Six tags now: v0.1.0–v0.5.0; CI badge at the top of README.)
