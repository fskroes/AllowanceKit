# Wallie readiness and launch checklist

Checked 14 September 2026 against the live websites, GitHub, npm, Vercel deployment metadata, Solana devnet RPC, and three local repositories. This is an audit. No production changes, package publications, account emails, purchases, or new blockchain transactions were made.

**Verdict: not ready for Stocklana submission.** Solana payments work, but the inspected product does not demonstrate a tokenized-stock use case. The advertised submission page, videos, release tag, and versioned packages are also unavailable publicly.

## Product readiness

| Product | Confirmed | Remaining gap |
| --- | --- | --- |
| onewallie.com | Six public marketing/docs/legal pages load. Local Solana page passes SEO and desktop/mobile video checks. | Live `/solana`, `/solana.html`, `/media/pitch.mp4`, and `/media/walkthrough.mp4` return 404. Public sitemap omits the Solana page. |
| Wallie Cloud | Production deployment includes SOL-08 channel events and escrow watchdog. All 84 local tests and typecheck pass. Sign-in and welcome pages load. | Signed-in channel ingestion, database migration state, watchdog execution, and alert delivery were not exercised in production. |
| AllowanceKit | Public main already contains Solana exact and upto support. Local 0.6.0 has accounting/recovery fixes and a working offline MCP demo. Recorded devnet settlement independently verified. | Public main/package remain 0.5.1; advertised 0.6.0 tag/packages do not exist. No stock-specific product flow found. Exact through the live facilitator is not independently proven. |

Stocklana is about products that improve owning or using tokenized stocks on Solana. Its judges assess the user/problem, a working complete demo, the reason for Solana, and execution. Deadline: **18 September 2026 at 22:00 Europe/Amsterdam (20:00 UTC)**. One entry per team, with at least one repository/demo/video link. The three components can support one entry. These are the event's public rules, not a guarantee of eligibility. [Official event](https://hackathons.solana.com/hackathons/stocklana), [requirements research](stocklana-requirements-2026-09-14.md).

The current submission calls itself “Wallie: Solana Agentic Payments”; its portal note references that different hackathon. No Stocklana, tokenized-stock, equity-token, or stock-specific application was found by the repository reader. This is a product-fit finding, not an organizer rejection. Source: [submission](../submission/README.md), especially lines 1–24 and 142–146. Existing-work eligibility and authenticated submission terms remain unverified.

## Public delivery blockers

