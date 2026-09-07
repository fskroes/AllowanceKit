# AllowanceKit / Wallie — release-readiness plan

Written 2026-09-07 against `feat/live-money-0.4.0` (commit `6acd145`). This document is
the work order for making the product **released** (a trustworthy, versioned, CI-tested
package that real money can go through) and **buyable** (the €20/mo Wallie Cloud that the
website already sells actually exists, provisions itself, and delivers something a laptop
cannot).

It is written for implementing agents. Every ticket has an owner, a dependency list, the
files it touches, and a "done when" that can be checked mechanically. Terms in **bold
italics** on first use are defined in [GLOSSARY.md](GLOSSARY.md). Read the glossary first.

Nothing in this document has been implemented. Do not treat any "done when" as already true.

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

## 1. Verified current state (2026-09-07)

| Area | State |
|---|---|
| Package | `allowance-kit@0.4.0` on branch `feat/live-money-0.4.0`, pushed, **not merged to `main`**, **not published**. npm `latest` is `0.3.0`. |
| Alias | `wallie@0.3.0` on npm depends on `allowance-kit@^0.3.0`. Its source is not in this repo (rebuilt from the last tarball at publish time). |
| Tags | The repo has **no git tags**. Releases are only identifiable by commit message. |
| CI | **None.** No `.github/workflows/`. Tests run only when typed by hand. |
| Tests | 65/65 pass locally on Node 24.18. |
| Release docs | No `CHANGELOG.md`, no `SECURITY.md`. README carries per-version change sections. |
| Practice path | Complete: CLI, SDK, dashboard, demo, alerts, approvals with expiring grants, multi-agent state dirs. |
| Live path (SDK) | `createLiveAgent` signs real x402 **v1** EVM payloads (EIP-3009) on `base-sepolia` and `base`. On-chain USDC balance check over public JSON-RPC, 15 s cache, fail-open. Network is a hard constraint. |
| Live path (CLI) | **Cannot be started from the CLI.** Only code that calls `createLiveAgent` with a private key marks a directory live. `init`, `topup`, `status`, `dashboard` merely *read* `mode.json`. A non-coder cannot use real money. |
| Mainnet | **Exercised 2026-09-07 (M-02).** `scripts/canary.ts --buyer --network base` settled a real $0.01 USDC payment on Base; tx `0x044245c0eb2d88350bf80d936e53185056f78f3afcf28eac942332894302648e`, recorded in `docs/canary-runs/2026-09-07-base.md`. Testnet canary passed 2026-08-29. |
| x402 version | v1 only (`X-PAYMENT` / `X-PAYMENT-RESPONSE`, `x402Version: 1`, bare network names). No v2 support. Whether live sellers still answer v1 must be verified (ticket L-01). |
| Facilitator | Coinbase CDP only (`facilitator-cdp.ts`, ES256 JWT). Sellers' side. Buyers depend on whatever facilitator the seller uses. |
| Dashboard | Loopback only, mutations token-gated, `GET /api/state` open to anything on loopback, one agent at a time. |
| Website | onewallie.com (Vercel, static + 2 functions). Sells **"Wallie Cloud — €20/mo + 1% volume"** through a Stripe Payment Link in five places. **Wallie Cloud does not exist.** A buyer today receives a Stripe receipt and nothing else; the only promise is "personal onboarding within 24 hours" by hand. `api/waitlist.js` creates Stripe customers; `api/mrr.js` reads MRR. |
| Site docs | `docs.html` roadmap note still says "CDP facilitator adapter → npm package → Wallie Cloud" although the first two shipped. |
| Business model | BUSINESS.md: Cloud = hosted alerting that fires when your machine is off + SMS + escalation; compliance pack (enterprise, by email); facilitator revenue share (future). Price settled at €20. |
| Legal | `privacy.html` and `terms.html` exist on the site. Not reviewed here for Cloud-specific data handling. |
| Support | `SUPPORT.md` points at GitHub Issues/Discussions and hello@onewallie.com. Whether Discussions is enabled on the repo is unverified. |

**The two facts that decide the plan:**

1. The open-source runtime is close to done. What is missing is proof (mainnet), a front
   door for real money that does not require writing code, and release hygiene.
2. The thing being sold does not exist. Either build a minimal Wallie Cloud that delivers
   exactly what BUSINESS.md says is paid (alerts that fire when the laptop is off), or stop
   selling it. This plan builds it, scoped to the minimum that is honestly worth €20.

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

