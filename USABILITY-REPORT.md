# AllowanceKit — usability & correctness report

Date: 2026-08-26 · Method: 4 independent test agents (cold npm install, SDK integration,
non-technical persona, UX audit) + direct verification by the orchestrator.
Every finding below was reproduced with real output. Findings marked **[verified]** were
re-confirmed independently by the orchestrator, not just reported by an agent.

Scratch dirs with repro scripts: `/tmp/ak-cold`, `/tmp/ak-sdk`, `/tmp/ak-maya`, `/tmp/ak-ux`, `/tmp/ak-me`.

---

## Status — resolved 2026-08-26

All code-side findings are fixed, verified, and covered by tests (`npm test`: 19/19).
Version bumped to **0.2.0**; see the "Changes in 0.2.0" section of the README for the
breaking changes.

**Fixed in this repo**

| # | Finding | Verification |
|---|---|---|
| 0.2 | `totalBudgetUsd` unenforced | budget $1 / funded $10 now stops at exactly $1.00 · test: *totalBudgetUsd is enforced…* |
| 0.3 | Rails leak under `Promise.all` | 40 parallel calls vs a $1.00/60s limit settle exactly $1.00 (was $1.15) · new `lock.ts` + `reservations.ts` · test: *parallel calls cannot fan out…* |
| 0.4 | Policy typos silently accepted | `policy perCallMax 0.05` → error + exit 1, suggests `perCallMaxUsd` · test: *unknown, mistyped and negative…* |
| 0.5 | XSS via `innerHTML` | dashboard builds every node with `textContent`; `grep -c innerHTML` → 0 |
| 1.2 | `npm run demo` needed `tsc` | script is now `node demo/demo.ts`, no build step |
| 1.3 | Broken paths + dead `next:` hint | `path.join` in `cli.ts` and `wallet.ts`; hint is `npx allowance-kit topup 5.00` |
| 1.4 | Three names, one bin | package now registers both `allowance` and `allowance-kit` |
| 1.5 | Demo and dashboard read different dirs | demo ends with `dashboard --state .allowance-demo`; verified showing $2.557 / 165 events |
| 1.6 | `EADDRINUSE` stack trace | `port 4098 is already in use … Try: --port 4099`, exit 1 |
| 1.7 | No `--help`, typos exit 0 | full help with examples; unknown command exits 1; `--version` added |
| 1.8 | Node version stated 3 ways | README states ≥20.11 for the package, ≥24 for repo sources, in one place |
| 2.1 | Allowance bar measured spend | bar is `remaining/budget`, guarded against a zero denominator |
| 2.2 | Pending approval invisible | "Waiting on you" card + `(1)` in the tab title |
| 2.3 | Approving didn't say it doesn't pay | CLI and dashboard both say "nothing has moved yet" |
| 2.4 | Keyboard/mobile/a11y | focus preserved during refresh, `:focus-visible`, `@media`, `<main>`/`<ul>`/`<dl>`, `aria-live` |
| 2.5 | Dashboard lied when disconnected | stale banner + dimmed figures; all non-2xx surfaced in-page |
| 2.6 | Kill switch affordance | red at rest, `aria-pressed`, confirm before resuming spending |
| 2.7 | Empty states, silent truncation, 404s | ledger empty state; "showing 60 of N"; 404/405 on `/api/*` |
| 3.1 | No public way to fund | `topUp(rt, usd)` exported; does both halves · test: *funding without a ledger entry…* |
| 3.2 | Seller rejection was silent | sets `error`, `blockedBy.settlement_rejected`, logs a ledger row, releases the hold · test |
| 3.3 | `blockedBy` too thin | `PolicyRule` union + `recoverable`, `quotedMicro`, `capMicro`, `retryAfterMs`, `ctx.policy()` · test |
| 3.4 | `per_call_cap` shadows approval gate | kept as a hard cap (see note below) and now warns at config time · test |
| 3.5 | Array policy fields needed JSON | `policy allowHostSuffixes a.com,b.com` works; JSON still accepted |
| 3.6 | README snippet failed as written | quickstart uses the default agent name and includes the allowlist step; run verbatim from a packed install |
| 3.7 | Minors | `$0.00` approval guard, `["*"]` warning, no `allowed:false` leak, ledger parse-cache + single-pass totals, `demo-servers` exported, top-up ceiling |
| P4 | Jargon, raw JSONL audit, scope honesty | plain-English `RULE_LABELS` everywhere; `audit` is a table (`--json` for raw); "Practice money" replaces "SIMULATED FUNDS"; README opens with what it does and does not cap |