| Advertised resource | Observed result |
| --- | --- |
| [Solana demo page](https://www.onewallie.com/solana.html) | HTTP 404; `/solana` also 404. |
| [Three-minute pitch](https://www.onewallie.com/media/pitch.mp4) | HTTP 404. |
| [Five-minute walkthrough](https://www.onewallie.com/media/walkthrough.mp4) | HTTP 404. |
| [v0.6.0 source tag](https://github.com/fskroes/AllowanceKit/tree/v0.6.0) | HTTP 404; GitHub tags stop at v0.5.1. |
| [v0.6.0 release](https://github.com/fskroes/AllowanceKit/releases/tag/v0.6.0) | HTTP 404; authenticated GitHub releases API returns an empty list. |
| [Runtime registry version](https://registry.npmjs.org/allowance-kit/0.6.0) | HTTP 404. `npm view allowance-kit version` reports 0.5.1. |
| [MCP registry version](https://registry.npmjs.org/wallie-mcp/0.6.0) | HTTP 404. `npm view wallie-mcp version` returns E404 for the package itself. |

These exact links/install commands appear in [the submission hand-in table and judge quickstart](../submission/README.md), lines 55–86, and `/Users/fskroes/dev/onewallie-site/solana.html`, lines 113–130. `git clone --branch v0.6.0` cannot reproduce this entry today. Publishing to npm is not an event requirement, but the advertised installation path must work.

GitHub default branch is `main` at `05354248bbecd93b7f38fb056e5520c65abbcaec`, version 0.5.1. The local checkout is `fix/solana-submission-ready` at `09fb60b9ab284ca70d15b09d0895e5d982472ee8`, version 0.6.0. Its remote branch is at `f7a81cc30ebf4f202f06f735ad0ebc7e69212377`, so the checkout was one commit ahead. Do not confuse public Solana support with public availability of the final fixes.

The 0.6.0 validation record describes reproduced failures involving missing settlement ledger entries, prematurely released uncertain escrow, and authorization after corrupt channel state. The current branch contains fixes and regression coverage; the passing suite validates this branch. See [VALIDATION.md](../submission/VALIDATION.md), lines 27–41. `SECURITY.md`, lines 25–33, also still lists 0.4.x as supported and needs release alignment.

The static site's committed media manifest fetches from the missing v0.6.0 release. Local matching media exists, so local playback succeeds. A clean environment that needs those downloads cannot restore them until the release assets exist. Sources: `/Users/fskroes/dev/onewallie-site/submission-media.json:3` and `scripts/restore-media.mjs:15-20`.

## Cloud deployment and chain evidence

Vercel's read-only deployment API confirms that production deployment `dpl_AirRtj3UyAEZPGPuTDBnSf7uoXgn`, created at **15:40:16 CEST on 14 September**, is READY and serves `app.onewallie.com` and `api.onewallie.com`. Its GitHub commit is `3e7e5124841feda34e122c026210eba5ef64e685`, “SOL-08 accept channel events and add the escrow watchdog”. This supersedes the older September 9 deployment record. Deployment success does not itself verify the database migration or an actual alert delivery.

The current marketing deployment inspected through `www.onewallie.com` is `dpl_EdAhZo64qjKVEPw1Q4srnqejH2Bc`, created 9 September. The site's local `main` and `origin/main` are at `5f66bdb` and contain the Solana page. The live route tests establish that this page is not being served from the public domain.

Read-only `getTransaction` against `https://api.devnet.solana.com`, with finalized commitment, returned the recorded settlement at slot **498173798**, with no transaction error. Token balances show 0.10 devnet USDC in escrow before settlement, 0.03 credited to the seller, and 0.07 returned to the buyer. The escrow token account is closed afterward. [Explorer transaction](https://explorer.solana.com/tx/Yqw1ZRcG4DHBhhrh4zkkpT1QXHT9CosHC2PfK6vg5hwPCCAyP6GzVz5dBMMGEnkvwaqWjNC8kceR2LnWdjnmVRx?cluster=devnet), [canary record](../canary-runs/2026-09-14-solana-devnet-upto.md).

This confirms a historical devnet settlement. It does not prove mainnet readiness, a stock transaction, ongoing production health, or the separate live exact facilitator path. The local MCP demo uses offline fixtures for its Solana segment and should retain that label.

## Launch checklist

Marketing scope: `/`, `/cloud.html`, `/docs.html`, `/x402-spending-limits.html`, `/privacy.html`, `/terms.html`. Cloud scope: `/`, `/overview`, `/key`, `/events`, `/alerts`, `/billing`, `/welcome`. The checklist applies to these websites; AllowanceKit's package readiness is assessed above. A pass on existing pages does not cover the missing Solana page.

| Item | Marketing website | Cloud account app |
| --- | --- | --- |
| Custom 404 page | **Missing.** Unknown route returns Vercel's plain NOT_FOUND response. | **Missing.** Same generic response. |
| Meta title on every page | **Pass:** all six live pages have page-specific titles. | **Pass:** all seven page HTML responses have titles. |
| Meta description on every page | **Pass:** all six. | **Pass:** all seven. |
| CTA above the fold | **Pass:** homepage and Cloud offer CTA visible at tested widths. | **Pass:** sign-in action visible. |
| Favicon set | **Pass:** SVG returns 200. | **Pass:** embedded SVG favicon on all pages. |
| robots.txt | **Pass:** 200, allows public pages, references sitemap. | **Absent:** 404. All seven pages use noindex; a separate robots file is optional here. |
| sitemap.xml | **Partial:** valid, covers the six live pages; missing Solana page. | **Not needed for private/noindex app pages:** 404. |
| Open Graph image | **Pass:** declared on all six pages; image returns 200. | **Absent:** no OG metadata. Optional for account utility pages. |
| Alt text on every image | **Pass:** the one HTML image, dashboard screenshot, has descriptive alt text. | **Not applicable:** no HTML img elements found. |
| Mobile breakpoints | **Partial:** other inspected pages fit; tutorial document is 705px wide at 360px and 390px viewports. | **Partial verification:** sign-in fits all tested widths, welcome fits 390px; authenticated layouts were not verified with real account data. |
| Sticky mobile CTA | **Pass:** Cloud subscription button stays in the sticky header at 360px and 390px. No separate bottom CTA bar. | Welcome has sticky Sign in. A persistent sales CTA is not needed on account utility screens. |
| Loading states | Static marketing content: no async submission flow. | **Pass for sign-in:** disabled Sending button verified. Other page states exist in source; real authenticated operations not exercised. |
| Form error states | No current marketing forms. | **Partial:** empty input, request failure, expired-link states exist; malformed email gets a generic request failure rather than a format-specific message. |
| Thank-you page | Purchase flow delegates to Cloud. | **Present:** `/welcome` returns 200. Sign-in success also shows an inline check-inbox message. Actual checkout redirect not exercised. |
| Privacy policy page | **Present:** `/privacy.html` returns 200 and is linked. | Policy covers Cloud, but account pages contain no direct privacy link. |
| Terms and conditions | **Present:** `/terms.html` returns 200 and is linked. | Terms cover Cloud, but account pages contain no direct terms link. |
| Cookie banner | **Absent, conditional non-issue:** no tracking requests observed. | **Absent:** source documents an essential session cookie. See condition below. |
| Analytics installed | **No:** intentional no-analytics policy. | **No:** no analytics code or requests found. |
| Real contact address | **Partial:** `hello@onewallie.com`, Eames trading as 1YC, Netherlands. No street/postal address found. | Contact appears on account footers, but mailbox delivery was not tested. No postal address found. |
| Compressed images | **Partial optimization:** dashboard PNG is 476,533 bytes, 1600×1058, reused on mobile with no srcset or WebP/AVIF alternative. PNG is compressed, but delivery can improve. | **Not applicable:** no HTML images. |

Cookie-banner applicability depends on what is actually stored and why. For strictly necessary cookies, the Dutch regulator says consent is not required. Based on the inspected no-tracking implementation, an absent banner is not a launch blocker. Reassess if nonessential tracking is added. This audit verifies page presence and observed behavior, not complete legal compliance. [Dutch regulator guidance](https://www.autoriteitpersoonsgegevens.nl/actueel/foute-cookiebanners-aangepast-na-ingrijpen-ap), [published privacy policy](https://www.onewallie.com/privacy.html).

## Browser findings and limits

- Live Chromium checks used widths **360, 390, 768, and 1440**; phone height 844, larger-view height 1000. The tutorial overflows at both phone widths. Its progress panel and content extend beyond the viewport. Relevant source: `/Users/fskroes/dev/onewallie-site/assets/wallie.css:465` and `:541`, `/Users/fskroes/dev/onewallie-site/docs.html`.
- The marketing header's sticky CTA was separately verified after scrolling at both 360 and 390 pixels. Initial automated sampling occurred before scroll position settled, so the targeted check is the basis for the pass.
- Live sign-in disables native validation with novalidate and only checks nonempty email. Browser interception showed `invalid-email` reaches the request path, then a generic failure appears. Server source rejects malformed email with HTTP 400 before sending: `/Users/fskroes/dev/wallie-cloud/api/v1/auth/magic-link.ts:13-24`. UI source: `public/index.html:36-40,82-99`.
- Sign-in loading, success, request failure, and invalid input were tested with intercepted API responses. No email was sent. These checks validate UI states, not live mail delivery.
- Signed-out overview/key/events/alerts redirect to sign-in and produce expected API 401 responses, plus an uncaught `unauthenticated` page error. The redirect works, but promise handling can be cleaned up. These errors are not evidence that the signed-in backend is broken.
- No marketing-page runtime errors or failed assets were observed. Third-party requests observed were Google Fonts only. Decorative clipping in the homepage's moving event strip is intentional; it was not counted as the tutorial overflow defect.
- Billing, payment, account mutation, sign-in delivery, the Stripe checkout return, and Cloud alert sending were not executed. Account HTML metadata was checked independently of JavaScript redirects.

Raw audit artifacts are local, outside the repository: `/tmp/wallie-launch-audit/report.json`, `/tmp/wallie-live-audit-initial.json`, `/tmp/wallie-live-audit-cloud-meta.json`, `/tmp/wallie-solana-transaction-audit.json`. Browser procedure: `/tmp/wallie-launch-audit.mjs`. Screenshots include `/tmp/wallie-launch-audit/docs-390.png` and `/tmp/wallie-launch-audit/home-390.png`. No screenshot/video binaries were added to git.

## Validation run

| Repository | Check | Result |
| --- | --- | --- |
| AllowanceKit | Focused Solana tests, four files | 21 passed, 2 sandbox tests skipped, 0 failed. |
| AllowanceKit | `npm test` | 226 passed, 3 opt-in sandbox tests skipped, 0 failed. |
| AllowanceKit | `npm run build` | Pass. |
| AllowanceKit | `npm run demo:mcp` | Pass; practice rail and offline Solana flow. |
| AllowanceKit | `npm pack --dry-run` | Pass; 68 files listed. No publication. |
| Wallie Cloud | `node --test test/ingest.test.ts test/watchdog.test.ts` | 13 passed, 0 failed. |
| Wallie Cloud | `npm test` | 84 passed, 0 failed. |
| Wallie Cloud | `npm run typecheck` | Pass. |
| Marketing site | `python3 scripts/check-seo.py` | Pass for seven local pages, including Solana. |
| Local submission site | Existing `scripts/check-submission-site.mjs` | Pass at 1440×1000 and 390×844: page route, heading, no overflow, video duration/playback/seeking/captions, FAQ, clipboard fallback. |

The full AllowanceKit suite skipped **three**, not seven, opt-in sandbox tests. No new live-chain canary was run. Local browser playback does not validate the public URLs, which returned 404.

Post-run tracked status is unchanged: Cloud retains the user's existing `.gitignore` modification, and the marketing site is clean. Only `docs/research/` audit notes were added in AllowanceKit.

## Order of work before submission

1. Implement and demonstrate one tokenized-stock user flow that uses the Solana payment controls. Update the pitch and submission for Stocklana; disclose the existing toolkit and the work added for this event.
2. Review and publish the final 0.6.0 code, tag, packages, and release media so the exact judge quickstart succeeds in a clean environment.
3. Deploy the submission site and verify the public page, both videos, versioned source links, and sitemap from a fresh browser.
4. Verify Cloud's database migration and one authenticated channel-to-monitoring flow, including the expected escrow/alert behavior, before claiming complete hosted support.
5. Fix tutorial mobile overflow, add custom 404 pages, improve email-format feedback, add direct legal links in Cloud, and optimize the dashboard image. Decide whether analytics and a published postal contact address are required for the intended launch. Do not add a cookie banner merely to tick a box.
6. Check the authenticated Stocklana form and existing-work terms, then submit one entry before 18 September at 22:00 CEST.
