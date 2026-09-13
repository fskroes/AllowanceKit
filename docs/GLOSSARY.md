# Glossary

Terms as used in this repo, on onewallie.com, in [RELEASE-PLAN.md](RELEASE-PLAN.md) and in
[SOLANA-ARCHITECTURE.md](SOLANA-ARCHITECTURE.md).
Where a term names a file or export, it is given so an agent can grep for it. Alphabetical.
Current as of `allowance-kit@0.5.0` and `wallie-cloud@15689aa` (2026-09-08): "planned" marks
what Wallie Cloud's service side still needs (Stripe provisioning, email templates, the account
app, deployment); "built" marks cloud code that exists and is CI-tested in the private repo
`fskroes/wallie-cloud` but is not deployed; everything else describes shipped code.

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
that script in `docs/canary-runs/`. Two exist (2026-09-07): Base mainnet, and Base Sepolia
against a third-party seller (`scripts/l02-thirdparty.ts`, Mart402).

**CDP / CdpFacilitator** — Coinbase Developer Platform. `facilitator-cdp.ts` implements the
x402 facilitator contract (`verify`, `settle`) against CDP's API, authenticated with an
ES256 JWT built from `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET`. Used by sellers.

**Channel (notify)** — one destination for alerts: `webhook`, `email` (Resend or Postmark),
`sms` (Twilio), `push` (ntfy), `heartbeat` (an outside monitor URL), and `cloud` (Wallie
Cloud). Configured in `.allowance/notifications.json` by `notify <channel> …`. Config holds
addresses and provider names, never keys. The first four are **human channels**: they fire on
a threshold, a block or a queued approval, per `onBlock` / `onApproval`. The cloud channel is
different in kind — see *Cloud channel*.

**Cloud channel** — shipped in 0.5.0 (`notify cloud <key>`, `CloudConfig` in `notify.ts`):
the notify channel that posts every *decision* — a `CloudEvent` of kind `payment`, `blocked`
or `approval`, regardless of the human alert preferences — to `POST /v1/events`, and a 60 s
*cloud heartbeat* to `POST /v1/heartbeat`, using a *workspace key* read at send time from the
environment variable named in `keyEnv` (`WALLIE_CLOUD_KEY`, `CLOUD_ENV`). `notifications.json`
stores only `{enabled, url, keyEnv}`. Threshold heads-ups are not sent yet (RELEASE-PLAN C-10).
The wire contract is RELEASE-PLAN §3.1.1; the server side is built (`api/v1/{events,heartbeat,me}.ts`
in the cloud repo, proven against this client by `test/runtime-compat.test.ts`) but not deployed,
so `api.onewallie.com` still resolves to nothing.

**CloudEvent** — the shape on the wire to Wallie Cloud: `{kind, agent, network?, mode?,
subject, body, data, at}`. `subject`/`body` are the same text a webhook would get; `data`
carries the per-kind fields (`host`, `url`, `amountMicro`, `txHash`, `rule`, `detail`,
`attemptedMicro`, `requestId`) with `url` stripped of its query string by `stripQuery`.

**Control plane** — Wallie Cloud's hosted side: it receives decisions and liveness, stores
them, and alerts. It never decides, signs or pays. Contrast with the *runtime*, which does.

**Control token** — `.allowance/dashboard-token`, a random secret the local dashboard injects
into its page and requires on mutating endpoints (kill switch, approvals). Mode 0600.

**Dashboard (local)** — `allowance-kit dashboard`: `dashboard-server.ts` + `public/dashboard.html`
on `127.0.0.1:4030`. Shows allowance, ledger, approvals, kill switch, with an agent switcher;
reads and mutations are both gated by the *control token* (0.5.0). Distinct from the planned
hosted **account app** at `app.onewallie.com`.

**Dead-man's switch / heartbeat** — a periodic ping to an outside URL (`notify heartbeat`,
`startHeartbeat`) so that a monitor such as healthchecks.io alerts when pings stop. The only
way a machine can tell you it is off. Pings only while `dashboard` runs. Distinct from the
**cloud heartbeat** (`startCloudHeartbeat`), which every runtime created by `createAgent` or
`createLiveAgent` sends to Wallie Cloud on its own, headless or not, and stops via
`rt.stopHeartbeat()`; the timer is unref'd so a one-shot CLI command still exits. Wallie
Cloud's **watchdog** turns missing cloud heartbeats into an alert.