Also fixed, found during the work: an unreachable seller threw an uncaught `TypeError: fetch failed`
instead of returning a result. `payingFetch` now returns `{ ok: false, status: 0, error }`.

**One finding resolved differently than proposed.** 3.4 suggested letting `human_approval_required`
outrank `per_call_cap`. That would make the per-call cap overridable, which removes the strongest
guarantee in the product. Instead the ordering stands and `policy`/`status` warn when
`requireApprovalAboveUsd >= perCallMaxUsd` makes the approval gate unreachable.

**Still outstanding — not code in this repo**

1. **Claim `wallie` on npm** (0.1). Needs your npm account; a publish is yours to make, not mine.
2. **onewallie.com** (1.1, 1.8, C6): change `npx wallie` → `npx allowance-kit`, drop the
   "no install" claim, reconcile €20 vs $20, add a dashboard screenshot.
3. **Notifications** (P4.2): email/SMS/webhook on 50/80/100%, on every block, on every queued
   approval. Still the biggest gap for a non-developer, and README's "Honest limitations" now says so.
4. **Publishing 0.2.0** to npm — your call.

**The strategic finding stands.** P4 is not a bug list. For someone whose problem is a metered API
invoice on a card, this still caps nothing they are billed for. The README now says that in the
second paragraph instead of implying otherwise.

---

## Headline

The rails work. All six fire on real traffic, the approval queue is real, the kill switch is
instant, a runaway loop got stopped at call #201, and the demo is genuinely impressive.
Zero agents were blocked from reaching a working state.

Three things undercut that:

1. **The knob named after the promise doesn't work.** `totalBudgetUsd` is never read by
   `evaluatePolicy`. The real cap is the top-up amount.
2. **The rails leak under `Promise.all`** — the single most common agent pattern.
3. **Every free front door is broken**: the landing page's first command 404s, the repo demo
   dies on a missing build step, and the CLI's own "next:" hint is not a runnable command.

And one strategic finding: for the non-technical persona the product was built for, it caps
nothing she is actually billed for.

---

## P0 — Security & safety

### 0.1 `npx wallie` is an unclaimed npm package and your site tells visitors to run it **[verified]**

```
$ curl -s https://onewallie.com | grep npx
npx wallie init
npx wallie topup
npx wallie policy

$ npm view wallie version
npm error 404 Not Found - GET https://registry.npmjs.org/wallie
```

Anyone can publish `wallie` to npm and every visitor who follows step 1 of your landing page
executes their code. **Claim the name today**, even as an empty stub that prints
"use `npx allowance-kit`".

### 0.2 `totalBudgetUsd` is dead config — enforces nothing **[verified]**

`grep -rn totalBudgetUsd src` → only `defaultPolicy` and three *display* sites
(`cli.ts:41`, `dashboard-server.ts:35`, `dashboard.html:118`). The real check in
`src/policy.ts` is `ctx.topupsMicro - ctx.spendTotalMicro < ctx.amountMicro`.

```
policy totalBudgetUsd = 1  remaining = 5000000n
[research-agent] paid 10 calls, spent 2000000n micro, totalBudgetUsd was 1.00
```

Agent 1 reproduced it at scale: `totalBudgetUsd: 1`, topped up $10, **spent $5.00 across 500
calls, zero blocks**. `status` prints the contradiction to your face:
`remaining $999999983.000000 of $1.00`.

README claims `budget_exhausted | hard total allowance | ✅`. A spend-control library must not
ship an unenforced field named "budget".

**Fix:** enforce `min(topups, totalBudgetUsd) − spend`, or rename the field `fundedUsd`/`displayBudgetUsd`.

### 0.3 Rails leak under concurrency (TOCTOU) **[verified]**

`authorize()` reads spend from the JSONL ledger; `recordPayment()` only appends *after* the
HTTP round-trip. Parallel calls all authorize against stale state.

```
limit $1.00/60s at $0.05/call => max 20 calls. PARALLEL paid=23, spent=$1.15
```

Agent 2 got $1.35 against the same $1.00 limit with `Promise.all` over 20 items; sequentially
the identical policy holds exactly at $1.000000. Every ledger-derived rail (velocity, budget)
is bypassable by fan-out. The only backstop is the chain balance.

