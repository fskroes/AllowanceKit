# Wallie: Stocklana submission draft

Target event: [Stocklana](https://hackathons.solana.com/hackathons/stocklana).
The deadline is **18 September 2026, 22:00 Europe/Amsterdam (20:00 UTC)**.

The fields below describe the existing Solana payment tools. They are not yet a
complete Stocklana entry: the event requires a tokenized-stock use case, and that
product flow has not been selected or implemented. Keep the offline demo and the
historical on-chain proof distinct. Videos are deferred to the project owner.

## Entry fields

**Project name:** Wallie

**Tagline:** An allowance for your agent. Autonomous payments, accountable spending.

**Technical scope:** Agentic payments, wallets and spending controls, merchant tooling.
Choose the event category after the stock-specific flow is defined.

**Project description:**

Wallie gives an AI agent a spending allowance for x402 APIs. Before it signs a
payment, the runtime checks the destination, the per-call cap, the rate of
spending, and the remaining budget. The prepared release adds Solana exact payments
and metered `upto` payment channels. Open deposits count as escrow, so locked
money cannot be authorized a second time. The SDK, CLI, MCP server, dashboard,
and ledger expose the same spending state. Sellers get payment middleware and
persistent channel cleanup. A finalized public Solana devnet transaction proves
a $0.10 deposit, a $0.03 charge, and a $0.07 refund. The repository includes a
repeatable offline MCP demo, recovery regression tests, and the full canary record.

**Prepared technical work:**

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

These are the intended public release URLs. Verify each after publication before
copying it into the event form. Version 0.6.0 is tested locally but is not published
yet. The launch fixes are deployed to protected previews; the production domains
still need their release deployment. See the [launch fix report](../research/launch-fixes-2026-09-14.md).

| Field | URL |
|---|---|
| Demo page | https://www.onewallie.com/solana.html |
| Source | https://github.com/fskroes/AllowanceKit/tree/v0.6.0 |
| Runtime package | https://www.npmjs.com/package/allowance-kit/v/0.6.0 |
| MCP package | https://www.npmjs.com/package/wallie-mcp/v/0.6.0 |
| Canary record | https://github.com/fskroes/AllowanceKit/blob/v0.6.0/docs/canary-runs/2026-09-14-solana-devnet-readiness.md |
| Devnet transaction | https://explorer.solana.com/tx/oAcbQ7M8gj3E1LveUr8nf8bcqVEmJPpjWXcS3Z5Ez5JYF7YqfnCpcssdnD2hfPeTJNL6tZBeTERNSiiLB3K2FGT?cluster=devnet |

The page leads with the runnable offline demo. Video links stay hidden until the
owner supplies and approves the submission videos. The existing video source and
build instructions are retained for that later work.

## Judge quickstart

Use Node 24 or later for source execution. This release quickstart requires the
public `v0.6.0` tag. Before publication, run these checks in the prepared checkout
instead of trying to clone the missing tag.

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

[Validation report](VALIDATION.md): 226 tests passed and all three packed packages
passed fresh-consumer checks. The launch fixes passed 70 page and viewport checks.
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

Before submitting, add the chosen tokenized-stock flow, describe the user problem
it solves, disclose the existing toolkit and the work added for this event, and
check the authenticated form's eligibility terms. Cloud's `002_channels.sql`
migration must also be applied and checked before claiming hosted channel support.
No entry or registration has been submitted by this work.

## Rebuild the videos

The source is [`demo/submission/story.json`](../../demo/submission/story.json).
The builder uses local speech synthesis, Playwright, and FFmpeg; no hosted LLM or
speech API is used. Generated video files stay outside Git and are deployed as
site assets. See [the media build instructions](../../demo/submission/README.md).