**Delivery (cloud)** — one attempt by Wallie Cloud to send one stored event to one *alert
rule*'s target (email, SMS, webhook), recorded in `deliveries` with status
(`pending|sent|failed`), attempts and last error. Built: `lib/fanout.ts` drains up to 100
pending rows per *watchdog tick*, three attempts with 500 ms·2ⁿ backoff, never on a
non-retryable status (same 408/425/429/5xx rule as the runtime). SMS deliveries are only
enqueued for `blocked`, `approval` and `silent`.

**Doctor** — `allowance-kit doctor` (0.5.0): one line per check (Node version, `viem`, the
wallet key by env-var name, RPC reachability and balance, state-dir permissions, email and
SMS provider keys), each with a fix; non-zero exit on a broken setup. Does not yet check the
cloud key (RELEASE-PLAN C-10).

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
alert rule (email, SMS, webhook), with retries and a delivery record. Built: enqueue happens
at ingest (`lib/ingest.ts`, copying channel and target from the rule), sending happens later
in `lib/fanout.ts` via `lib/senders.ts` (Resend, Twilio, plain webhook POST) — never inline in
the request path.

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

**Magic link** — planned Wallie Cloud sign-in: an emailed single-use link (15 min), no
password; produces a *session* cookie (30 days). Ticket C-07. The `magic_links` and `sessions`
tables already exist in `sql/001_init.sql`; no handler uses them yet.

**Mainnet-proven** — the 0.5.0 claim: the buyer path has settled real USDC on Base once
(`docs/canary-runs/2026-09-07-base.md`). One canary run, not sustained production traffic.

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

**PGlite** — Postgres compiled to WebAssembly (`@electric-sql/pglite`), the cloud repo's
test-only database: `configureDb` in `lib/db.ts` swaps it for the `pg` pool, so the exact
`sql/001_init.sql` and queries run in `node --test` with no live Neon and no secrets. Never used
in production.

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
CI run built the tarball. `scripts/release.sh` adds the flag only under GitHub Actions;
0.5.0 was published locally and carries no provenance badge.

**Pay (command)** — `allowance-kit pay <url> [--method] [--body]` (0.5.0): one `payingFetch`
from the shell in the directory's mode. Exit 0 paid, 2 blocked, 1 error. How a non-coder
proves a first real payment.

**Rate limit (cloud)** — built, RELEASE-PLAN D-8: `lib/ratelimit.ts` keeps one `rate_limits`
row per *workspace key* per minute in Postgres, allows 600 requests a minute on `/v1/events`
and `/v1/heartbeat`, answers `429` with a `Retry-After` of the seconds left in the window
(the 0.5.0 client ignores the header and retries on its own schedule). `GET /v1/me` is exempt.

**Reservation** — `reservations.ts`: an authorized-but-unsettled amount that counts as spent
until `recordPayment` or `recordBlocked` resolves it. Why a retry storm cannot fan out past
the velocity breaker.

**Seller** — an API that prices its routes over x402. Ours: `paymentGate` (speaks v1 only).
Third-party: any live x402 endpoint; as of 2026-09-07 every live seller found speaks v2
(`docs/x402-compat.md`), and the buyer answers whichever version the seller sent.

**Silent / back** — the two event kinds Wallie Cloud creates itself (never the runtime):
`silent` when an agent's cloud heartbeats have been missing longer than the rule's
`silent_after_seconds` (default 300), `back` when they resume. Built: `lib/watchdog.ts` sets
`agents.silent_since` and emits `silent`; `lib/heartbeat.ts` clears it and emits `back`.
Ingested events also refresh `last_seen_at`, so an agent that is paying is never "silent".
Laptop sleep is the expected false positive.

**State directory** — `.allowance` by default (`--state`, `ALLOWANCE_STATE_DIR`). Everything
the runtime persists lives there. Safe to back up; contains no keys.

