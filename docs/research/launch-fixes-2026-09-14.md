# Wallie launch fixes, 14 September 2026

**Update, 15 September:** See the [deployment record](launch-deployment-2026-09-15.md)
for the applied production migration and published release. Use the isolated
`scripts/cloud-production.mjs` commands in that record for production database
work. Vercel CLI can let local dotenv values override downloaded production
values in the older commands below.

This records the fixes made after the [readiness audit](stocklana-readiness-2026-09-14.md).
Scope: onewallie.com, Wallie Cloud and the prepared AllowanceKit 0.6.0 release.
The owner deferred submission videos. No production deployment, database write,
package publication, email delivery, checkout or funded chain transaction was
performed during this work.

## Result

The website and account UI fixes are implemented and tested in Vercel previews.
The runtime packages pass fresh installation checks. **Stocklana submission is
still blocked** by the missing stock-specific flow and the release actions below.

Reviewed previews, protected by the existing Vercel project access settings:

- [Marketing preview](https://onewallie-ommnwxke2-fernando-silva-kroes-projects.vercel.app/solana.html), source commit `5de12a3`.
- [Cloud preview](https://wallie-cloud-30klvj83u-fernando-silva-kroes-projects.vercel.app/), source commit `3e67e36`.

Review changes: [marketing PR #2](https://github.com/fskroes/onewallie-site/pull/2),
[Cloud PR #2](https://github.com/fskroes/wallie-cloud/pull/2), and
[AllowanceKit PR #6](https://github.com/fskroes/AllowanceKit/pull/6).

The production database has `001_init.sql`, `002_grace.sql` and
`003_lifecycle_delivery.sql` recorded. It does **not** have `002_channels.sql` or
the `agents.escrow_micro` column required by the deployed SOL-08 code. Two
independent read-only checks confirmed this. The new `npm run check:schema`
command also exits 1 and reports those exact missing items. Tests recreate this
migration order and prove that the existing channel migration can be applied
after 003, then checked successfully. No replacement migration is needed.

Source inspection shows the missing column breaks authenticated heartbeat writes
and account-overview reads. Event ingestion and the watchdog use existing columns
and can still work. After migration, the next client heartbeat can refresh current
liveness and escrow. There is no durable replay queue for missed heartbeat
history; this migration does not reconstruct intermediate measurements.

## Checklist after the fixes

“Pass” here means the prepared code and tested preview behavior. Production
domains still serve their previous deployments until the release is approved.

| Item | Result |
| --- | --- |
| Custom 404 page | Pass on both sites: branded content, noindex and HTTP 404 in actual Vercel previews. |
| Meta title on every page | Pass: 8 marketing pages, including 404; 8 Cloud pages, including 404. |
| Meta description on every page | Pass on the same pages. |
| CTA above the fold | Pass on marketing entry pages and Cloud sign-in; the Solana page leads with the offline demo. |
| Favicon set | Pass; marketing SVG and Cloud inline SVG. |
| robots.txt | Pass on both sites. Cloud excludes API paths and lets crawlers see page-level noindex. |
| sitemap.xml | Pass for all 7 indexable marketing pages, including Solana. Private Cloud pages are intentionally excluded from search and have no sitemap. |
| Open Graph image | Pass: metadata on marketing and Cloud pages points to the existing public dashboard image. |
| Alt text on every image | Pass for marketing images; enforced by the checker. Cloud has no HTML images. |
| Mobile breakpoints | Pass: 70 page/viewport combinations across 320, 360, 390, 768 and 1440 pixels. Tutorial overflow fixed. |
| Sticky mobile CTA | Existing sticky marketing and welcome actions retained. Private account screens do not need a sales CTA. |
| Loading states | Pass for sign-in and initial account panels. Account UI uses known fixtures for the browser checks. |
| Form error states | Pass: empty/invalid email, request failure, HTTP 400, expired magic link and expired session. Invalid email makes no API request. |
| Thank-you page | `/welcome` remains available; sign-in also shows its check-inbox state. A real checkout was not performed. |
| Privacy policy | Present, updated for aggregate analytics, directly linked from Cloud pages. |
| Terms and conditions | Present and directly linked from Cloud pages. |
| Cookie banner | Not added: no advertising/cross-site tracking or nonessential cookies were introduced. The analytics privacy boundary is described below. |
| Analytics installed | Pass in code and mocked production transport. Vercel project activation and real production receipt remain release checks. |
| Real contact address | Support email remains visible. A postal address is pending the owner's approved publication text. No private account address was copied. |
| Compressed images | Pass: responsive WebP at 480/800/1200/1600 pixels. Mobile file is 17,516 bytes versus the 476,533-byte PNG; largest WebP is 94,194 bytes. |

## Implementation and privacy boundary

Marketing now builds an allowlisted `public/` directory. It includes pages,
browser assets, discovery and ownership files, but excludes API source, build
scripts, configuration, tests, documentation and deferred media. API functions
remain separate Vercel function inputs. Generated images and SDK files stay out
of git. Build regression coverage verifies the output against fake private input
and stale output files.

The Solana page has a working offline-demo CTA, responsive screenshot, navigation
and sitemap entry. Its old video markup is retained in an inert template, with no
active video requests. Video source and build tools are unchanged.

Both sites use the official Vercel Analytics client. Only approved public routes
can send pageviews. Account pages, custom events, preview/local hosts and unknown
routes are excluded. Current URL queries/fragments are removed. The official
hosted script reads `document.referrer` after `beforeSend`, so the loader first
limits that value to its HTTP(S) origin. Failure to protect it disables analytics.
Do Not Track and Global Privacy Control disable loading altogether. No analytics
cookies or browser storage are added by this integration.

This configuration follows Vercel's guidance on [redacting analytics data](https://vercel.com/docs/analytics/privacy-policy).
The Dutch regulator distinguishes functional and low-impact analytics from
tracking that requires consent; this explains why a banner is not added merely
to satisfy a checklist. This is an implementation decision, not a complete legal
compliance assessment. Reassess consent before changing the tracking scope.
[AP guidance](https://autoriteitpersoonsgegevens.nl/uploads/imported/normuitleg_ap_cookiewalls.pdf).

## Validation

| Check | Result |
| --- | --- |
| AllowanceKit full test suite | 226 passed, 3 opt-in sandbox tests skipped, 0 failed. |
| AllowanceKit build, MCP demo, offline Solana canary | Passed. |
| Three package tarballs in a fresh consumer | SDK/chain imports, CLI alias/practice demo and MCP stdio checks passed. No npm publication. |
| Marketing build, SEO/local links and unit/build tests | Passed; all 8 HTML pages, 7 tests. |
| Cloud full test suite and typecheck | Passed; 91 tests. |
| Cloud production dependency audit | No reported vulnerabilities. |
| Website/browser regression | 70 page/viewport cases plus sign-in/loading/error/session checks passed. API responses intercepted; no email was sent. |
| Real analytics client transport | 8 mocked production-origin scenarios passed across both sites. Unsafe incoming referrer, direct visit, DNT and GPC tested. No analytics event left the browser test. |
| Actual Vercel deployments | Both builds passed; 35 GET checks passed for deployed routing, 404s, assets, discovery, API execution and source exclusions. |
| Production schema | Read-only check correctly fails for the missing channel migration and column. |
| Migration recovery | PGlite reproduces the current production migration order, applies only the missing migration, verifies column/index and passes the schema check. |

The newer readiness settlement was independently fetched again from Solana devnet
at finalized commitment: slot **498210157**, `meta.err: null`, 100,000 micro-USDC
in escrow before settlement, 30,000 credited to the seller and 70,000 returned to
the buyer. This verifies historical evidence; it is not a new transaction, a
tokenized-stock flow, a live exact-facilitator check or a mainnet claim.
[Readiness canary](../canary-runs/2026-09-14-solana-devnet-readiness.md),
[public transaction](https://explorer.solana.com/tx/oAcbQ7M8gj3E1LveUr8nf8bcqVEmJPpjWXcS3Z5Ez5JYF7YqfnCpcssdnD2hfPeTJNL6tZBeTERNSiiLB3K2FGT?cluster=devnet).

## Repeat the checks

Run each website's `npm ci`, `npm run build` and `npm test`; also run marketing
`npm run check` and Cloud `npm run typecheck`. Build before browser checks so the
ignored generated assets exist. The examples below assume the three repositories
are sibling directories. Use an existing Playwright module and Chrome binary.

```sh
node scripts/check-launch-sites.mjs ../onewallie-site ../wallie-cloud /path/to/playwright/index.mjs /tmp/wallie-launch-checks
node scripts/check-analytics-privacy.mjs /path/to/playwright/index.mjs /path/to/chrome
node scripts/check-deployed-sites.mjs ../onewallie-site ../wallie-cloud https://SITE_PREVIEW https://CLOUD_PREVIEW /tmp/wallie-deployed-checks.json
node scripts/verify-release.ts /tmp/wallie-release-consumer
```

The deployed check uses authenticated `vercel curl` GET requests. It does not
disable preview protection or send sign-in, checkout or account mutations. The
local static server is only a development approximation; actual Vercel checks
are separate because local 404 behavior cannot prove production routing.

From the linked Cloud repository, the production schema check is read-only:

```sh
vercel env run -e production -- npm run check:schema
```

It does not print connection credentials or customer rows. Environment values
stay in the child process. The current expected result is exit 1 naming the
missing channel migration and escrow column.

## Remaining release actions

The user's AGENTS instructions require confirmation before production changes.
The following actions are prepared, but have not been executed:

1. Apply Cloud's existing migration with `vercel env run -e production -- npm run migrate`,
   then run `check:schema` again. It must pass. Confirm authenticated ingestion and
   account overview after the schema is present. Real email/alert delivery needs
   an explicitly approved recipient; do not send test mail to a customer.
2. Release the reviewed website and Cloud branches to their production domains.
   Repeat the deployed GET checks against the public domains. Enable Vercel Web
   Analytics for both projects and confirm receipt using a synthetic public page
   view without query data.
3. Merge the reviewed AllowanceKit changes to a clean `main`, release 0.6.0 for
   `allowance-kit`, `wallie` and `wallie-mcp`, publish its tag and create the GitHub
   release. Repeat the advertised clone/install path against the registry. No
   video assets are part of this release action. The reviewed
   [release notes](../submission/RELEASE-v0.6.0.md) are ready for `gh release create`
   after the tag and packages are published.
4. Add the owner's approved postal contact address.
5. Implement the owner's selected tokenized-stock flow and update the entry with
   that user problem, working demo and existing-work disclosure. The current
   submission document explicitly remains a Stocklana draft.

The release script requires clean `main` and an unused `v0.6.0` tag. Its dry run
only prints commands; it is not release validation. It tags before npm publication
and cannot safely be rerun after partial publication. If interrupted, inspect
each registry version, publish only missing packages from the exact tagged
commit, then push the tag. Do not bump versions or overwrite a published package
to recover a partial release. The script does not create a GitHub release; that
is a separate prepared hand-in step.

Videos and the final portal submission remain with the owner. The event deadline
is **18 September 2026, 22:00 Europe/Amsterdam**.
[Official Stocklana event](https://hackathons.solana.com/hackathons/stocklana).
