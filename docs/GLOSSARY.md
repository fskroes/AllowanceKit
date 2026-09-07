# Glossary

Terms as used in this repo, on onewallie.com, and in [RELEASE-PLAN.md](RELEASE-PLAN.md).
Where a term names a file or export, it is given so an agent can grep for it. Alphabetical.

**Agent** — a program that calls paid APIs through `payingFetch`. Also **agent name**: the
label every ledger row, top-up and policy is filed under (`DEFAULT_AGENT_NAME` is
`"research-agent"`; `--agent` or `ALLOWANCE_AGENT` overrides). Several agents can share one
state directory; each has its own policy, allowance, approvals and alert settings.

**Alias (npm)** — `wallie` on npm is a thin package that depends on `allowance-kit`, imports
its CLI in-process and re-exports its SDK. `npx wallie` and `npx allowance-kit` are the same
tool. Must be republished on every release (it pins a caret range on the minor).

**Allowance** — the amount a human has permitted an agent to spend, recorded by `topUp`. On
the practice rail it is also a balance; on a live rail it is only a ceiling and the USDC
must be sent to the wallet separately. Spendable amount is `min(totalBudgetUsd, funded) −
spent − reserved`. See `effectiveBudgetMicro`, `allowanceRemaining`.

**AllowanceKit** — the open-source runtime and npm package (`allowance-kit`). The product
name on the website is **Wallie**. Same thing; see *Alias*.

**AllowanceRuntime** — the interface both a practice agent and a live agent satisfy
(`stateDir`, `agentName`, `ctx`, `policyStore`, `approvalStore`, `notifyStore`, `ledger`,
`policy()`). `AgentRuntime` extends it with `chain: MockChain`. Functions that only need
the allowance take `AllowanceRuntime`.

**Approval / approval request** — a payment blocked by `human_approval_required` and queued
(`ApprovalStore`, `.allowance/approvals*.json`) until a human runs `approve <id>` or
`deny <id>`. Approving does not pay; the agent retries and the payment authorizes against
the resulting *grant*.

**Audit ledger / ledger** — append-only JSONL file `.allowance/ledger.jsonl` (`Ledger` in
`ledger.ts`). One row per decision: topup, payment, blocked, policy_change,
approval_requested, approval_decided. Shared by all agents in a directory; rows are tagged
by agent name. The record of truth; alerts are not.

**Authorization (two-phase)** — `payingFetch` first asks the rails whether it may pay
(`authorize`), which reserves the amount under the state-dir lock, then signs and sends, then
`recordPayment` or `recordBlocked` settles or releases the reservation. Parallel calls
cannot overspend because deciding and reserving are one atomic step.

**Balance check (on-chain)** — a live agent reads its real USDC balance over JSON-RPC
(`usdcBalanceMicro`, `BalanceCache`, `RPC_DEFAULTS`) before signing. Cached 15 s.
**Fail-open**: if the RPC is unreachable the rails fall back to the allowance alone.

**Base / Base Sepolia** — Coinbase's Ethereum L2 (chain id 8453, mainnet, real money) and
its testnet (84532, free faucet USDC). `NETWORKS` in `live.ts` holds chain id, USDC contract
and EIP-712 domain for each. `network` on a live agent is a hard constraint.

**blockedBy** — the structured reason on a `PaidResult` when a payment was refused:
`{ rule, detail, recoverable, quotedMicro, capMicro, retryAfterMs?, requestId? }`. Built so
an agent can act on it, not just log it.

**Canary** — `scripts/canary.ts`: a script that proves the real path works. Phase 1 checks
CDP auth; `--full` settles through a local seller; `--buyer` runs the real buyer runtime
(allowance, balance check, approval gate, ledger) and asserts the ledger afterwards.
`--network base` runs it with real money. A **canary run** is a recorded, dated result of
that script (`docs/canary-runs/`, to be created).

**CDP / CdpFacilitator** — Coinbase Developer Platform. `facilitator-cdp.ts` implements the
x402 facilitator contract (`verify`, `settle`) against CDP's API, authenticated with an
ES256 JWT built from `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET`. Used by sellers.

