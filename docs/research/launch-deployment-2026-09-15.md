# Launch deployment, 15 September 2026

Follow-up to [launch fixes](launch-fixes-2026-09-14.md). The owner requested
remaining blocker fixes and deployment. Videos remain deferred. The owner chose
the tokenized-stock monitor and approved the business postal address, with the
organization spelling explicitly corrected to **Eames**.

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
- Initial website launch: 7 tests passed; page checks and build passed.
- Stock monitor revision: 15 tests passed, including real local x402 accounting,
  refund failures, malformed API input and isolated sessions. Build and SEO checks
  passed for all 9 HTML pages.
- Stock monitor browser: 36 checks passed at widths 320, 360, 390, 768 and 1440,
  including live DEX data, budget stops, micro-USDC precision, errors/retries,
  theme changes, no overflow and approved legal contact text.
- Stock preview API: scenario and live mode both returned HTTP 200, four reports,
  0.012 charged, 0.002 remaining and zero escrow. All three live asset feeds passed.
- 42 deployed GET checks passed against the stock preview and production Cloud,
  including stock routes, source exclusions and API execution rather than source.
- Final production rerun: all 36 stock browser checks and all 42 public GET
  checks passed on `www.onewallie.com` and `app.onewallie.com` after alias updates.
- Final analytics rerun: the website homepage, stock monitor and Cloud homepage
  each sent a sanitized pageview accepted with HTTP 202.
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
- Initial website production: `dpl_AkauKkCQp9wmkrAJbMgK6bhbHLSm`, aliased explicitly
  to [onewallie.com](https://onewallie.com) and
  [www.onewallie.com](https://www.onewallie.com).
- Web Analytics enabled for both projects. The synthetic browser must disable
  its test-only WebDriver/headless markers to exercise transport; Vercel skips
  ordinary bot visits. Product code remains unchanged by the test.
- Stock monitor preview: `dpl_7brJHZWeGtFa4dAJkse6anNoYtNC` at
  `https://onewallie-61t7seann-fernando-silva-kroes-projects.vercel.app`.
- Website PR #3 merged as `e7d8d3fe011f0ee2b46803a1f614fc063f8e6d8d` after CI
  and PR Lens completed. Independent review found and fixed a malformed nested
  watchlist input; the final review had no findings.
- Stock monitor production: `dpl_A3y9ssms1gMjf48cfd1gTFBTzVDN`, from that merged
  commit, at `https://onewallie-8handrd69-fernando-silva-kroes-projects.vercel.app`.
  Both `onewallie.com` and `www.onewallie.com` serve this deployment. Public demo:
  [stock-monitor.html](https://www.onewallie.com/stock-monitor.html).
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

## Stock monitor and postal contact

Approved postal text: **Eames, Biesbosch 273, 1181 JC, Amstelveen, The Netherlands.**
The organization spelling matches the existing legal pages. Both legal contact
sections and the applicable product footers use this text.

The chosen Stocklana flow is implemented in the website repository's
`lib/stock-monitor/`, `api/stock-monitor.js` and `stock-monitor.html`. It uses
published `allowance-kit@0.6.0` and exact Solana dependency versions. Actual HTTP
x402 negotiation and Solana message signing run against an isolated in-memory
operator. All public payment amounts are labeled simulated USDC; the server
generates a fresh unfunded key and temporary state, then removes it after the run.

The default 0.014 allowance buys four reports at 0.003 each, reserving 0.005 and
refunding 0.002 on each successful request. The fifth request is refused before
data access. Provider failure returns the full reservation. Session limits cap
input at three issuer-bound assets, a 0.1 budget and five requests.

Live DEX data reads succeeded for AAPLx, NVDAx and SPYx. Mint addresses were
verified against issuer metadata. The report selects the deepest priced Solana
base-token pool and derives 24-hour movement and liquidity alerts. Unknown
metrics remain unknown. DEX Screener supplies no quote update timestamp, so fetch
observation is not described as proof of quote freshness. Stale reported cache
age, HTTP errors and invalid pool data fail without substituting scenario prices.

The public API is free; Wallie prices its derived report in the simulation, and
no payment is sent to DEX Screener. Neither a stock trade nor a funded stock data
transaction was performed. The submission pack discloses the existing runtime
and this new stock-specific work. Videos and portal submission remain with the
owner.