This matters because the velocity breaker is sold specifically as the anti-retry-loop
protection, and retry storms are parallel by nature.

**Fix:** reserve-then-commit — `authorize()` appends a `reserved` event under an on-disk lock,
`recordPayment` settles/releases it. Minimum: document that `PayContext` is not
concurrency-safe and ship a serialising wrapper.

### 0.4 Policy typos are silently accepted, exit 0 **[verified]**

```
$ allowance policy perCallMax 0.05
{ ... "perCallMaxUsd": 0.5, ... "perCallMax": 0.05 }
$ allowance status
per-call cap $0.50 · approval ≥ $0.30
```

The user tightened a cap, got positive confirmation, and nothing changed. Also accepted:
`perCallMaxUSD` (capital D), `nonexistentKey 42`, and `totalBudgetUsd -5`.

**Fix:** validate against the `PolicyConfig` keyset in `PolicyStore.save` *and* `cli.ts`; suggest
the near-miss; reject negatives; exit 1.

### 0.5 XSS into the page holding your kill switch

`public/dashboard.html:121,133,144-148` interpolate seller-controlled `host`, `rule`, `detail`
straight into `innerHTML`, plus inline `onclick="decide('${a.id}', true)"`.

**Fix:** build nodes with `textContent`; delegated listener reading `data-id`.

---

## P1 — Every free front door is broken

### 1.1 Landing page step 1 → npm 404 (see 0.1)

### 1.2 `npm run demo` dies on a build step the docs say doesn't exist

```
$ npm run demo
sh: tsc: command not found
```

Site + docs promise *"no install, no keys, no chain"* and *"plain TypeScript that Node runs
directly — no build step, no install."* Fixable with `npm install`, which is mentioned nowhere
and explicitly contradicted.

### 1.3 The CLI's own "next:" hint is not a runnable command

```
provisioned agent wallet 0x9c1bd...
policy file /private/tmp/ak-maya/.allowanceconfig.json
next: allowance topup 5.00

$ allowance topup 5.00
zsh: command not found: allowance
```

Two bugs in three lines (`src/cli.ts:20-21`):
- missing path separator — `.allowanceconfig.json` doesn't exist; real file is `.allowance/config.json`.
  Same bug in the *recovery* message at `src/wallet.ts:32` (`restore …/.allowanceaccounts.json`).
- `next:` should be `npx allowance-kit topup 5.00`.

### 1.4 Three names, three first commands

Site sells **Wallie**, npm ships **allowance-kit**, bin is **allowance**.
`./node_modules/.bin/allowance-kit` does not exist; `npx allowance-kit` works only because npx
falls back to the sole bin. README says `npx allowance-kit init` (line 8) *and* `node src/cli.ts init`
(line 53); docs.html says `git clone … && npm run demo`.

### 1.5 The demo and the dashboard read different directories

Demo's closing line: `run \`npm run dashboard\` … → http://localhost:4030`.
Demo writes 165 events to `.allowance-demo/ledger.jsonl`; dashboard reads `.allowance/`.

Result: the user watches $2.44 of spending, opens the dashboard, sees **$0.00 / 0 payments /
empty ledger**. Highest trust-lost-per-line-of-code in the repo.

### 1.6 `allowance dashboard` on a busy port dumps a 12-line stack trace

```
node:events:487
      throw er; // Unhandled 'error' event
Error: listen EADDRINUSE: address already in use 127.0.0.1:4030
```

`startDashboard` (`dashboard-server.ts:94`) attaches no `error` handler. This is the most likely
first-run failure (running the command twice).

### 1.7 No real `--help`, unknown commands exit 0 **[verified]**

`--help`, `-h`, `help`, `--version`, and typos like `stats` all print the same 138-char grammar
string and **exit 0** — so a typo in a script passes CI. `policy [k v]` never says which keys.
There is no `--version`.

### 1.8 Node version stated three incompatible ways

`package.json` `>=20.11`; `README.md:24` "Node ≥ 20.11"; `README.md:181` "Node ≥ 24";
docs.html "Node ≥ 24". Also €20/mo (site Stripe button) vs $20/mo (pricing card, README:170).

---

## P2 — Dashboard

### 2.1 The "Allowance remaining" bar measures spend, so it runs backwards **[verified]**