**Velocity circuit breaker** — the rolling-window rail: refuse when spend in the last
`windowSeconds` plus this payment would exceed `windowLimitUsd`. The anti-runaway-loop rule;
`retryAfterMs` says when the window clears.

**Viem** — optional peer dependency used only by `live.ts` for `privateKeyToAccount` and
EIP-712 signing. Not required for anything else; imported dynamically.

**Wallie** — the product name (onewallie.com), a 1YC product. On npm, an alias for
`allowance-kit`. **Wallie Cloud** — the paid (€20/mo per workspace) hosted control plane,
RELEASE-PLAN section 3.2: the runtime half (*cloud channel*) shipped in 0.5.0; the service
half lives in the private repo `fskroes/wallie-cloud` (`~/dev/wallie-cloud`), where ingest,
fan-out and the watchdog are built and CI-tested, and Stripe provisioning, email templates,
the account app and the deploy to `api.onewallie.com` / `app.onewallie.com` are still planned
(C-02, C-06, C-07, C-08). Deploy is blocked on a Vercel Pro upgrade (per-minute cron,
commercial use).
**Compliance pack** — planned enterprise offering of signed audit exports (X-02).

**Watchdog** — the Wallie Cloud cron that raises an "agent silent" alert when an agent's
heartbeats stop for longer than the workspace's threshold, and an "agent back" alert when
they resume. Built: `api/cron/watchdog.ts` is one **watchdog tick** per minute (`vercel.json`,
`* * * * *`) that first flags silent agents (`lib/watchdog.ts`) and then drains pending
*deliveries* (`lib/fanout.ts`). Vercel only runs crons on production deployments and only on
the Pro plan at this frequency; the handler still needs a `CRON_SECRET` check (C-08).

**Workspace / workspace key** — the Cloud tenant (`workspaces` row, created by a Stripe
subscription — the minting side is planned, C-02) and its bearer credential that the runtime
presents on `/v1/events`, `/v1/heartbeat` and `/v1/me`. The 0.5.0 CLI accepts only keys
matching `wk_(live|test)_[A-Za-z0-9]{8,}`, so the cloud must mint in that alphabet. Shown once
in the welcome email, stored as a SHA-256 hash with a visible 12-character *prefix*, rotatable
(old key valid 24 h more). Lookup, hashing and the rotation grace are built (`lib/auth.ts`,
`workspace_keys`); an unknown key is `401`, a known key on a non-`active` workspace is `402`.
`wk_test_` is for staging and tests; `scripts/dev-server.ts` seeds `wk_test_devkey0123456789`.

**x402** — the HTTP-native payment protocol: a server answers `402 Payment Required` with an
`accepts[]` list of prices/networks; the client retries with a signed payment header; the
server verifies and settles through a facilitator and returns the resource plus a receipt
header. **v1** (buyer and seller here): `X-PAYMENT` / `X-PAYMENT-RESPONSE`, `x402Version: 1`,
bare network names (`base-sepolia`), `maxAmountRequired`. **v2** (buyer here since 0.5.0;
what the live ecosystem speaks): challenge in the `PAYMENT-REQUIRED` header, reply in
`PAYMENT-SIGNATURE`, receipt in `PAYMENT-RESPONSE`, `x402Version: 2`, CAIP-2 network ids
(`eip155:8453`), `amount`, and the seller's offer echoed verbatim under `accepted`. Supported
alongside v1, never instead (D-5). Exact diff: `docs/x402-compat.md` §5.

---

## Solana and payment channels

Planned terms from [SOLANA-ARCHITECTURE.md](SOLANA-ARCHITECTURE.md) (2026-09-13). Nothing in
this section is shipped. Where a term names a planned file or export, it is given so the
implementing agent and the reader use the same name. Facts about the program and the
protocol were verified on 2026-09-13; evidence in `docs/spikes/`. Alphabetical.

