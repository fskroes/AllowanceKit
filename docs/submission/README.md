# Wallie: Solana Agentic Payments submission

Use the fields below for the hackathon entry. They describe the submitted work
without treating an offline demo as an on-chain payment.

## Entry fields

**Project name:** Wallie

**Tagline:** An allowance for your agent. Autonomous payments, accountable spending.

**Category:** Agentic payments, wallets and spending controls, merchant tooling

**Project description:**

Wallie gives an AI agent a spending allowance for x402 APIs. Before it signs a
payment, the runtime checks the destination, the per-call cap, the rate of
spending, and the remaining budget. This submission adds Solana exact payments
and metered `upto` payment channels. Open deposits count as escrow, so locked
money cannot be authorized a second time. The SDK, CLI, MCP server, dashboard,
and ledger expose the same spending state. Sellers get payment middleware and
persistent channel cleanup. A finalized public Solana devnet transaction proves
a $0.10 deposit, a $0.03 charge, and a $0.07 refund. The repository includes a
repeatable offline MCP demo, recovery regression tests, and the full canary record.

**What we built:**

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
- Public devnet proof, a pitch, a technical walkthrough, and installation checks
  against the actual npm tarballs.

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

| Field | URL |
|---|---|
| Demo page | https://www.onewallie.com/solana.html |
| Source | https://github.com/fskroes/AllowanceKit/tree/v0.6.0 |
| Pitch, 3 minutes | https://www.onewallie.com/media/pitch.mp4 |
| Walkthrough, 5 minutes | https://www.onewallie.com/media/walkthrough.mp4 |
| Runtime package | https://www.npmjs.com/package/allowance-kit/v/0.6.0 |
| MCP package | https://www.npmjs.com/package/wallie-mcp/v/0.6.0 |
| Canary record | https://github.com/fskroes/AllowanceKit/blob/v0.6.0/docs/canary-runs/2026-09-14-solana-devnet-upto.md |
| Devnet transaction | https://explorer.solana.com/tx/Yqw1ZRcG4DHBhhrh4zkkpT1QXHT9CosHC2PfK6vg5hwPCCAyP6GzVz5dBMMGEnkvwaqWjNC8kceR2LnWdjnmVRx?cluster=devnet |

The page offers captions, downloadable videos, narration transcripts, and the
captured demo output. The narration is generated locally using a generic computer
voice. It does not impersonate a team member.

## Judge quickstart

Use Node 24 or later for source execution:

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
public devnet transaction linked above. Its finalized slot is **498173798** and
its transaction error is **null**. The settlement's token deltas are **30,000**
micro USDC to the seller and **70,000** to the buyer.

To repeat the live devnet run, follow the canary record with funded devnet wallets.
Do not substitute a mainnet key or network for a judge's offline quickstart.

## Architecture and validation

[Validation report](VALIDATION.md): 226 tests passed, all three packed packages
passed fresh-consumer checks, browser playback passed on desktop and mobile, and
[a new devnet canary](../canary-runs/2026-09-14-solana-devnet-readiness.md) also
verified recovery using the actual finalized transaction history.

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

Checked on **14 September 2026**: the linked
[Agentic Payments hackathon page](https://hackathons.solana.com/hackathons/agentic-payments-mtxd9fkr)
is seeking sponsors and states that scheduling follows the funding goal. It does
not expose an open project-submission form. This file is the hand-in package,
not a claim that an entry or registration has been submitted. When the form
opens, use the fields and links above and check the published eligibility rules.

## Rebuild the videos

The source is [`demo/submission/story.json`](../../demo/submission/story.json).
The builder uses local speech synthesis, Playwright, and FFmpeg; no hosted LLM or
speech API is used. Generated video files stay outside Git and are deployed as
site assets. See [the media build instructions](../../demo/submission/README.md).