`public/dashboard.html:107`
```js
const pct = Math.max(0, Math.min(100, (Number(s.spendTotalMicro) / Number(s.topupsMicro || 1n.toString())) * 100));
```
$4.59 of $5.00 remaining → bar renders **8.1% full, green**.
Worse: on a fresh install `topupsMicro` is the *string* `"0"` — truthy — so the guard never
fires, `0/0 = NaN`, `width:"NaN%"` is invalid CSS and silently ignored, leaving the inline
`style="width:100%"` from line 54. **Fresh install shows a full green bar next to $0.00 remaining.**

**Fix:** `Number(s.topupsMicro) > 0 ? remaining/topups*100 : 0`, and invert the colour test to `pct < 20 → amber`.

### 2.2 A pending approval produces zero signal above the fold

`dashboard.html:62` — the approval queue heading is 11px, `var(--dim)`, in the 340px sidebar,
below four equal-weight 24px numbers, two of which (`Per-call cap`, `Velocity breaker`) are
static config that never changes. Nothing in the header, cards, or `document.title` changes.

**Fix:** replace the static `Per-call cap` card with `Waiting on you — 1 payment · $0.45` in amber,
and set `document.title = "(1) AllowanceKit"`.

### 2.3 Approving doesn't pay, and nothing says so

Verified: `remaining $4.595000` before approve **and after**. The row just vanishes. Ledger
records `approval_decided` and no payment — the agent must retry on its own and may never.
The human believes they authorised $0.45.

**Fix:** `Approved — the agent will complete this $0.45 payment on its next attempt. Nothing has moved yet.`
Same line in the CLI (`cli.ts:81`).

### 2.4 Keyboard operation of the money controls is broken

`setInterval(refresh, 1200)` (`:164`) rewrites `$("approvals").innerHTML` wholesale (`:127`),
destroying focus on `Approve` every 1.2s. `grep -c ":focus"` → **0**. `grep -c "aria-"` → **0**.
`grep -c "@media"` → **0** (at 375px the `.cols` grid demands 352px against 319px available —
the kill switch is off-screen on a phone). No `<main>`, `<ul>`, `<table>`; the audit trail is 60
sibling divs.

### 2.5 The dashboard lies when disconnected

`:103` `const s = await (await fetch("/api/state")).json();` — no try/catch. Kill the server and
the page shows `$4.59 remaining · KILL SWITCH: OFF` forever. Also, only 401 is surfaced to the
user (`:98`); a 400 (`"unknown or already-decided approval request id"`) is swallowed silently.

### 2.6 Kill switch has almost no affordance

`.kill` border `#1e2833` on panel `#121820` = **1.19:1** (WCAG 1.4.11 needs 3:1). No `aria-pressed`.
The *dangerous* direction — ON→OFF, resuming autonomous spending — fires on one unconfirmed click.
Text contrast elsewhere is fine (all AA).

### 2.7 Minor

- Ledger panel has no empty state → first-time user sees a 420px blank rectangle.
- `.slice(0, 60)` silently truncates the "EU AI Act audit trail" with no "showing 60 of 143".
- `dashboard-server.ts:85` returns 200 + HTML for every unmatched URL, including `/api/` typos.
- `/api/state` is not token-gated (mutations are). Localhost-bound, so low severity.
- `mock-ledger (simulated funds)` — the single most important disclosure — is the dimmest text on the page.

---

## P3 — Agent/developer DX

### 3.1 No public way to fund an agent

`createAgent` gives a wallet with no way to put money in it. `rt.topUp` doesn't exist; the tester
had to read `src/cli.ts` and replicate two coupled operations by hand. Doing only the intuitive
half (`chain.faucet`) bricks the agent silently:

```
chain.faucet($5) WITHOUT the hand-written topup ledger event:
  chain balance = $5.000000  but result = budget_exhausted / "remaining allowance below price"
```

**Fix:** export `topUp(rt, usd)` from `index.ts`; make `budget_exhausted` say
`remaining $0.00 (topups $0.00, chain balance $5.00 — did you record a topup event?)`.

### 3.2 Seller rejection = silent failure with no audit trail

```
r.ok = false · r.blockedBy = undefined · r.error = undefined
ledger blocked events: 0 · ledger payment events: 0
```

The reason exists in the untyped `body` (`"payment rejected: unknown payer account"`).
`PaidResult.error` is declared and never set. This also punctures the EU AI Act Art. 26 §5 claim —
a failed payment leaves zero trace in the "append-only audit ledger".