**Channel (notify)** — one destination for alerts: `webhook`, `email` (Resend or Postmark),
`sms` (Twilio), `push` (ntfy), `heartbeat` (an outside monitor URL), and, planned, `cloud`
(Wallie Cloud). Configured in `.allowance/notifications.json` by `notify <channel> …`. Config
holds addresses and provider names, never keys.

**Cloud channel** — planned: the notify channel that posts every ledger event and a 60 s
heartbeat to Wallie Cloud using a *workspace key* read from `WALLIE_CLOUD_KEY`. Ticket C-05.

**Control plane** — Wallie Cloud's hosted side: it receives decisions and liveness, stores
them, and alerts. It never decides, signs or pays. Contrast with the *runtime*, which does.

**Control token** — `.allowance/dashboard-token`, a random secret the local dashboard injects
into its page and requires on mutating endpoints (kill switch, approvals). Mode 0600.

**Dashboard (local)** — `allowance-kit dashboard`: `dashboard-server.ts` + `public/dashboard.html`
on `127.0.0.1:4030`. Shows allowance, ledger, approvals, kill switch. Distinct from the
planned hosted **account app** at `app.onewallie.com`.

**Dead-man's switch / heartbeat** — a periodic ping to an outside URL (`notify heartbeat`,
`startHeartbeat`) so that a monitor such as healthchecks.io alerts when pings stop. The only
way a machine can tell you it is off. Wallie Cloud's **watchdog** is the hosted version.

**Demo** — `allowance-kit demo` (`demo-run.ts`, `demo-servers.ts`): five local x402 sellers
and a scripted story (pay-per-use, runaway loop, attack, approval, kill switch) into
`.allowance-demo`. Practice money only.

**EIP-3009 / TransferWithAuthorization** — the USDC contract function that lets a holder sign
an off-chain authorization which the facilitator submits on-chain, paying gas itself. The
payer needs USDC but no ETH. Signed as EIP-712 typed data; the domain must match the
contract exactly (`domainName` differs between testnet "USDC" and mainnet "USD Coin").

**Facilitator** — the x402 party that verifies a payment payload and settles it on-chain on
the seller's behalf. Interface `Facilitator { verify, settle }` in `chain.ts`. `MockChain`
is the practice implementation; `CdpFacilitator` the real one.

**Fan-out** — in Wallie Cloud, turning one stored event into one delivery per matching
alert rule (email, SMS, webhook), with retries and a delivery record.

**Gate (release)** — a ticket without which the product is not released or buyable. Listed
in RELEASE-PLAN section 7.

**Grant** — what an approval produces: permission for a specific host, up to a budget
(default: exactly the approved amount), until an expiry (default 24 h). Draws down as
payments authorize against it; a payment that never settles refunds it. `DEFAULT_GRANT_TTL_MS`,
`DecideOptions`.

**Kill switch** — `policy killSwitch true` or the dashboard button. Every payment is refused
with rule `killSwitch` until it is turned off. Instant, because policy is hot-reloaded.

**Live agent / live mode / live rail** — a runtime created by `createLiveAgent` that signs
real x402 payments with a private key on a real network. The directory is marked in
`mode.json` (`writeMode`, `readMode`, `describeMode`) so the CLI and dashboard say
`REAL MONEY — payments settle in USDC on <network>`. Opposite of *practice*.

**Lock (state-dir)** — `lock.ts`: an in-process and cross-process mutex over a state
directory. Authorization, reservation and ledger writes happen inside it. Alerts never do.

**Magic link** — planned Wallie Cloud sign-in: an emailed single-use link, no password.

**Micro (micro-dollar)** — the integer unit for all money in the code: 1 USD = 1_000_000
micro, as `bigint`. Equals atomic USDC units (6 decimals). `money.ts`. Suffix `Micro` on any
field means this unit; `Usd` means a human-facing float in config only.

**MockChain** — the practice ledger in `chain.ts`: deterministic accounts, faucet, replay
protection, snapshots to `.allowance/accounts.json`. Implements `Facilitator`.

**Mode** — `practice` or `live`, per state directory, in `mode.json`. Practice is the safe
default reading when the file is absent.

**Non-custodial** — Wallie never holds funds or private keys. The key lives in the user's
environment; USDC lives in the user's wallet; Cloud sees decisions only.

