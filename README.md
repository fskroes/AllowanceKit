# AllowanceKit

**A spending allowance for your AI agent.** Fund it once. It pays any x402-priced API on its own — inside hard limits *you* set, with a kill switch and a receipt for every cent.

Landing page: [onewallie.com](https://onewallie.com) · Follow-along tutorial: [onewallie.com/docs.html](https://onewallie.com/docs.html)

```bash
npx allowance-kit demo          # watch the whole thing work, end to end (30 seconds)
npx allowance-kit init          # create the agent's wallet
npx allowance-kit topup 5.00    # fund the allowance
npx allowance-kit dashboard     # live spending, kill switch, approval queue
```

![The AllowanceKit dashboard: $2.14 left of a $5.00 allowance, $2.86 spent across 156 payments with 6 stopped, one $0.42 payment waiting on a human decision, and every payment and block listed in plain English.](docs/dashboard.png)

*The dashboard. One payment is parked for a human — nothing moves until someone decides.*

## What this does and does not cap

**It caps** payments your agent makes *through AllowanceKit* to x402-priced APIs — every call routed through `payingFetch`.

**It does not cap** your existing OpenAI, Anthropic, or cloud bill. Those are metered on an account, not paid per call over x402, and nothing here can stop them. If a surprise invoice from a metered API is the problem you're solving, this is not yet the tool for it.

### Is this for you?

- **Yes** if you're building an agent that calls paid APIs and you want a hard ceiling on what it can spend, plus an audit trail of every payment.
- **Yes** if you're selling an x402 API and want drop-in middleware — see [`paymentGate`](#sellers).
- **Not yet** if you want a cap on a credit card or on metered API accounts.

Requires **Node ≥ 20.11** to use the npm package. ESM only — `import`, not `require`. Zero runtime dependencies. Running this repo's TypeScript sources directly needs **Node ≥ 24**; on older versions run `npm install && npm run build` first.

---

## Practice money by default

Out of the box, settlement runs on a local simulated ledger. Every dollar in the CLI, the demo and the dashboard is practice money, and the tool says so at every money touchpoint. Nothing real can move until you deliberately wire a real rail ([sellers](#sellers) via `CdpFacilitator`, [buyers](#live-networks) via `createLiveAgent`).

That is the point: you can prove the rails hold before any real funds are at risk.

---

## The one-import SDK

```ts
import { createAgent, topUp, payingFetch } from "allowance-kit";

const agent = createAgent(".allowance");        // same default agent the CLI manages
topUp(agent, 5);                                // fund the allowance (practice money)

// The host allowlist is default-deny. Allow the destination first:
agent.policyStore.save({ allowHostSuffixes: ["api.example.com"] });

const res = await payingFetch(agent.ctx, "https://api.example.com/weather?city=lisbon");
if (res.ok) console.log(res.body, res.costMicro, res.txHash);
else console.log(res.blockedBy);  // { rule, detail, recoverable, quotedMicro, capMicro, retryAfterMs?, requestId? }
```

`createAgent(stateDir, agentName)` files spend, top-ups and the remaining allowance under `agentName`. The CLI uses `DEFAULT_AGENT_NAME` (`"research-agent"`); pass the same name in code or the agent will look unfunded.

### Agents can act on a block, not just log it

`blockedBy` carries enough to self-correct:

| Field | Use |
|---|---|
| `rule` | a closed union — `switch` on it exhaustively |
| `recoverable` | `false` means retrying will never help; stop |
| `quotedMicro` / `capMicro` | how far over the limit the price was → retry a cheaper tier |
| `retryAfterMs` | how long until the velocity window clears → back off |
| `requestId` | the queued approval to escalate to a human |

```ts
const res = await payingFetch(agent.ctx, url);
switch (res.blockedBy?.rule) {
  case "velocity_circuit_breaker": await sleep(res.blockedBy.retryAfterMs!); break;
  case "per_call_cap":             return tryCheaperTier(res.blockedBy.quotedMicro!, res.blockedBy.capMicro!);
  case "human_approval_required":  return askHuman(res.blockedBy.requestId!);
  case "insufficient_funds":       return askHumanToFundWallet(res.blockedBy!.capMicro!);
  case "budget_exhausted":         return giveUp("out of allowance");
}
```

---

## Why this exists (research, Aug 2026)

The agentic payment infrastructure **is live and scaling**:

| Signal | Number |
|---|---|
| x402 network volume (last 30 days) | **75.4M payments · $24.2M** (~$0.32 avg — true micropayments) |
| x402 Foundation | Linux Foundation; founding members incl. Visa, Mastercard, Stripe, Google, AWS, Cloudflare |
| Alipay AI-initiated payments | 120M in one week (Feb 2026) |
| MPP (Stripe/Tempo) | mainnet Mar 2026, 100+ services |

But the buyer side is broken. Verified evidence from primary sources:

1. **x402 issue #1759 (open): "agent onboarding is too complex"** — a top-10 ecosystem operator reports users abandoning x402 because there is *"no install-and-go experience"*: manual wallet setup, funding, config, and *"no wallet UI showing balance, transaction history."*
2. **Runaway agents are real**: documented cases of agents burning $8,400+ in overnight retry loops. Facilitators verify payments are *valid*; nothing checks whether they're *sane*.
3. **EU AI Act Article 26 (in force Aug 2, 2026)**: deployers of spending agents must keep tamper-evident logs, enforce human oversight, and can be fined up to 3% of global turnover. x402 settles inline with zero audit trail.
4. Every existing fix (Crossmint guardrails, Coinbase Agentic Wallets, XPay firewall) is a proprietary platform account. Nothing is open, self-hostable, protocol-native, and installable in one command.

AllowanceKit is that missing piece: the **allowance layer between the human and the agent's wallet**.

## The rails

The agent calls `payingFetch(ctx, url)` instead of `fetch(url)`. That handles the whole protocol — 402 challenge → price discovery → two-phase authorization → signed payment → settle → receipt — while the policy engine enforces:

| Rail | Rule | Blocked pre-payment |
|---|---|---|
| `killSwitch` | human freeze, instant | ✅ |
| `host_not_allowlisted` / `blockedHosts` | default-deny destinations | ✅ |
| `per_call_cap` | max price per single call | ✅ |
| `velocity_circuit_breaker` | rolling-window spend limit (kills retry loops) | ✅ |
| `budget_exhausted` | hard total: the agent can spend `min(totalBudgetUsd, amount funded)` | ✅ |
| `insufficient_funds` | live rails only: the wallet's real USDC balance cannot cover the price | ✅ |
| `human_approval_required` | escalation gate above threshold | ⏸ blocked & queued until you approve |
| `settlement_rejected` | the seller refused the payment; nothing was spent | ✅ logged |

Two properties worth stating plainly:

- **Authorization is atomic.** Deciding and reserving happen inside one state-dir lock, and in-flight payments count as spent until they settle. Twenty parallel `payingFetch` calls against a $1.00/60s velocity limit settle exactly $1.00 — a retry storm cannot fan out past the breaker.
- **`totalBudgetUsd` is enforced, not decorative.** The spendable ceiling is the smaller of what you configured and what you funded.
- **On a live rail, the wallet is checked too.** The allowance says what a human permitted; the chain says what is actually there. A payment the allowance allows but the wallet cannot cover is refused as `insufficient_funds` before anything is signed — not discovered at the facilitator. If the RPC is unreachable the rails fall back to the allowance rather than freezing the agent over someone else's outage.

Approvals are real, and they are not permanent. An above-threshold call is blocked and queued (`allowance-kit approvals` or the dashboard). Approving creates a grant that **expires in 24 hours and covers exactly the amount that was approved** — one yes is one payment, not a standing licence. Widen it deliberately:

```bash
npx allowance-kit approve a1b2c3d4                        # that payment, for 24 hours
npx allowance-kit approve a1b2c3d4 --budget 2.00          # up to $2.00 of spend to that host
npx allowance-kit approve a1b2c3d4 --expires 2h           # or 30m, 7d, never
```

Grants draw down as payments authorize against them, and a payment that never settles hands its budget back. Approving **does not execute the payment**; the agent completes it on its next attempt. Every step is in the ledger.

The kill switch and approval queue are **token-gated**: mutating dashboard endpoints require the local control token (auto-generated into `.allowance/dashboard-token`, injected into the served UI).

Every decision — paid or blocked, with rule, reason and tx hash — lands in an append-only JSONL ledger (`.allowance/ledger.jsonl`) that satisfies EU AI Act Art. 26 §5 logging. Read it as a table with `allowance-kit audit`, or as raw JSONL with `allowance-kit audit --json`.

## CLI

```
init                            provision the agent wallet in ./.allowance
topup <usd>                     add to the allowance
status                          what is left, what the limits are, what needs you
policy [field value]            show or change one limit
approvals                       payments waiting for your decision, and live grants
approve <id> | deny <id>        decide one (--budget <usd>, --expires <30m|2h|7d|never>)
audit [--json]                  the full spending history
notify [webhook|email|sms|push|heartbeat|test|off]   where alerts are sent, and on what
agents                          every agent sharing this state directory
dashboard [--port <n>]          live dashboard (default http://localhost:4030)
demo                            run the built-in demo into ./.allowance-demo

--state <dir>                   state directory (default ./.allowance, or $ALLOWANCE_STATE_DIR)
--agent <name>                  which agent in that directory (default research-agent, or $ALLOWANCE_AGENT)
```

### More than one agent in one directory

Every command takes `--agent`. Limits, allowances, approvals and alert settings are per agent; the audit ledger is shared and every row is tagged.

```bash
npx allowance-kit topup 3.00 --agent writer-agent
npx allowance-kit policy perCallMaxUsd 0.02 --agent writer-agent
npx allowance-kit agents        # what is in this directory, and what each has left
```

The first agent keeps the original file names (`config.json`, `agent.json`), so a directory written by an earlier version reads back unchanged.

Limits: `totalBudgetUsd`, `perCallMaxUsd`, `windowLimitUsd`, `windowSeconds`, `requireApprovalAboveUsd`, `allowHostSuffixes`, `blockedHosts`, `killSwitch`. Unknown fields are rejected, not silently written, and combinations where one rail shadows another produce a warning.

```bash
npx allowance-kit policy perCallMaxUsd 0.10
npx allowance-kit policy allowHostSuffixes api.weather.com,api.search.com
npx allowance-kit policy killSwitch true      # freeze everything, right now
```

## Alerts, so nobody has to watch a screen

A dashboard only helps someone who is looking at it. The runs that hurt happen overnight.

```bash
npx allowance-kit notify webhook https://hooks.slack.com/services/...   # Slack, Discord, Zapier, your own server
npx allowance-kit notify email you@example.com --from alerts@you.com    # needs a provider key, below
npx allowance-kit notify sms +31612345678                               # needs Twilio keys, below
npx allowance-kit notify push my-agent-alerts                           # ntfy.sh — no account, no key
npx allowance-kit notify heartbeat https://hc-ping.com/<uuid>           # a dead-man's switch, see below
npx allowance-kit notify test                                           # send one of each now, report delivery
npx allowance-kit notify                                                # show what is set up
npx allowance-kit notify off                                            # stop sending anything
```

You get told about three things:

- **Spending**, at 50%, 80% and 100% of the allowance. Once per threshold, not once per payment. Topping up rearms them.
- **Every block** — which rail refused, what it tried to pay, and that nothing moved.
- **Every payment waiting on you**, with the `approve` and `deny` commands to settle it.

Every channel is an HTTP POST made with the platform's own `fetch` — email and SMS go through a provider's REST API rather than SMTP or a vendor SDK, so the package keeps its zero-dependency promise. Keys live in your environment, **never in a config file**:

```bash
export RESEND_API_KEY=...        # for --via resend (the default)
export POSTMARK_API_TOKEN=...    # for --via postmark
export TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... TWILIO_FROM=+1...   # for notify sms
```

Push needs nothing at all: pick a topic, install the [ntfy](https://ntfy.sh) app, subscribe. Anyone who knows the topic name can read it, so pick something unguessable.

`notifications.json` in the state dir holds addresses and providers. It never holds a key, so it is safe to read, copy, or paste into a bug report.

**Delivery is retried, and failures are written down.** A timeout, a 429 or a 5xx is tried three times with backoff; a 401 is not retried, because a wrong key is wrong three times too. Anything that still never arrived lands in `notify-failures.jsonl` and is surfaced by `notify` and `status`. Alerts remain best-effort by construction — never awaited inside the ledger lock, so a webhook that hangs cannot slow a payment down and one that errors cannot fail one. The ledger, not your inbox, is the record of what happened.

### When the machine itself goes quiet

Nothing running on your laptop can tell you that your laptop is off. Something outside it can:

```bash
npx allowance-kit notify heartbeat https://hc-ping.com/<uuid>
npx allowance-kit dashboard        # pings that URL every 60s while it runs
```

Point [healthchecks.io](https://healthchecks.io), Cronitor or your own monitor at that URL and it alerts you when the pings stop. That is the honest shape of the guarantee: the free channels fire while the agent is running somewhere you control, and a dead-man's switch covers the case where it is not.

## Architecture

```
src/
  index.ts          public API — `import { payingFetch, createAgent, topUp } from "allowance-kit"`
  types.ts          x402 wire types (PaymentRequired, PaymentPayload, receipts)
  money.ts          integer micro-dollar math (no float drift)
  chain.ts          settlement + Facilitator interface {verify, settle}
                    MockChain = deterministic local ledger w/ replay protection,
                    snapshots to disk. Swap for a real facilitator by
                    implementing 2 methods — nothing else changes.
  facilitator-cdp.ts Coinbase CDP facilitator: verify/settle over the x402 v1
                    facilitator contract with ES256 request-signed JWTs
                    (node:crypto only). For sellers settling real USDC on Base.
  live.ts           live-network agent runtime: real x402 v1 EVM payloads
                    (EIP-3009 TransferWithAuthorization, EIP-712 signed via
                    optional viem) against any live x402 endpoint.
  seller.ts         paymentGate(): drop-in x402 middleware for any node:http route
  payer.ts          payingFetch(): the agent-side client (two-phase authorization)
  policy.ts         PolicyStore (hot-reloaded JSON) + evaluatePolicy() + field validation
  lock.ts           state-dir mutex (in-process + cross-process, stale-safe)
  reservations.ts   authorized-but-unsettled spend, so parallel calls can't overspend
  approvals.ts      human-approval queue (request → decide → standing grant)
  wallet.ts         agent runtime: stable wallet identity, funding, authorization gate
  ledger.ts         append-only audit log (parse-cached, single-pass totals)
  demo-servers.ts   five x402-priced APIs used by the demo
  demo-run.ts       the demo story, shipped in the package as `allowance-kit demo`
  dashboard-server.ts + public/dashboard.html   live UI; kill switch & approvals
                    are token-gated (.allowance/dashboard-token)
test/               zero-dependency node --test suite
```

The wire format follows x402 v1 (`HTTP 402` + `accepts[]` + base64 `X-PAYMENT` / `X-PAYMENT-RESPONSE` headers).

### Sellers

```ts
import { paymentGate, CdpFacilitator } from "allowance-kit";

paymentGate(
  {
    priceMicro: 10_000n,               // $0.01 == 10k atomic USDC units
    description: "Weather lookup",
    payTo: "0xYourMerchantAddress",
    network: "base-sepolia",
    facilitator: new CdpFacilitator(), // reads CDP_API_KEY_ID / CDP_API_KEY_SECRET
  },
  handler,
);
```

### Live networks

```ts
import { payingFetch, createLiveAgent, topUp } from "allowance-kit";

const live = await createLiveAgent({
  stateDir: ".allowance",
  privateKey: process.env.AGENT_KEY!,
  network: "base-sepolia",              // "base" is mainnet — ask for it explicitly
});

topUp(live, 5);                         // the ceiling you allow out of that wallet
live.policyStore.save({ allowHostSuffixes: ["some-live-x402-api.com"] });

const res = await payingFetch(live.ctx, "https://some-live-x402-api.com/data");
```

**The allowance and the wallet are two different numbers, and both are enforced.** `topUp` records what you are willing to let the agent spend; the USDC itself arrives by being sent to `live.address`. A payment inside the allowance that the wallet cannot cover is refused as `insufficient_funds` before anything is signed. Check both at once with `allowance-kit status`, which prints the wallet's real balance on a live directory.

The directory is marked live the moment `createLiveAgent` touches it, so the CLI and the dashboard stop saying "practice money" and start saying `REAL MONEY — payments settle in USDC on base-sepolia`. Funding from the CLI on a live directory says plainly that it raised a ceiling and moved nothing.

`network` is a hard constraint, not a hint: a seller quoting a chain the agent was not configured for is refused before signing, so a testnet agent can never be talked into signing a mainnet authorization.

Signing needs the optional peer dependency [`viem`](https://viem.sh) (`npm i viem`); everything else stays zero-dep. Policy, approvals, kill switch and the audit ledger apply identically to simulated and live spending.

Prove the whole path before trusting it with anything:

```bash
node --env-file=.env scripts/canary.ts --buyer                  # Base Sepolia, free faucet USDC
node --env-file=.env scripts/canary.ts --buyer --network base   # mainnet, real money
```

It funds a $0.20 allowance with a $0.05 per-call cap, settles a real $0.01 payment through a CDP facilitator, then tightens the cap and checks the next payment is refused — and fails loudly if the audit ledger does not show exactly one payment and one block.

## Demo output (abridged)

`npx allowance-kit demo`:

```
PHASE 1 · fine-grained pay-per-use
  PAID    weather?city=lisbon            $0.001000  0xcddcb9a6…
  PAID    research?topic=agent-payments  $0.250000  0x4e5bc352…

PHASE 2 · runaway loop
  PAID    loop #1…#149                   $0.010000 each
  BLOCKED loop #150  Too much, too fast  rolling 12s spend would exceed $2.00

PHASE 3 · attack, mispricing & approval gate
  BLOCKED evil-api.example.com  Site not on your approved list
  BLOCKED report?id=q3-2026     Waiting for your approval ($0.45 ≥ $0.30 → queued)
  PAID    report?id=q3-2026 (retry)      $0.450000 (approved grant)
  BLOCKED feed?key=pro          Over your per-payment limit ($5 > $0.50)

PHASE 4 · kill switch
  BLOCKED weather?city=berlin   Spending paused by you

spent $2.443 across 155 settled payments; 5 policy blocks enforced
remaining allowance: $2.557 of $5.00 practice money
```

## Business model

See [BUSINESS.md](BUSINESS.md).

## Honest limitations

- Default settlement is a local mock ledger — **all funds are simulated** until you deliberately wire a real rail. Sellers settle real USDC via `CdpFacilitator`; buyers sign real x402 v1 payments via `createLiveAgent` (needs optional `viem`).
- **The live buyer path is proven on Base Sepolia, not yet on mainnet.** `scripts/canary.ts --buyer` settles a real testnet USDC payment through a CDP facilitator inside real rails and checks the ledger afterwards. The same command with `--network base` runs it on mainnet; nobody has run that yet. Treat the first mainnet runs as canary.
- **Alerts are best-effort, not guaranteed.** Retried three times with backoff, then recorded in `notify-failures.jsonl` — but never awaited inside the ledger lock, so a payment is never delayed or failed by a broken channel. The ledger, not your inbox, is the record of what happened.
- **Free alerts only fire while the agent is running on a machine you control.** `notify heartbeat` plus an outside monitor covers the case where it is not; genuinely hosted alerting is not built.
- SMS needs a Twilio account and costs money per message. Push over ntfy is unauthenticated by design: anyone who knows the topic name can read your alerts.
- The on-chain balance check reads USDC over a public RPC and caches it for 15 seconds, so a payment can be authorized against a reading that is up to 15 seconds stale. Bring your own `rpcUrl` for anything busy.
- Several agents can share a state dir, but they share one lock, so a very busy agent serialises the others' authorizations.
- The dashboard binds to `127.0.0.1` and gates all mutations behind a token, but `GET /api/state` is unauthenticated to anything already on the loopback interface. It also shows one agent at a time.
- npm ships compiled `dist/` (ESM + `.d.ts`, zero runtime deps).

## Changes in 0.4.0

The release that makes real money work, and makes a "yes" stop meaning "yes, forever".

Breaking:

- **Approval grants expire and have a budget.** `approve <id>` now covers exactly the amount that was approved, for 24 hours, and draws down as payments authorize against it. Previously a single yes was a standing licence for that host and price. `--budget <usd>` and `--expires <30m|2h|7d|never>` widen it deliberately; `decideApproval(rt, id, true, { budgetMicro, expiresInMs })` is the SDK equivalent.
- `PolicyRule` gained `insufficient_funds`. Exhaustive `switch` statements over it need a new arm.
- `topUp`, `decideApproval` and `allowanceRemaining` take `AllowanceRuntime` — a live agent and a practice agent both satisfy it. `AgentRuntime` extends it and still carries `chain: MockChain`.
- `ApprovalStore`, `PolicyStore` and `NotifyStore` take an optional agent name and scope themselves to it.

Fixed:

- **A live agent could not be funded at all.** `topUp()` reached for the mock chain's faucet, which a live runtime does not have, so it threw — and every real payment was refused as `budget_exhausted` against a $0.00 allowance. The documented live snippet could not make a single payment. It now records the ceiling without a faucet.
- **The CLI told a live directory it was practice money.** `init`, `topup` and `status` printed "no real money can move" over an allowance governing real USDC, and showed a simulated address instead of the payer. A directory is now marked when `createLiveAgent` claims it, and every reader says `REAL MONEY — payments settle in USDC on <network>`.

Added:

- **The wallet is reconciled against the chain.** A live agent reads its real USDC balance over plain JSON-RPC and refuses payments the wallet cannot cover (`insufficient_funds`) before signing, instead of discovering it at the facilitator. Cached for 15s and fail-open: an unreachable node falls back to the allowance rather than freezing the agent.
- **`network` is a hard constraint on a live agent.** A seller quoting a different chain is refused before anything is signed. Defaults to `base-sepolia`.
- **SMS and push.** `notify sms <e164>` over Twilio, `notify push <topic>` over ntfy (no account, no key).
- **Alerts are retried and failures are recorded.** Three attempts with backoff for anything retrying can fix, none for a 401, and whatever still never arrived lands in `notify-failures.jsonl` and is surfaced by `notify` and `status`.
- **`notify heartbeat <url>`** — a dead-man's switch pinged while the dashboard runs, so an outside monitor can alert you when this machine goes quiet.
- **Several agents per state directory.** `--agent <name>` on every command, per-agent limits, allowances, approvals and alert settings, and `allowance-kit agents` to list them. The first agent keeps the original file names.
- `scripts/canary.ts --buyer [--network base]` — the buyer runtime end to end: real settlement inside real rails, with the ledger checked afterwards.
- New exports: `AllowanceRuntime`, `listAgents`, `modeOf`, `readMode`, `writeMode`, `describeMode`, `describeTopUp`, `usdcBalanceMicro`, `BalanceCache`, `RPC_DEFAULTS`, `RpcError`, `startHeartbeat`, `DEFAULT_GRANT_TTL_MS`, `policyFileName`, `TWILIO_ENV`, and the `DecideOptions` / `DeliveryResult` / `DeliveryFailure` / `ModeInfo` / `SettlementMode` types.

## Changes in 0.3.0

Added:

- **Notifications.** `notify webhook`, `notify email`, `notify test`, `notify off`. Alerts fire at 50/80/100% of the allowance, on every block, and on every payment queued for a human. Webhook payloads carry both a Slack/Discord-shaped `text` field and flat structured detail. Email goes over Resend or Postmark's REST API; the key is read from the environment and never written to disk. New exports: `NotifyStore`, `Notifier`, `deliver()`, `defaultNotifyConfig`, `providerEnvVar()`, and the `NotifyConfig` / `NotifyEvent` / `NotifyMessage` types. `AgentRuntime` gained `notifyStore`.
- **The CLI answers to the name you typed.** Run it as `wallie` and every hint it prints back says `npx wallie`; run it as `allowance-kit` and they say `npx allowance-kit`. The dashboard follows the same name. A bare `node dist/cli.js` falls back to the published name rather than printing `npx cli`.
- The dashboard's Settings panel shows where alerts go, or says nobody is told.

`wallie` on npm is an alias for this package: same CLI, same SDK, the name [onewallie.com](https://onewallie.com) uses.

## Changes in 0.2.0

Breaking:

- `totalBudgetUsd` is now **enforced**. An agent funded above its configured budget stops at the budget. Previously the field was display-only and the funded amount was the real cap.
- `PolicyStore.save()` throws `PolicyValidationError` on unknown fields, wrong types and negative amounts. Previously typos were written silently.
- `PaidResult` gained a required `quotedMicro`; `blockedBy.rule` narrowed from `string` to the `PolicyRule` union and gained `recoverable`.
- `buildPolicyRails()` requires `stateDir` (it owns the lock and the reservation store).
- `recordPayment` / `recordBlocked` may return a promise.

Added: `topUp()`, `DEFAULT_AGENT_NAME`, `RULE_LABELS`, `POLICY_FIELDS`, `validatePolicyPatch()`, `policyWarnings()`, `effectiveBudgetMicro()`, `ReservationStore`, `runDemo()`, and `allowance-kit` as a second bin name.

Fixed: parallel `payingFetch` calls can no longer overspend the velocity or budget rails; seller-rejected payments now set `error`, log a `settlement_rejected` ledger row and release the hold; `init` prints real file paths; the dashboard allowance meter measures the allowance instead of the spend.