**Fix:** in `payer.ts`, on non-2xx post-payment response set `error` and call
`ctx.recordBlocked(url, host, "settlement_rejected", body.error, amountMicro)`.

### 3.3 `blockedBy` is too thin for self-correction

The self-correction loop *does* work (downgrade → escalate → back off → abort, all four demonstrated).
Three gaps make it harder than it should be:

- `rule` is `string`, not a union — `case "per_call_capp":` compiles with no error.
- No `quotedMicro`. The price is captured one layer down as `attemptedMicro` in the ledger and
  thrown away on the way out, so "retry cheaper" is blind guesswork.
- No `retryAfterMs` on `velocity_circuit_breaker` — the tester had to reach for
  `rt.policy().windowSeconds`, meaning `PayContext` alone is not enough to self-correct.

**Fix:** export `PolicyRule` as a union; add `quotedMicro`, `retryAfterMs`, `recoverable` to
`blockedBy`; expose `ctx.policy()`.

### 3.4 `per_call_cap` silently shadows the approval gate

`evaluatePolicy` checks `per_call_cap` before `wallet.ts:authorize` checks approval. The approval
gate can only fire in the band `[requireApprovalAboveUsd, perCallMaxUsd]`. So "cap at $0.10, ask me
about anything bigger" is **unsatisfiable** — anything over $0.10 is hard-blocked and never reaches
a human. The defaults (0.5 / 0.3) happen to leave a valid band, so it looks fine until you tighten.

Same class: default `windowLimitUsd: 2` preempts a $2 total budget and reports the wrong rule.

**Fix:** warn/throw in `PolicyStore.save` when `requireApprovalAboveUsd >= perCallMaxUsd` or
`windowLimitUsd >= totalBudgetUsd`. Consider letting `human_approval_required` outrank `per_call_cap` —
that's the point of an escalation gate.

### 3.5 Array policy fields need JSON and the failure is a raw stack trace

```
$ allowance policy allowHostSuffixes api.example.com
SyntaxError: Unexpected token 'a', "api.example.com" is not valid JSON
```

Uncaught `JSON.parse` leaking out, on the one step every real user must perform to point the agent
at a real API. Documented nowhere.

### 3.6 The README's SDK snippet fails as written **[verified]**

Two separate reasons:

```
[README name 'my-agent'] blockedBy={ rule: 'budget_exhausted', detail: 'remaining allowance below price' }
[README host api.example.com] blockedBy={ rule: 'host_not_allowlisted', detail: '"api.example.com" not in allowHostSuffixes [localhost]' }
```

- The CLI hardcodes agent name `research-agent`; the README's SDK snippet says `"my-agent"`.
  Budget is per-agent-name (`ledger.topups(agent)`), so an SDK agent named anything else sees $0.
- Default-deny on hosts is correct behaviour, but the quickstart never mentions the allowlist step.

### 3.7 Minor

- `requireApprovalAboveUsd: 0` makes the *pre-flight* `authorize(0n, …)` queue a `$0.00` approval
  request (`0n >= usd(0)`). Guard with `amountMicro > 0n`.
- `allowHostSuffixes: ["*"]` silently disables the allowlist entirely — undocumented escape hatch.
- `blockedBy` leaks `allowed: false` at runtime; the type doesn't declare it.
- **Scaling:** `Ledger.read()` re-parses the whole JSONL; `authorize()` calls it 3× and `payingFetch`
  calls `authorize` twice → **6 full ledger parses + 2 config reads per paid call.** Fine at 155
  events, quadratic at 100k.
- `dist/demo-servers.js` ships in the tarball but isn't in the `exports` map →
  `ERR_PACKAGE_PATH_NOT_EXPORTED`. The README's headline demo is unreachable from npm.
- `topup 1e9` accepted → `topped up $1000000000.000000`. No sanity ceiling.
- `topup`/`status` before `init` silently auto-provision a wallet with no notice — surprising for a
  tool whose selling point is stable wallet identity.
- Test gaps: nothing covers `totalBudgetUsd`, concurrency, or the seller-rejection result shape —
  exactly the three places real bugs were found. (`npm test` 9/9 pass; `npm run demo` passes and
  matches the README; `.allowance-demo` isolation claim verified true.)

---

## P4 — Does it solve the human's problem?