**Notifier / NotifyEvent / NotifyMessage** — `notify.ts`. `NotifyEvent` is what the runtime
emits (spend threshold reached, blocked, approval requested, delivery test). `NotifyMessage`
is the rendered form (`text` plus flat fields). `Notifier.emit` runs after the lock is
released, retries, and records failures in `notify-failures.jsonl`.

**paymentGate** — `seller.ts`: middleware for any `node:http` route that answers 402 with an
x402 challenge, verifies `X-PAYMENT` through a facilitator, settles, and then runs the
handler. The seller side of the protocol.

**payingFetch** — `payer.ts`: the agent-side client. Drop-in for `fetch` that handles the
402 challenge, price discovery, policy rails, two-phase authorization, signing, settlement
receipt. Returns `PaidResult` (`ok`, `status`, `body`, `costMicro`, `quotedMicro`, `txHash`,
`blockedBy`, `error`).

**Policy / rails** — `policy.ts`: the per-agent limits in `config.json` (`totalBudgetUsd`,
`perCallMaxUsd`, `windowLimitUsd` + `windowSeconds`, `requireApprovalAboveUsd`,
`allowHostSuffixes`, `blockedHosts`, `killSwitch`), hot-reloaded by `PolicyStore`, evaluated
by `evaluatePolicy` in a fixed order. Each rail maps to a `PolicyRule`:
`killSwitch`, `host_not_allowlisted`, `blockedHosts`, `per_call_cap`,
`velocity_circuit_breaker`, `budget_exhausted`, `insufficient_funds`,
`human_approval_required`, `settlement_rejected`. `RULE_LABELS` gives the plain-English
sentence for each. `validatePolicyPatch` rejects unknown fields; `policyWarnings` flags rails
that shadow each other.

**Practice money** — the default: everything settles on `MockChain`, nothing real can move,
and every money touchpoint says so (`PRACTICE_BANNER`). Formerly "simulated funds".

**Provenance (npm)** — publishing with `--provenance` so the registry shows which commit and
CI run built the tarball. Planned in R-04.

**Reservation** — `reservations.ts`: an authorized-but-unsettled amount that counts as spent
until `recordPayment` or `recordBlocked` resolves it. Why a retry storm cannot fan out past
the velocity breaker.

**Seller** — an API that prices its routes over x402. Ours: `paymentGate`. Third-party: any
live x402 endpoint; L-01 verifies which wire version they speak.

**State directory** — `.allowance` by default (`--state`, `ALLOWANCE_STATE_DIR`). Everything
the runtime persists lives there. Safe to back up; contains no keys.

**Velocity circuit breaker** — the rolling-window rail: refuse when spend in the last
`windowSeconds` plus this payment would exceed `windowLimitUsd`. The anti-runaway-loop rule;
`retryAfterMs` says when the window clears.

**Viem** — optional peer dependency used only by `live.ts` for `privateKeyToAccount` and
EIP-712 signing. Not required for anything else; imported dynamically.

**Wallie** — the product name (onewallie.com), a 1YC product. On npm, an alias for
`allowance-kit`. **Wallie Cloud** — the paid hosted control plane (planned, RELEASE-PLAN
section 3.2). **Compliance pack** — planned enterprise offering of signed audit exports (X-02).

**Watchdog** — planned Wallie Cloud cron that raises an "agent silent" alert when an agent's
heartbeats stop for longer than the workspace's threshold, and an "agent back" alert when
they resume.

**Workspace / workspace key** — planned: the Cloud tenant created by a Stripe subscription,
and its bearer credential (`wk_live_…`, shown once, stored hashed, rotatable) that the
runtime presents on `/v1/events` and `/v1/heartbeat`.

**x402** — the HTTP-native payment protocol: a server answers `402 Payment Required` with an
`accepts[]` list of prices/networks; the client retries with a signed payment header; the
server verifies and settles through a facilitator and returns the resource plus a receipt
header. **v1** (implemented here): `X-PAYMENT` / `X-PAYMENT-RESPONSE`, `x402Version: 1`,
bare network names (`base-sepolia`). **v2** (to be verified in L-01): newer header names and
CAIP-2 network ids (`eip155:8453`); support to be added alongside v1, never instead.