### 3.1 Runtime (exists; changes marked NEW)

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
                    │  402 challenge / X-PAYMENT (x402 v1;   │ live: EIP-3009 via viem
                    │  NEW: v2 negotiation, ticket L-02)      │ practice: MockChain
                    ▼                                        ▼
              seller API  ──▶  facilitator (CDP)  ──▶  USDC on Base / Base Sepolia
                                                            ▲
                    live balance check (JSON-RPC, 15 s cache)┘
                    │
                    ▼  after every decision (never inside the ledger lock)
              Notifier ──▶ webhook · email · sms · push · heartbeat
                       ──▶ NEW: cloud  (ticket C-05)  ──▶ Wallie Cloud
```

New runtime pieces:

- **CLI live mode** (`init --live --network <net>`): derives the payer address from
  `AGENT_PRIVATE_KEY` in the environment, writes `mode.json`, never writes the key. `status`
  and `dashboard` already read `mode.json`. A new `pay <url>` command lets a non-coder make
  one real payment from the shell to prove the path (ticket L-04).
- **`cloud` notify channel**: every `NotifyEvent` plus a heartbeat every 60 s is POSTed to
  the cloud with a *workspace key*. It is one more entry in `NotifyConfig`; config holds
  the key **by environment variable name**, not value (`WALLIE_CLOUD_KEY`), keeping the
  no-secrets-on-disk rule.
- **Heartbeat moves into the runtime**: today `startHeartbeat` runs only while the local
  dashboard runs. It must run whenever a runtime exists (`createAgent` / `createLiveAgent`),
  so that a headless agent on a server is covered.

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
        deliveries · sessions · stripe_customers

   app.onewallie.com  (static HTML + fetch, same wallie.css design system)
        sign in by magic link → key reveal / rotate → agents & last seen
        → event feed (read-only) → alert rules → billing portal link
```

Trust boundaries:

- The cloud never receives a private key, a signed payload, or the ability to authorize a
  payment. It receives *decisions already made* (paid / blocked / queued) and liveness.
- Event payloads strip query strings from URLs before leaving the machine (`?city=lisbon`
  can be personal data). Ticket C-05 enforces this client-side; C-03 enforces it server-side.
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
Merge `feat/live-money-0.4.0` into `main` (no squash; history is the changelog), create
annotated tag `v0.4.0` at the merge, push both. Also tag historical releases from commit
messages: `v0.1.0`→`501049d`, `v0.1.1`→`8549c02`, `v0.2.0`→`46aac54`, `v0.3.0`→`e74f4da`.
*Done when:* `git tag` lists five tags, `main` contains `6acd145`, `npm test` on `main` is 65/65.

**R-02 CI workflow.** `agent` · M · depends: R-01
Add `.github/workflows/ci.yml`: on push and PR, matrix Node `20.11`, `22`, `24`; steps
`npm ci`, `npm run build`, `npm test` (on Node 20/22 the tests must run against `dist/` or
be skipped with a clear reason, since sources need Node 24 — decide and document in the
workflow), `npm pack --dry-run`, `npm audit --omit=dev --audit-level=high`. Add a status
badge to README.
*Done when:* a PR shows three green checks; a deliberately failing test turns it red.

**R-03 CHANGELOG.md and SECURITY.md.** `agent` · S · depends: R-01
Create `CHANGELOG.md` (Keep a Changelog format) by lifting the "Changes in 0.4.0 / 0.3.0 /
0.2.0" sections out of README, with 0.1.0 and 0.1.1 reconstructed from commits. README keeps
one short "See CHANGELOG.md" line plus the current version's highlights. Create `SECURITY.md`:
report to hello@onewallie.com, 48 h acknowledgement, supported versions table, scope (money
paths), disclosure policy. Link it from CONTRIBUTING.md and SUPPORT.md.
*Done when:* both files exist, README's per-version sections are gone, links resolve.

**R-04 Release script.** `agent` · M · depends: R-01, R-03
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
Add `packages/wallie/` containing the alias's `package.json`, `cli.js` (imports
`allowance-kit/dist/cli.js` in-process so `cli-name.ts` sees `wallie`), `index.js`
(re-exports), README. The release script publishes from here instead of unpacking a
tarball. Not part of the root `files`.
*Done when:* `npm pack` in `packages/wallie` produces a tarball equivalent to `wallie@0.3.0`
except version and dependency range.

**R-06 Publish 0.5.0.** `agent+human` · S · depends: everything marked gate in R, M, L, C-05
Human exports the npm token; agent runs the release script. Then verify from a clean
directory: `npx allowance-kit@0.5.0 --version`, `npx wallie@0.5.0 --version`, `npx wallie demo`.
*Done when:* both packages resolve to 0.5.0 on the registry and the demo passes from `npx`.

