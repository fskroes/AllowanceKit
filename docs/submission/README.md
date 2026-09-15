# Wallie: Stocklana submission pack

Target event: [Stocklana](https://hackathons.solana.com/hackathons/stocklana).
The deadline is **18 September 2026, 22:00 Europe/Amsterdam (20:00 UTC)**.

The selected product flow is a tokenized-stock monitor: an agent buys price and
risk reports within a USDC allowance and shows stock-specific alerts. The public
demo uses simulated USDC with either scenario data or live DEX pool data. Keep
that demo and the separate generic devnet payment proof distinct. Videos are
deferred to the project owner. This pack has not been submitted to the portal.

## Entry fields

**Project name:** Wallie

**Tagline:** Watch the stocks. Cap the data bill.

**Technical scope:** Tokenized-stock data and analytics, agent spending controls,
Solana payment infrastructure. Choose the closest available category in the form.

**Project description:**

An agent that monitors tokenized stocks can make repeated data requests without
knowing when to stop spending. Wallie gives that agent a watchlist and an enforced
allowance. Its stock monitor reads AAPLx, NVDAx and SPYx on Solana, flags large
24 hour price moves and thin pool liquidity, and shows every report charge,
unused ceiling refund and budget refusal.

The public demo reserves 0.005 simulated USDC per request and charges 0.003 for a
delivered report. A 0.014 budget buys four reports; the fifth is blocked before
data access. If the provider fails, the full ceiling returns. Live mode derives
reports from DEX Screener pools matched to issuer mints; scenario mode is
repeatable without a data provider. Quote update times are unknown and labeled.
The demo runs the published Wallie SDK, Solana signing and real HTTP x402
negotiation with simulated settlement. It moves no funds and places no trades.

**Stock monitor work:**

- Browser flow and local command with watchlist, bounded session budget, stock
  alerts, data source choice and a per-request ledger.
- Issuer mint binding, deepest eligible DEX pool selection, explicit missing
  metrics, unknown quote freshness and provider failure with full refund.
- Tests that run the payment protocol and prove a budget refusal occurs before
  another data read, plus browser checks for errors, mobile and live data.

**Underlying payment runtime:**

- A Solana payment rail behind the existing allowance runtime, with optional
  chain dependencies for SDK users.
- Exact transaction signing and a self-facilitated metered seller using the
  x402 Solana payment-channel library.
- Explicit accounting for spent, reserved, and escrowed amounts. Recovery
  preserves spending history and does not release uncertain deposits.
- MCP tools for payments, budgets, channel inspection, approval decisions, and
  reclaim, plus a deterministic example client.
- Persistent seller cleanup that resumes after a restart and follows the
  program's expiry and refund rules.
- Public devnet proof, a repeatable offline demo, and installation checks against
  the actual npm tarballs.

**Why Solana:**

The metered flow uses Solana payment channels to authorize a ceiling before the
work and settle actual usage afterwards. The seller sponsors the normal payment
transactions. Tracking the open deposit as escrow lets an agent retain a useful
spending allowance without treating locked funds as available or permanently spent.

**Technology:** TypeScript, Node.js, Solana, USDC, x402, `@x402/svm`, `@solana/kit`,
Model Context Protocol, vanilla HTML/CSS, integer micro-unit accounting.

**License:** MIT

**Source owner:** [fskroes](https://github.com/fskroes)

## Links to hand in

The runtime packages and `v0.6.0` tag are published. Cloud's missing migration is
applied and authenticated production heartbeat/overview checks pass. See the
[deployment record](../research/launch-deployment-2026-09-15.md) for the latest
website deployment and verification.

| Field | URL |
|---|---|
| Stock monitor demo | https://www.onewallie.com/stock-monitor.html |
| Stock monitor source | https://github.com/fskroes/onewallie-site/tree/main/lib/stock-monitor |
| Payment proof page | https://www.onewallie.com/solana.html |
| Runtime source | https://github.com/fskroes/AllowanceKit/tree/v0.6.0 |
| Runtime package | https://www.npmjs.com/package/allowance-kit/v/0.6.0 |
| MCP package | https://www.npmjs.com/package/wallie-mcp/v/0.6.0 |
| Canary record | https://github.com/fskroes/AllowanceKit/blob/v0.6.0/docs/canary-runs/2026-09-14-solana-devnet-readiness.md |
| Devnet transaction | https://explorer.solana.com/tx/oAcbQ7M8gj3E1LveUr8nf8bcqVEmJPpjWXcS3Z5Ez5JYF7YqfnCpcssdnD2hfPeTJNL6tZBeTERNSiiLB3K2FGT?cluster=devnet |

The page leads with the interactive stock monitor. Video links stay hidden until the
owner supplies and approves the submission videos. The existing video source and
build instructions are retained for that later work.

## Judge quickstart

Use Node 24 or later. The stock monitor requires no wallet or funds:

```bash
git clone https://github.com/fskroes/onewallie-site.git
cd onewallie-site
npm ci
npm run demo:stocks
npm run demo:stocks -- --live-data
npm test
npm run build
npm run check
```

Expected: AAPLx, NVDAx, SPYx, then AAPLx reports; 0.012 simulated USDC charged,
0.002 remaining, zero escrow, then a budget block. Scenario NVDAx triggers price
and liquidity alerts, and the second AAPLx report triggers a price alert. Live
alerts depend on current pool data. Neither command performs a chain transaction.

To reproduce the separate generic payment and MCP demo from the released tag:

```bash
git clone --branch v0.6.0 --depth 1 https://github.com/fskroes/AllowanceKit.git
cd AllowanceKit
npm ci
npm run demo:mcp
npm test
npm run build
```

Expected demo outcomes:

1. The client lists the real MCP server's tools.
2. Weather data costs $0.001 on the local practice rail using `exact`.
3. The $5 enterprise request is blocked by the $1 per-call cap.
4. An offline Solana `upto` request deposits $0.10, charges $0.03 for 30 rows, and
   refunds $0.07.
5. The channel list and budget show the resolved payment.

No keys or funds are required for this demo. The on-chain proof is the separate
public devnet transaction linked above. Its finalized slot is **498210157** and
its transaction error is **null**. The settlement's token deltas are **30,000**
micro USDC to the seller and **70,000** to the buyer.

To repeat the live devnet run, follow the canary record with funded devnet wallets.
Do not substitute a mainnet key or network for a judge's offline quickstart.

## Architecture and validation

[Deployment validation](../research/launch-deployment-2026-09-15.md): 231 runtime
tests passed and all three published packages passed fresh-consumer checks.
The earlier [validation report](VALIDATION.md) records the initial 226 tests and
70 page/viewport checks; the deployment record includes later stock monitor checks.
The [earlier devnet canary](../canary-runs/2026-09-14-solana-devnet-readiness.md)
verified recovery using actual finalized transaction history. No new funded chain
transaction was made during the launch checklist work.

The buyer checks policy before constructing a signed payment. A local reservation
prevents parallel authorizations from using the same allowance. Opening a Solana
channel moves that commitment into the channel book. A terminal outcome enters the
ledger before escrow is released, and repeated recovery is idempotent.

Reconciliation checks the channel's network and finalized chain evidence. A
missing account alone is insufficient to declare the money returned. Unavailable
or incomplete evidence keeps the deposit held. Channel snapshots use validated
schemas and atomic replacement, so a damaged file cannot silently reset the budget.

The seller wraps the x402 facilitator and its cleanup manager. Its persistent
index contains public channel facts only. A failed atomic settlement may leave
the channel open; cleanup follows the library's abandon-close/refund behavior,
rather than charging an uncompleted request again.

Run `node scripts/verify-release.ts` to pack all three npm packages, install them
in a fresh temporary consumer, and check SDK imports, the CLI alias and demo, and
MCP discovery over stdio. This is separate from source-level tests.

## Scope stated in the entry

- Stock report payments are simulated. Live refers to the market-data source,
  not funded settlement. The deterministic agent needs no LLM and trades no stock.
- The provider's public API is free. The demo prices Wallie's derived report;
  no payment is sent to DEX Screener. Token pool prices are not underlying share
  prices, NAV or executable quotes. Alerts are fixed rules, not trading advice.
- Public devnet proves the metered `upto` settlement. Live Solana exact through
  CDP has not been independently established by that canary.
- This submission does not claim a Solana mainnet canary or sustained production
  traffic. Mainnet use remains an explicit operator choice.
- Spending controls apply to payments routed through Wallie. They do not cap a
  separate cloud invoice or transactions made outside the runtime.
- MCP approval tools are administrative authority. A client given
  `decide_approval` can approve requests, so it must be trusted. This is not a
  separate human authentication boundary.
- Buyer reclaim requires SOL. An RPC that cannot provide the required finalized
  history can leave a deposit held until better evidence is available.

## Portal status

Checked on **14 September 2026** against the
[Stocklana event page](https://hackathons.solana.com/hackathons/stocklana): one
submission per team, with at least one repository, demo, or video link. The three
Wallie components can support one entry. See the
[official requirements research](../research/stocklana-requirements-2026-09-14.md).

Before submitting, check the authenticated form's eligibility terms and include
the existing-work disclosure below. No entry or registration has been submitted.

## Existing-work disclosure

Wallie, AllowanceKit and Cloud existed before this stock monitor. The released
`allowance-kit@0.6.0` supplies policy checks, Solana x402 payments, escrow,
recovery, CLI and MCP tools. The linked devnet payment is a separate generic
canary recorded on 14 September, not a stock monitor transaction.

The work added on 15 September is the stock-specific application in
`onewallie-site`: issuer-bound AAPLx/NVDAx/SPYx market reports, price/liquidity/data
quality alerts, the browser flow, paid-report simulation, CLI, tests and deployment.
The submission does not present the whole existing toolkit as new event work.

## Rebuild the videos

The source is [`demo/submission/story.json`](../../demo/submission/story.json).
The builder uses local speech synthesis, Playwright, and FFmpeg; no hosted LLM or
speech API is used. Generated video files stay outside Git and are deployed as
site assets. See [the media build instructions](../../demo/submission/README.md).