**`@solana/kit`** — Anza's zero-dependency Solana client library (the 2.x line of
`@solana/web3.js`; the 1.x line is maintenance only). Uses native WebCrypto Ed25519. Planned
optional peer dependency, lazy-imported from `src/solana.ts` like `viem` is from `live.ts`.
A Base agent never loads it. Version range follows what `@x402/svm` declares.

**`@solana/pay-kit`** — Solana Foundation's MPP-first server framework (`createPayKit`,
gates, pricing catalogue, *MPP session*). Spiked and **rejected** for the x402 path
(architecture §2.1): pulls `mppx` and `viem`, vendors a stale `@x402/svm`, has no hook
between verify and settle, and its channel operator code is private. The right library if
*MPP session* is ever added. Evidence: `docs/spikes/2026-09-13-spike-paykit-vs-handroll.md`.

**`@x402/svm`** — the x402 Solana mechanism package from `x402-foundation/x402`
(Apache-2.0). Ships the buyer `exact` and `upto` schemes, the seller `upto` scheme, the
in-process `upto` *facilitator*, the vendored program client, PDA derivation and the
*voucher* codec. Planned optional peer. Importing it or its `exact/client`, `upto/client`,
`upto/facilitator` subpaths loads no `zod` (verified with a resolve hook); only
`@x402/core/http` does, and allowance-kit never imports that because it encodes headers
itself.