### M — Mainnet proof (gate)

**M-01 Fund the canary wallet.** `human` · S · depends: —
Send a small amount of USDC on Base (≥ $1.00) plus enough ETH on Base for nothing — EIP-3009
transfers are facilitator-paid, so no ETH is needed by the payer; confirm this in the CDP
docs before funding ETH at all — to the address printed by
`node --env-file=.env scripts/canary.ts --buyer --network base` (it prints the address and
stops when the balance is zero). Agents must not do this.
*Done when:* `allowance-kit status` on the canary directory shows a non-zero USDC balance on `base`.

**M-02 Run the mainnet canary and record it.** `agent+human` · S · depends: M-01
Run the buyer canary on `base`. Save the output (tx hash, ledger rows) to
`docs/canary-runs/2026-MM-DD-base.md`. Fix whatever fails; every fix gets a test.
*Done when:* the canary exits 0 on mainnet, the ledger shows exactly one payment and one
block, the BaseScan link for the tx hash resolves.

**M-03 Update every "not yet on mainnet" statement.** `agent` · S · depends: M-02
README "Honest limitations" and "Live networks", USABILITY-REPORT "What is genuinely left",
`docs.html` on the site. Replace with the date and tx hash of the canary run.
*Done when:* `grep -rn "mainnet" README.md` returns no sentence claiming it has not run.

**M-04 Mainnet guardrails in the CLI.** `agent` · M · depends: L-03
When `mode.json` says `network: "base"`: `topup` above $50 requires `--yes`; `policy` prints
a one-line REAL MONEY reminder on every change; `init --live --network base` requires typing
`base` again at a prompt (or `--yes` for scripts). Tests for each.
*Done when:* tests cover the three prompts and the `--yes` bypass.

### L — Live path usable without writing code (gate)

**L-01 Verify x402 wire compatibility against real sellers.** `agent` · M · depends: —
Research ticket, output is a document, not code. Determine from primary sources
(github.com/coinbase/x402, x402.org, the CDP facilitator docs) whether x402 **v2** is now
what live sellers and the CDP facilitator speak (header names, `x402Version`, network
identifiers such as CAIP-2 `eip155:8453`, payload shape), and whether v1 is still accepted.
Test against at least two public x402 endpoints found in the x402 ecosystem directory: record
the raw 402 response each returns. Write `docs/x402-compat.md` with findings and the exact
shape differences. Do not guess; quote the spec.
*Done when:* the document states, with sources, which version(s) to support and the diff.

**L-02 Support the wire version L-01 requires.** `agent` · L · depends: L-01
If v2 is required: extend `types.ts` with the v2 shapes alongside v1 (do not remove v1),
teach `payingFetch` to detect which the seller sent and answer in kind, teach `paymentGate`
to advertise both, map network ids both ways (`base` ↔ `eip155:8453`) in `live.ts`, and
extend `CdpFacilitator` to the v2 facilitator contract if it differs. Every shape gets a
wire test in `test/wire.test.ts`. If L-01 concludes v1 is sufficient, this ticket closes
with a note in `docs/x402-compat.md` and a date to re-check.
*Done when:* the buyer canary passes against one real third-party x402 seller (not our own
`paymentGate`), on Base Sepolia, and that run is recorded under `docs/canary-runs/`.

**L-03 `init --live` in the CLI.** `agent` · M · depends: —
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
`allowance-kit pay <url> [--method GET|POST] [--body <json>]` builds the runtime for the
directory's mode (practice: `createAgent`; live: `createLiveAgent` with the env key), runs
`payingFetch`, prints the result the way `audit` prints a row (paid: cost, tx hash, first
200 bytes of body; blocked: the `RULE_LABELS` sentence and what to do). Exit 0 on paid, 2 on
blocked, 1 on error. This is how a non-coder proves their first real payment and how the
tutorial will demonstrate it.
*Done when:* practice and live tests exist; the site tutorial (S-03) uses it.

**L-05 Key handling documentation and `doctor`.** `agent` · S · depends: L-03
`allowance-kit doctor` checks: Node version, `viem` presence, env vars for the configured
channels and for live mode, RPC reachability, state-dir permissions, whether the directory
is live and on which network, and prints one line per check with a fix. README gets a
"Real money in five commands" section: `init --live`, fund, `topup`, `policy`, `pay`.
*Done when:* `doctor` exits non-zero on a missing key and zero on a working setup.

