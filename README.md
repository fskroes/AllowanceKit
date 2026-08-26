# AllowanceKit

**The missing buyer-side runtime for x402.** Fund your AI agent once. It pays any x402-priced API autonomously — inside hard rails *you* control.

Landing page: [onewallie.com](https://onewallie.com) · Follow-along tutorial: [onewallie.com/docs.html](https://onewallie.com/docs.html)

```
npm run demo        # full scripted scenario (no deps, no keys, no network)
npm run dashboard   # live ledger → http://localhost:4030
```

Requires Node ≥ 24 (runs TypeScript natively). Zero dependencies.

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

## What it does

One-time flow for the human:

```bash
node src/cli.ts init          # provision agent wallet (stable identity across commands)
node src/cli.ts topup 5.00    # fund the allowance once (simulated faucet funds on the mock ledger)
node src/cli.ts policy perCallMaxUsd 0.50
node src/cli.ts dashboard     # watch every cent, flip the kill switch, clear approval queue
```

Then the agent just calls `payingFetch(ctx, url)` instead of `fetch(url)` against any x402 endpoint. It handles the whole protocol — 402 challenge → price discovery → two-phase policy authorization → signed payment → settle → receipt — while the policy engine enforces:

| Rail | Rule | Blocked pre-payment |
|---|---|---|
| `killSwitch` | human freeze, instant | ✅ |
| `host_not_allowlisted` / `blockedHosts` | default-deny destinations | ✅ |
| `per_call_cap` | max price per single call | ✅ |
| `velocity_circuit_breaker` | rolling-window spend limit (kills retry loops) | ✅ |
| `budget_exhausted` | hard total allowance | ✅ |
| `human_approval_required` | escalation gate above threshold | ⏸ blocked & queued until you approve |

Approvals are real, not decorative: an above-threshold call is blocked and lands in a queue (`cli approvals` or the dashboard). You approve or deny by id; once approved, that host+price-class passes on retry. Every step — request, decision, retry — is in the ledger.

The kill switch and the approval queue are **token-gated**: mutating dashboard endpoints require the local control token (auto-generated into `.allowance/dashboard-token`, injected into the served UI).

Every decision — paid or blocked, with rule + reason + tx hash — lands in an append-only JSONL ledger (`​.allowance/ledger.jsonl`) that satisfies EU AI Act Art. 26 §5 logging.

## Architecture

```
src/
  types.ts          x402 wire types (PaymentRequired, PaymentPayload, receipts)
  money.ts          integer micro-dollar math (no float drift)
  chain.ts          settlement + Facilitator interface {verify, settle}
                    MockChain = deterministic local ledger w/ replay protection,
                    snapshots to disk. Swap for Coinbase CDP facilitator by
                    implementing 2 methods — nothing else changes.
  seller.ts         paymentGate(): drop-in x402 middleware for any node:http route
  payer.ts          payingFetch(): the agent-side client (two-phase authorization)
  policy.ts         PolicyStore (hot-reloaded JSON) + evaluatePolicy()
  approvals.ts      human-approval queue (request → decide → standing grant)
  wallet.ts         agent runtime: stable wallet identity + authorization gate
  ledger.ts         append-only audit log
  demo-servers.ts   five x402-priced APIs used by the demo
  dashboard-server.ts + public/dashboard.html   live UI; kill switch & approvals
                    are token-gated (.allowance/dashboard-token)
demo/demo.ts        the full story: happy path → runaway loop → attacks → approval
                    → kill switch. Runs in its own .allowance-demo/ state dir and
                    never touches your funded .allowance/ ledger.
```

The wire format follows x402 v1 exactly (`HTTP 402` + `accepts[]` + base64 `X-PAYMENT` / `X-PAYMENT-RESPONSE` headers), so the seller middleware and client interoperate with real x402 tooling once a real facilitator is plugged in. Settlement here uses a deterministic mock ledger so the product runs anywhere with zero setup and zero funds at risk.

## Demo output (abridged)

```
PHASE 1 · fine-grained pay-per-use
  PAID    weather?city=lisbon            $0.001000  0xcddcb9a6…
  PAID    research?topic=agent-payments  $0.250000  0x4e5bc352…

PHASE 2 · runaway loop
  PAID    loop #1…#149                   $0.010000 each
  BLOCKED loop #150  velocity_circuit_breaker  rolling 12s spend would exceed $2.00

PHASE 3 · attack, mispricing & approval gate
  BLOCKED evil-api.example.com  host_not_allowlisted
  BLOCKED report?id=q3-2026     human_approval_required ($0.45 ≥ $0.30 → queued)
  human approves via dashboard button or `cli approve <id>`
  PAID    report?id=q3-2026 (retry)      $0.450000 (approved grant)
  BLOCKED feed?key=pro         per_call_cap ($5 > $0.50)

PHASE 4 · kill switch
  BLOCKED weather?city=berlin   kill_switch — human paused all spending

spent $2.443 across 155 settled payments; 5 policy blocks enforced
remaining allowance: $2.557 of $5.00 simulated
```

## Business model

Open-source core (this repo) drives distribution and trust. Monetization on top:

1. **Hosted Allowance Cloud** — multi-agent allowances for teams/orgs: SSO, webhooks (block alerts → Slack), spend analytics, fiat top-up via card. $20/mo per workspace + 1% of settled volume past free tier.
2. **Compliance pack** — EU AI Act Art. 26 evidence exports (signed ledger digests, policy-version-at-tx-time attestation), retention policies. Enterprise pricing.
3. **Facilitator revenue share** — default hosted facilitator routes through CDP-style settlement; share of the ~$0.001/tx facilitator economics at scale.

The wedge is precise: sellers already have x402 middleware; **nobody owns the moment a human says "here's $5, go work" and stays in control.**

## Honest limitations

- Settlement is a mock ledger (HMAC-signed payloads, nonce replay protection) — **all funds are simulated**; the CLI and dashboard say so at every money touchpoint. Real chain integration = implement `Facilitator.verify/settle`; wire formats already match x402 v1.
- Single-agent CLI today; multi-agent is a schema change (`agentName` already threads everywhere).
- Approved grants are standing per host+amount (no expiry, no per-grant spend cap yet); the approval notification channel is local (CLI/dashboard) — no webhook/Slack push yet.
