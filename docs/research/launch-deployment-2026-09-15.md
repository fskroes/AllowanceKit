# Launch deployment, 15 September 2026

Follow-up to [launch fixes](launch-fixes-2026-09-14.md). The owner requested
remaining blocker fixes and deployment. Videos remain deferred. Postal contact
text and the Stocklana tokenized-stock scope are awaiting owner input.

## Cloud database

Applied the existing `002_channels.sql` migration to the linked production
database. The subsequent read-only schema check passes. This restores the
required `agents.escrow_micro` column and channel event index. Missed historical
heartbeats are not reconstructed.

Use the isolated production runner from this repository:

```sh
node scripts/cloud-production.mjs ../wallie-cloud check:schema
node scripts/cloud-production.mjs ../wallie-cloud migrate
node scripts/cloud-production.mjs ../wallie-cloud verify
```

Vercel CLI 54.20.1 merges local dotenv and parent environment values over the
downloaded production environment. Running directly from a checkout can select
a different database. The runner constructs a clean temporary Vercel link,
excludes dotenv files and clears inherited `DATABASE_URL`. Credentials remain
inside the child process. Both the original and isolated checks reported the
missing migration before it was applied; the isolated check passed afterward.

The `verify` command creates a temporary synthetic workspace, API key and
single-use sign-in link. It calls the deployed sign-in callback, which creates
the real session cookie without sending email. Two authenticated heartbeats set
escrow to 250,000 micro-USDC and clear it to zero. Two account-overview reads
confirm those values and current liveness. The command removes its workspace,
keys, sessions, agents and rate-limit fixture afterward, including on failure.
This production check passed. No customer credentials or rows were used.

## Release review corrections

PR Lens completed for AllowanceKit PR #6. A separate code review found two
blocking defects in `@x402/svm@2.25.0`'s cleanup integration:

1. The library reverses the program's Sealed=1 and Closing=2 state values.
2. It deletes a durable pre-broadcast deposit row when the channel is absent,
   even while the signed open transaction can still land.

The fixes use the library's public cleanup-only signer override. Payment reads
keep their original bytes. Cleanup validates the channel account, requests
finalized state and translates the two enum values. The dependency is pinned
to exactly 2.25.0 so an upstream enum correction cannot silently double-swap it.

The validated pre-broadcast upsert now retains the signed open slot, using
Node's AsyncLocalStorage to keep concurrent deposit contexts separate. An
absent row can be removed only after an explicit finalized RPC absence with
context slot at least `openSlot + 1501`. The extra RPC read uses `minContextSlot`
because the library's signer API discards context. Missing, stale or failed
evidence keeps the record. Legacy records without a signed slot remain indexed.
These fixes were reviewed again with no blocking findings.

The first two regression tests reproduced the failures before the fixes. All
16 seller cleanup tests now pass, including pending deposits during broadcast,
restart recovery, concurrent slot isolation and finalized expiry boundaries.
Transaction submission in these tests is mocked; no new funded chain
transaction was performed.

## Validation

- AllowanceKit: 231 passed, 3 opt-in sandbox tests skipped, 0 failed.
- TypeScript build, offline MCP demo and all three fresh tarball consumer checks passed.
- Cloud: 91 tests passed; typecheck and build passed.
- Website: 7 tests passed; page checks and build passed.
- Production schema check passed after migration.
- Production sign-in callback, 2 authenticated heartbeats and 2 authenticated
  overview reads passed. Synthetic fixture removed; no email or alert sent.
- 35 public GET checks passed for pages, assets, 404s, discovery, API routing
  and source exclusions on `www.onewallie.com` and `app.onewallie.com`.
- Registry installation of all three 0.6.0 packages passed, including CLI
  version checks, SDK imports, MCP discovery and the pinned Solana dependency.
- Public `v0.6.0` clone, `npm ci` and `npm run demo:mcp` passed. Installation
  reported zero vulnerabilities; the demo discovered all five MCP tools.
- Both production sites sent an actual sanitized Insights pageview with HTTP
  202. This confirms transport acceptance, not a separate dashboard inspection.

## Deployment status

- Cloud PR #2 merged as `ceb40858f5a310032606ff3551cc34f99e3aac54`.
- Website PR #2 merged as `d80710d8408d1e00df5d9abcd1d37f68ceac1150`.
- Cloud production: `dpl_3FK23CyKGNCxjXz2r4bra5eiDavu`, aliased to
  [api.onewallie.com](https://api.onewallie.com) and
  [app.onewallie.com](https://app.onewallie.com).
- Website production: `dpl_AkauKkCQp9wmkrAJbMgK6bhbHLSm`, aliased explicitly
  to [onewallie.com](https://onewallie.com) and
  [www.onewallie.com](https://www.onewallie.com).
- Web Analytics enabled for both projects. The synthetic browser must disable
  its test-only WebDriver/headless markers to exercise transport; Vercel skips
  ordinary bot visits. Product code remains unchanged by the test.
- AllowanceKit PR #6 merged after Node 20.11, 22 and 24 CI plus PR Lens passed.
- Published `allowance-kit@0.6.0`, `wallie@0.6.0` and `wallie-mcp@0.6.0` from
  release commit `7f9009b`, then pushed `v0.6.0` and created the
  [GitHub release](https://github.com/fskroes/AllowanceKit/releases/tag/v0.6.0).
- No email, checkout, funded chain transaction or Stocklana portal submission
  was sent during this work. Videos remain deferred.

Repeat the public page and real analytics transport checks:

```sh
node scripts/check-deployed-sites.mjs ../onewallie-site ../wallie-cloud https://www.onewallie.com https://app.onewallie.com /tmp/wallie-production-get.json
node scripts/check-production-analytics.mjs /path/to/playwright/index.mjs /path/to/chrome
```

## Still needs owner input

The postal address is not published because no approved text was supplied.
The Stocklana entry remains a draft because no tokenized-stock flow was selected.
The requested options were a paid stock-data monitor, a paper-trading demo, or
live tokenized-stock trading with an explicitly selected provider and funding.
No stock-specific claims or fabricated address were added to the website.