**L-06 Dashboard: authenticate reads, show all agents.** `agent` · M · depends: —
`GET /api/state` requires the same token as mutations (the served page already has it).
State returns every agent in the directory; the UI gets an agent switcher. Keep it
loopback-only.
*Done when:* an unauthenticated GET returns 401; the switcher lists agents from `listAgents`.

### C — Wallie Cloud v1 (gate)

Default stack (decision D-1): Vercel project `wallie-cloud`, Node functions, no framework,
Postgres on Neon through the Vercel Marketplace, Resend for email, Twilio for SMS. Every
function is a single file under `api/`, plain `fetch`, no ORM (use `@neondatabase/serverless`
or the `pg` driver, whichever the marketplace integration installs). Repo:
`~/dev/wallie-cloud` (new). Same design system as the site (`wallie.css` copied, see memory
about 1yc.dev tokens).

**C-01 Schema and migrations.** `agent` · M · depends: —
`sql/001_init.sql` creating: `workspaces(id, name, stripe_customer_id, stripe_subscription_id,
status[active|past_due|canceled], created_at)`, `workspace_keys(id, workspace_id, key_hash,
prefix, created_at, revoked_at)`, `agents(id, workspace_id, name, state_dir_hint, network,
last_seen_at, first_seen_at)`, `events(id, workspace_id, agent_id, kind, rule, amount_micro,
host, tx_hash, request_id, payload jsonb, occurred_at, received_at)`, `alert_rules(id,
workspace_id, channel[email|sms|webhook], target, events[] , silent_after_seconds, enabled)`,
`deliveries(id, workspace_id, rule_id, event_id, status, attempts, last_error, sent_at)`,
`magic_links(token_hash, email, workspace_id, expires_at, used_at)`, `sessions(id,
workspace_id, email, expires_at)`. Indexes on `(workspace_id, occurred_at)`,
`(workspace_id, last_seen_at)`. A `scripts/migrate.js` that applies files in order and records
them in `schema_migrations`.
*Done when:* `node scripts/migrate.js` is idempotent against an empty Neon branch.

**C-02 Stripe webhook → provisioning.** `agent+human` · M · depends: C-01
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
`POST /v1/events` and `POST /v1/heartbeat`, `Authorization: Bearer wk_…`. Look up key by
hash, reject revoked or non-active workspaces with 402 (fitting) and a JSON reason. Body of
`/v1/events` is the runtime's `NotifyMessage` (see `notify.ts`) plus `agentName`, `network`,
`mode`; server strips query strings from any URL field again, caps payload at 8 KB, stores
one row, upserts the agent, and enqueues deliveries for matching rules (C-04). `/v1/heartbeat`
body `{agentName, network, mode, version}` updates `last_seen_at`. Rate limit 600 req/min per
key with 429 + `Retry-After`. Return `{ok:true}` fast; never do fan-out inline.
*Done when:* integration test posts 100 events and 10 heartbeats with a valid key and sees
them in the feed; invalid key gets 401; revoked gets 402.

**C-04 Fan-out and watchdog.** `agent` · L · depends: C-03
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
send a `back` event. SMS is limited to `blocked`, `approval_requested`, `silent`, and
`budget 100%` by default to keep costs bounded.
*Done when:* a test workspace with an email rule receives: one email per synthetic block,
one "agent silent" email 5 minutes after heartbeats stop, one "agent back" email after they
resume. Twilio path tested with a real number once by human.

**C-05 The `cloud` channel in the runtime.** `agent` · M · depends: C-03 (for a live target),
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
Plain-text-first, with a minimal HTML twin in the site's typography: welcome (key, the three
commands `npm i -g allowance-kit`, `export WALLIE_CLOUD_KEY=…`, `allowance-kit notify cloud …`,
sign-in link), magic link, alert (one template, the `text` body from fan-out), silent /
back, subscription canceled. All from `alerts@onewallie.com`, reply-to hello@.
*Done when:* each template renders with fixture data in a `templates.test.js`.