**Authorized signer / `receiverAuthorizer`** — the key that signs the *voucher*. In x402
`upto` it is the **seller's** hot key (`extra.receiverAuthorizer` in the offer, stored as
`authorized_signer` in the *channel account*). The buyer never signs a voucher in `upto`.
Planned env var name on the seller: `SELLER_AUTHORIZER_KEY` (configured by name, never
value, in `paymentGate`'s `solanaOperator`).

**CAIP-2 (Solana)** — `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (mainnet-beta) and
`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (devnet); v1 bare names `solana` and
`solana-devnet`. Planned table `SOLANA_NETWORKS` in `src/solana.ts`; `networkInfo()` in
`live.ts` resolves them. The string `EQnzfwaE…` from an earlier session is wrong and appears
in no package.

**Ceiling** — the `amount` a seller advertises on an `upto` offer: the maximum it may
charge and the exact *deposit* the buyer escrows (`deposit == maxAmount == accepts.amount`).
The buyer's policy rails check the ceiling, not the eventual charge: per-call cap, velocity,
budget, balance and approval all evaluate the ceiling (architecture §5). `PaidResult.quotedMicro`
carries it; `costMicro` carries the actual charge.

**Channel account** — the 256-byte on-chain state of one *payment channel*, a PDA of the
program with seeds `["channel", payer, payee, mint, authorized_signer, salt, open_slot]`.
Fields the runtime reads: `status` (offset 3), `deposit` (12), `settled` (20),
`grace_period` (52), `payer` (88), `payee` (120), `authorized_signer` (152), `mint` (184),
`open_slot` (248). Status values `OPEN 0`, `SEALED 1`, `CLOSING 2`, `DISTRIBUTED 3`.
Planned decoder: `reconcileChannels` in `src/channels.ts`.

**Channel id** — the base58 address of the *channel account*. Carried as `channelId` in the
`upto` payload, in `ChannelRecord`, on `PaidResult` and in every `channel` *CloudEvent*.

**Channel record / `ChannelStore`** — planned `src/channels.ts`: the buyer's local row per
channel in `.allowance/channels.json`, written under the state-dir lock **before** the
`open` transaction is sent. Fields: `id`, `agent`, `host`, `url`, `network`, `depositMicro`,
`settledMicro`, `refundMicro`, `withdrawDelay`, `openedAt`, `status`, `txHash`. Statuses:
`opened` (deposit in escrow), `settled` (seller charged `settledMicro`, refund returned),
`refunded` (seller charged 0), `unknown` (send failed after the header left; needs
*reconcile*), `orphaned` (PDA is OPEN on-chain and the seller went silent), `reclaimed`
(payer escape path completed). CLI: `channels list|reconcile|reclaim|sweep`.

**Channel (payment)** — see *Payment channel*. Not to be confused with a notify *Channel*
(webhook, email, sms, push, heartbeat, cloud) defined above.

**`channel` (CloudEvent kind)** — planned fifth `CloudEventKind`. `data.phase` is one of
`opened`, `settled`, `refunded`, `orphaned`, `reclaimed`; `data` also carries `channelId`,
`host`, `network`, `depositMicro`, `settledMicro`, `refundMicro`, `withdrawDelay`, `txHash`.
Feeds the *escrow watchdog*. The cloud adds it to `INGEST_KINDS`.

**Cold wallet / `payTo`** — the seller address that finally receives USDC. On an `upto`
offer it is the single 100 % recipient in the channel's distribution; it never signs.
Distinct from the two seller hot keys (*fee payer*, *authorized signer*).

**Deposit** — the USDC the buyer moves into the channel escrow at `open`. In `upto` it
equals the *ceiling*. It is *escrowed* money, neither spent nor available, until the seller
settles.

**`distribute`** — program instruction 7. After `settleAndSeal`, pays the settled amount to
the recipients, returns `deposit − settled` to the payer, closes the escrow token account and
returns rent to the *rent payer*. Permissionless. Needs the treasury ATA for the mint to
exist, or it fails (`doctor --seller` checks this).

**Escape path (payer)** — what the buyer does when a seller took the deposit and never
settled: `requestClose` (payer signs) → wait the *grace period* → `seal` (anyone) →
`withdrawPayer` (payer signs, gets `deposit − settled` back). Planned as
`reclaimChannel` / `channels reclaim <id>`. Needs ~0.01 SOL in the agent wallet for fees
(architecture §2.5); `doctor` warns when it is missing.

**Escrow / escrowed** — the third money state next to *spent* and *reserved*: USDC sitting
in an open channel. Planned formula `spendable = min(totalBudgetUsd, funded) − spent −
reserved − escrowed`. Shown as its own number "in escrow" on the dashboard, in `status`, in
the cloud heartbeat (`escrowedMicro`) and in the Cloud overview. Never folded into "spent".

**Escrow watchdog** — planned Wallie Cloud rule: alert when a `channel/opened` event has no
matching `settled` or `refunded` within N minutes (default 10), and on every
`channel/orphaned`. Runtime side: `channels reconcile` runs from the dashboard tick and from
the cloud heartbeat loop while any channel is `opened` or `unknown`.

**`exact` (Solana)** — the x402 scheme allowance-kit already speaks on Base, on Solana:
the payload is `{ transaction: base64 }`, a v0 transaction (compute budget, `TransferChecked`
to the seller's USDC ATA, memo) signed by the payer with `extra.feePayer` left unsigned; the
facilitator co-signs and pays SOL. The buyer needs USDC and no SOL. Supported by CDP
(mainnet and devnet, API key) and by x402.org's free devnet facilitator. Planned encoder
`encodePaymentSolanaExact` in `src/solana.ts` (ticket SOL-01).

**Facilitator (Solana)** — for `exact`: CDP (`api.cdp.coinbase.com/platform/v2/x402`,
Solana mainnet + devnet), x402.org (devnet, free), PayAI (mainnet + devnet). For `upto`:
**none hosted** as of 2026-09-13 (all three answer `exact` only for Solana on `/supported`),
so Wallie's seller *self-facilitates*.

**Fee payer / `feePayer`** — the seller-side hot key on an `upto` offer (`extra.feePayer`).
Co-signs and broadcasts the buyer's `open` transaction, pays SOL fees and rent (it is the
channel's `payee` and *rent payer*), later signs `settleAndSeal`. Holds SOL. Planned env var
name `SELLER_FEE_PAYER_KEY`. On `exact` the facilitator's own key plays this role.

**Grace period / `withdrawDelay`** — seconds, set at `open` (`grace_period` in the
*channel account*, `extra.withdrawDelay` on the offer, must be > 0, no on-chain upper bound).
After the payer calls `requestClose`, only the payee may settle during the grace period;
after it, anyone may `seal`. Bounds how long a silent seller can hold the *deposit*. Default
proposal 900 s for demo sellers; the buyer's *orphan* clock uses the value from the offer.

**Key format (Solana)** — `AGENT_PRIVATE_KEY` on a Solana network is the 64-byte secret as
base58 (Phantom export) or a JSON array of 64 bytes (`solana-keygen`). Same env var as EVM;
`normalizePk` in `live.ts` branches by network family; `doctor` names the expected format.
Vouchers and messages are signed with `node:crypto` Ed25519 from the 32-byte seed; the
transaction signer is a plain `TransactionPartialSigner` object built from it
(`solanaSigner` in `src/solana.ts`).

**Meter** — planned object passed as the third argument to a `paymentGate` handler on an
`upto` request. `meter.charge(microUsd)` sets the actual charge, capped at the *ceiling*. If
the handler throws or never calls it, the gate refunds (`amount: "0"`). The gate never
charges for work it did not deliver.

**MPP session** — Machine Payments Protocol (Stripe + Tempo; `mpp.dev`, specs at
`paymentauth.org`), a **separate protocol from x402** using `WWW-Authenticate: Payment` /
`Authorization: Payment` / `Payment-Receipt`. Its Solana `session` method
(`draft-solana-session-00`, 2026-09-09) uses the same program but one channel across many
requests, client- or operator-signed cumulative vouchers, idle-timeout close and
`distributionSplits`. **Out of scope by decision** (architecture §2.2); `ChannelStore`
records `settled` as a cumulative watermark so a session later adds rows, not tables.

**`open`** — program instruction 1. Creates the *channel account* and moves the *deposit*
into escrow. Signed by the payer (buyer) and the *rent payer* (seller-side *fee payer*).
Must land within `OPEN_SLOT_WINDOW` (1500 slots, ~10 min) of the `openSlot` in the payload.
The buyer builds and partially signs it; the seller co-signs and broadcasts it in
*settleDeposit*.

**Orphan / orphaned** — a channel whose PDA is still OPEN on-chain while the seller's
settle never arrived (timeout or 5xx after the `open` was broadcast). Detected by
*reconcile*; starts the *grace period* clock; emits `channel/orphaned`; resolved by the
*escape path*. Escrowed funds are the new failure mode this state names.

**Payment channel** — the Solana Payment Channels program, id
`CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX`, repo `solana-foundation/payment-channels`
(MIT, Cantina audit 2026-07-27), deployed on mainnet-beta, devnet and the *sandbox*. A payer
escrows a USDC *deposit*; the *authorized signer* issues *vouchers*; the payee settles the
highest voucher and the rest is refunded. Nine instructions: `open`, `settle`, `topUp`,
`settleAndSeal`, `requestClose`, `seal`, `distribute`, `withdrawPayer`, `reclaim`. There is
no instruction called `voucher` or `refund`. Upgrade authority is one bare key per cluster (trust
assumption, documented, not ours to change).

**Reconcile** — `channels reconcile` / `reconcileChannels(rpc)`: read each non-terminal
channel's PDA over JSON-RPC `getAccountInfo` and set the local status from the chain:
absent → drop; SEALED or DISTRIBUTED → `settled`/`refunded` with `settledMicro` from offset
20; OPEN past its clock → `orphaned`.

**Refund** — in `upto`, the seller settling with `amount: "0"`, or the difference
`ceiling − actual` returned by `distribute` after a normal settle. Recorded on the buyer as
`refundMicro` on the `payment` ledger row and the *channel record*; returns to *available*
the moment the receipt is parsed. Not a separate ledger kind.

**Rent payer** — the account that funds the channel PDA and escrow token account rent at
`open` and gets it back at `distribute`/`reclaim`. In x402 `upto` this is the seller-side
*fee payer*. The program supports self-paid rent by the payer, but no SDK wires it.

**Sandbox / `402.surfnet.dev`** — a hosted Surfpool fork of mainnet (RPC
`https://402.surfnet.dev:8899`, genesis = mainnet, so the mainnet CAIP-2 id) with the
program and mainnet USDC. Free faucet: `requestAirdrop` and
`surfnet_setTokenAccount [owner, mint, {amount}]`, no auth. Reset cadence undocumented, so
tests create fresh accounts every run. Local equivalent `@solana/surfpool`. Test gate
`SOLANA_SANDBOX=1` (hosted) or `SOLANA_SANDBOX=local`.

**Scheme preference / `preferScheme`** — planned `LiveAgentOptions` field, `"exact" |
"upto"`. Default: when a seller offers both, take `exact` if its amount fits
`perCallMaxUsd`, else `upto` if its *ceiling* fits policy. Reason: `exact` has no escrow
window.

**Self-facilitation** — the seller running the `upto` facilitator role in-process with its
own *fee payer* and *authorized signer* keys, because no hosted facilitator speaks Solana
`upto`. Planned `src/seller-upto.ts` wrapping `@x402/svm/upto/facilitator`. When a hosted
one appears, `paymentGate` gains `facilitatorUrl` and this becomes the fallback.

**`settleAndSeal`** — program instruction 4. Signed by the payee (*fee payer* key). With a
*voucher* (Ed25519 precompile instruction placed directly before it), raises `settled` to
the voucher's cumulative amount and seals the channel. With `has_voucher = 0`, seals at the
current watermark, which for a fresh channel is a full refund. Followed by `distribute`.

**settleDeposit / settleClaim** — the two facilitator calls in an `upto` request. Deposit:
verify the `open` transaction's shape and signers, simulate, co-sign as *fee payer*,
broadcast, confirm (before the handler runs). Claim: verify the *voucher*, send the Ed25519
precompile + `settleAndSeal`, then `distribute` (after the handler). The `PAYMENT-SIGNATURE`
payload's `type` field is `"deposit"` from the buyer and `"claim"` when the server settles.

**`SOLANA_NETWORKS`** — planned table in `src/solana.ts`: per network the CAIP-2 id, v1
name, USDC mint (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` mainnet,
`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` devnet), default RPC and token program.
The EVM `NETWORKS` table in `live.ts` is untouched.

**Sweep** — `channels sweep` on the seller: retry `distribute` for sealed channels whose
rent return failed, from a persisted retry list (wraps the library's rent cleanup manager).

**`upto`** — the x402 scheme for a metered call with a ceiling: one HTTP request, one
*payment channel*. The buyer escrows the *ceiling* as *deposit* by signing an `open`
transaction; the seller serves, meters, signs one *voucher* for the actual amount, settles
and seals; the difference is refunded in the same step. Spec
`specs/schemes/upto/scheme_upto_svm.md` in `x402-foundation/x402`. Offer `extra` fields:
`paymentFlow: "escrow"`, `feePayer`, `receiverAuthorizer`, `withdrawDelay`, `tokenProgram`,
`recentBlockhash`, `recentSlot`. Payload: `from, maxAmount, deposit, channelId, expiresAt,
validAfter, nonce, openSlot, authorizedSigner, openTransaction, type`. Receipt
`PAYMENT-RESPONSE { success, payer, transaction, network, amount }` where `amount` is the
actual charge. Planned buyer encoder `encodePaymentSolanaUpto` (SOL-05), seller
`src/seller-upto.ts` (SOL-04).

**Voucher** — 50 signed bytes: magic `[0x56, 0x01]` (2) || *channel id* (32) ||
cumulative amount u64 LE (8) || `expires_at` i64 LE (8, `0` = none). **Cumulative, not a
delta.** No nonce; replay is prevented by the strict `settled < cumulative <= deposit`
watermark and by `open_slot` being a PDA seed. Ed25519 by the *authorized signer*, verified
on-chain via the Ed25519 precompile instruction. Planned zero-dep codec `src/voucher.ts`
(`encodeVoucher`, `decodeVoucher`, `signVoucher`, `verifyVoucher`) using `node:crypto`.

**`wallie-mcp`** — planned package `packages/wallie-mcp`: an MCP (Model Context Protocol)
stdio server that exposes the runtime as tools `pay_fetch`, `get_budget`, `list_channels`,
`approve`/`deny`, `reclaim_channel`. Depends on `allowance-kit` and
`@modelcontextprotocol/sdk`; the zero-dep rule applies to `allowance-kit`, not to this
adapter. With `demo/mcp-agent/`, the thing judges run.