**No — and this is the finding worth the most.**

The persona's scary overnight bill was an API/cloud invoice on a credit card. AllowanceKit caps
spending only when (a) money moves as x402 micropayments, (b) every agent is rewritten to call
`payingFetch(ctx, url)` instead of `fetch(url)`, and (c) the endpoint is x402-priced. Her existing
agents' bill is capped by exactly $0.00 of this.

> "I don't want to control 'x402 payments'. I want the number on my card to stop at five dollars."

She would install it, feel safe, and get the identical bill next month. That is worse than not
installing it.

Supporting observations:

1. **"SIMULATED FUNDS (built-in mock ledger — no real money moves)"** — developers read *safe
   sandbox*; a non-developer reads *this is a toy*. It appears three times, in caps, in nested
   parens, on the same line as the number she cares about. The honesty instinct is right, the word
   is wrong: **"Practice mode — no real money"** costs nothing and reads as a feature.
2. **No notifications.** The entire trauma is *"it ran overnight"*. A dashboard she must have open
   on her laptop is structurally incapable of helping her overnight. This is also the most obvious
   thing to charge for.
3. **She can never see one cent move on the copy-paste path.** No demo ships in the npm package,
   and there's no `try` command — so she cannot verify the one thing she came for.
4. **`audit` emits raw JSONL** (`amountMicro`, `balanceAfterMicro`) — the "see where the money went"
   feature is machine-only.
5. **Jargon leaks everywhere.** Worst offenders: `KILL SWITCH: OFF` (reads as *the safety is off* —
   backwards and alarming), `velocity_circuit_breaker`, `host_not_allowlisted` (a JSON config key,
   verbatim, in the audit trail), `POLICY totalBudgetUsd → "-5"`, `request f2f16328` as the primary
   handle for a money decision, and — inside the dashboard — ``approve with `allowance approve
   f2f16328` or on the dashboard``.
6. **README stops being for users at line 26.** ~60% is market-sizing, architecture tree, and
   business model. No "is this for you?", no troubleshooting. Neither the README nor the site shows
   a single screenshot of the dashboard — the actual differentiator.
7. The best sentence in the entire product — *"The difference between an alert and a guardrail"* —
   is buried in the site's FAQ.

**What she'd actually buy:** a virtual card with a hard limit plus spend alerts (Privacy.com / Ramp
shaped). x402 is an implementation detail she must never see.

**The honest one-liner to add near the top:** *"This caps payments your agent makes through
AllowanceKit to x402-priced APIs. It cannot cap your existing OpenAI, Anthropic, or cloud bill."*
You lose some signups and stop burning the ones who'd have felt lied to.

---

## Suggested fix order

**Today (safety):**
1. Claim `wallie` on npm (0.1) — 5 min
2. Enforce or rename `totalBudgetUsd` (0.2) — 30 min
3. Validate policy keys, exit 1 on unknown (0.4) — 45 min
4. Fix `${stateDir}config.json` in `cli.ts:20` + `wallet.ts:32` (1.3) — 5 min

**This week (first run):**
5. One name across site/npm/bin; fix site commands; fix `next:` hint (1.1, 1.3, 1.4) — 2 h
6. `npm install` in docs, or ship prebuilt (1.2) — 15 min
7. Point demo + dashboard at the same state dir; ship `allowance demo` in the package (1.5) — 1 h
8. `EADDRINUSE` handler + real `--help` + `--version` (1.6, 1.7) — 1 h
9. Dashboard progress bar (2.1) — 15 min

**Next (correctness under load):**
10. Reserve-then-commit for concurrency, or document + ship a serialising wrapper (0.3) — half a day
11. `settlement_rejected` path: set `error`, write the ledger row (3.2) — 1 h
12. Export `topUp()` (3.1), `PolicyRule` union + `quotedMicro`/`retryAfterMs` (3.3) — 2 h
13. Rule ordering: approval outranks per-call cap; warn on impossible bands (3.4) — 1 h

**Then (humans):**
14. Plain-English pass over every user-facing string; `audit` as a table (P4.4, P4.5) — half a day
15. Notifications on 50/80/100% + every block + every queued approval (P4.2) — 1–2 days
16. Escape `innerHTML`, add `@media`/`:focus`/`aria` (0.5, 2.4) — half a day
17. Honest scope sentence near the top of README + site (P4) — 10 min