**C-07 Magic-link auth and the account app.** `agent` · L · depends: C-01, C-06
`app.onewallie.com` static pages + `api/v1/auth/*`: enter email → magic link (15 min,
single use) → session cookie (`HttpOnly; Secure; SameSite=Lax`, 30 days). Pages: **Overview**
(workspace name, status, agents with last-seen and mode/network badge, REAL MONEY badge when
any agent is live), **Key** (prefix shown, "rotate" creates a new key and revokes the old
after 24 h, copy-to-clipboard of the three setup commands), **Events** (read-only feed, newest
first, filter by agent and kind, 50 per page), **Alerts** (rules CRUD: channel, target,
which events, silence threshold; "send test"), **Billing** (link to Stripe Customer Portal,
human enables the portal in Stripe). No framework; `fetch` against `/v1/*`; `textContent`
only, never `innerHTML` (the local dashboard rule).
*Done when:* a Playwright-free manual script in `docs/qa-cloud.md` can be followed end to
end on a preview deploy, and every mutation endpoint rejects a request without a session.

**C-08 Deployment, domains, environment.** `agent+human` · M · depends: C-01..C-07
`vercel.json` with the cron, function timeouts, and the two hostnames. Env vars documented
in `README.md` of the cloud repo: `DATABASE_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`RESEND_API_KEY`, `TWILIO_*`, `SESSION_SECRET`, `APP_ORIGIN`, `API_ORIGIN`. Human: add DNS
for `api.` and `app.`, set env in Vercel, verify Resend domain, buy/verify the Twilio number.
Note in the README that the site's domains are pinned aliases (memory) and check whether the
cloud project's are too after first deploy.
*Done when:* `curl https://api.onewallie.com/v1/me` without a key returns a JSON 401, and
`app.onewallie.com` loads the sign-in page over HTTPS.

**C-09 Cloud test suite and CI.** `agent` · M · depends: C-03, C-04
`node --test` suite against a Neon branch created in CI (`neonctl branches create`), covering
webhook idempotency, key hashing/rotation, ingest validation, watchdog transitions, delivery
retry classification. GitHub Actions on the cloud repo mirrors R-02.
*Done when:* CI is green on the cloud repo and a broken webhook signature check fails it.

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
14-day refund policy for the first month, governing law NL. Human reviews before deploy.
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
Every "€20/mo workspace + 1% volume" becomes "€20/mo per workspace" (footnote: usage
pricing may come later, with notice). The "How Wallie Cloud works" section describes exactly
C-03/C-04/C-07, no more. Remove "subscribers vote on the roadmap" unless Fernando wants to
keep that promise (decision D-4). Roadmap note in `docs.html` updated: CDP adapter ✓, npm ✓,
Cloud ✓ (alerts + watchdog), next: approve-from-phone, compliance exports.
*Done when:* `grep -rn "1%" index.html docs.html` is empty and every Cloud claim maps to a
shipped ticket.

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
*Done when:* `curl -s https://onewallie.com | grep -c "1%"` prints 0.

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
reply. Verify GitHub Discussions is enabled on `fskroes/AllowanceKit`; if not, human enables it.

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
- **D-7 Versioning:** 0.5.0 for deliverable A. 1.0.0 is reserved for the release after the
  first paying customer has run for 30 days with no money-path bug.

## 6. Human-only checklist (hand to Fernando in this order)

1. M-01: fund the canary wallet on Base with USDC.
2. B-01: Stripe Tax, Customer Portal, success URL, statement descriptor.
3. C-02 / C-08: create the Stripe webhook, paste secrets and all env vars into Vercel, DNS
   for `api.` and `app.onewallie.com`, verify `onewallie.com` in Resend, buy a Twilio number.
4. R-06: export `NPM_ACCESS_TOKEN` and run the release script.
5. S-04: run the alias commands after the site deploy.
6. B-02: read the updated terms and privacy pages before they go live.
7. O-03: enable GitHub Discussions if it is off.

## 7. Launch gate

All of the following are true, each verifiable by a command or a URL:

- [ ] `npx wallie@latest --version` and `npx allowance-kit@latest --version` print `0.5.0`.
- [ ] `docs/canary-runs/` contains a passing mainnet run with a BaseScan link.
- [x] `docs/x402-compat.md` exists and the testnet canary passed against a third-party seller.
      (Mart402, Base Sepolia, 2026-09-07 — `docs/canary-runs/2026-09-07-base-sepolia-mart402.md`.)
- [ ] CI is green on `main` for both repos.
- [ ] A test-mode Stripe purchase produces a welcome email with a working key within 2 minutes.
- [ ] `allowance-kit notify cloud <key>` followed by `notify test` shows `delivered cloud`.
- [ ] Stopping the agent produces an "agent silent" email within 6 minutes.
- [ ] `curl -s https://onewallie.com | grep -c "1%"` prints 0.
- [ ] Terms and privacy list the sub-processors and retention.
- [ ] `SECURITY.md`, `CHANGELOG.md`, five git tags, and a README badge exist.
