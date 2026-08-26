# AllowanceKit

**The missing buyer-side runtime for x402.** Fund your AI agent once. It pays any x402-priced API autonomously — inside hard rails *you* control.

Landing page: [onewallie.com](https://onewallie.com) · Follow-along tutorial: [onewallie.com/docs.html](https://onewallie.com/docs.html)

```bash
npx allowance-kit init          # provision agent wallet (stable identity across commands)
npx allowance-kit topup 5.00    # fund the allowance once (simulated faucet funds on the mock ledger)
npx allowance-kit policy perCallMaxUsd 0.50
npx allowance-kit dashboard     # watch every cent, flip the kill switch, clear approval queue
```

Or as a one-import SDK:

```ts
import { payingFetch, createAgent } from "allowance-kit";

const agent = createAgent(".allowance", "my-agent");
const res = await payingFetch(agent.ctx, "https://api.example.com/weather?city=lisbon");
// res.ok · res.body · res.costMicro · res.txHash · res.blockedBy {rule, detail}
```

Requires Node ≥ 20.11. Zero runtime dependencies.

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

One-time flow for the human (repo checkout):

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
  index.ts          public API — `import { payingFetch, createAgent } from "allowance-kit"`
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
test/               zero-dependency node --test suite (wire shapes, CDP JWT,
                    facilitator contract, payer flows)
```

The wire format follows x402 v1 (`HTTP 402` + `accepts[]` + base64 `X-PAYMENT` / `X-PAYMENT-RESPONSE` headers). Two settlement rails ship:

- **Mock ledger** (default): deterministic, HMAC-signed, replay-protected, all funds simulated — the product runs anywhere with zero setup and zero funds at risk.
- **Coinbase CDP** (`CdpFacilitator`): real verify/settle through the facilitator most live x402 sellers use. Sellers flip one option:

```ts
import { paymentGate } from "allowance-kit";
import { CdpFacilitator } from "allowance-kit";

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

Buyers targeting **live x402 endpoints** use the same allowance rails with an EVM signer:

```ts
import { payingFetch, createLiveAgent } from "allowance-kit";

const live = await createLiveAgent({ stateDir: ".allowance", privateKey: process.env.AGENT_KEY! });
const res = await payingFetch(live.ctx, "https://some-live-x402-api.com/data");
```

Signing requires the optional peer dependency [`viem`](https://viem.sh) (`npm i viem`); everything else stays zero-dep. Policy, approvals, kill switch, and the audit ledger apply identically to simulated and live spending.

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

- Default settlement is a mock ledger (HMAC-signed payloads, nonce replay protection) — **all funds are simulated**; the CLI and dashboard say so at every money touchpoint. Real settlement ships two ways: sellers settle real USDC via `CdpFacilitator`, buyers sign real x402 v1 payments via `createLiveAgent` (needs optional `viem`). Untested against mainnet until first live transaction — treat the first runs as canary.
- The CLI (`npx allowance-kit`) manages a single agent per state dir today; multi-agent is a schema change (`agentName` already threads everywhere).
- Approved grants are standing per host+amount (no expiry, no per-grant spend cap yet); the approval notification channel is local (CLI/dashboard) — no webhook/Slack push yet.
- npm ships compiled `dist/` (ESM + `.d.ts`, built from the TypeScript sources in `src/` with zero runtime deps); repo checkouts run the sources directly on Node ≥ 24.
