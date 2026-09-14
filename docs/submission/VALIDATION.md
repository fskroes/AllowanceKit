# Submission validation, 14 September 2026

Prepared version: **0.6.0** for `allowance-kit`, `wallie`, and `wallie-mcp`.

| Check | Result |
|---|---|
| Full `npm test` | 226 passed, 3 environment-gated tests skipped, 0 failed |
| Final channel regression suite | 33 passed, 0 failed |
| TypeScript build | Passed |
| Offline MCP demo | Exact purchase, spending block, metered $0.03 charge and $0.07 refund passed |
| Fresh npm consumer | All three tarballs installed; SDK and chain imports, CLI alias and demo, MCP stdio discovery, budget and channels passed |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities |
| Website metadata and local links | 7 pages passed the existing site checker |
| Desktop and mobile browser QA | 1440px and 390px; no horizontal page overflow or page errors |
| Video playback | Both videos played and sought successfully in Chrome |
| Video format | H.264, yuv420p, AAC, 1280×720, faststart; full FFmpeg decode passed |
| Video duration | Pitch 180.000 seconds; walkthrough 300.000 seconds |
| Accessibility checks | Captions, transcripts, keyboard focus, skip link, reduced motion, FAQ controls and clipboard failure message |
| Fresh public devnet canary | $0.10 deposited, $0.03 charged, $0.07 refunded; finalized, no transaction error |
| Actual chain-history recovery | One ledger payment, zero remaining escrow; repeated recovery does not duplicate the payment |

The full suite's skipped tests require explicit live/sandbox configuration. They
are not counted as passes. A fresh live devnet canary was run separately against
the prepared code; see
[the readiness canary record](../canary-runs/2026-09-14-solana-devnet-readiness.md).

## Bugs reproduced and fixed

The initial regression command failed three cases: settled money missing from the
ledger, missing account data releasing a still-uncertain deposit, and corrupt
channel state permitting authorization. Those cases now pass.

Additional regressions cover a crash before or after each accounting write,
repeated grant refunds, a changed watermark during reclaim, recovery without
Cloud, wrong-network history, switching a Solana allowance to Base, account-owner
validation, and adversarial finalized-history evidence.

The independent review found two network-scope defects and a treasury-account
owner regression during implementation. All three received failing tests and
were fixed before the final suite. The reviewer found no remaining concrete
accounting defect in the reviewed scope.

Seller tests exercise automatic worker startup, restart persistence, failed
cleanup retries, expiry, duplicate prevention, concurrent state writes,
corruption, explicit CLI sweeps, and shutdown after accepted requests finish.

## Failure behavior

Channel settlement writes the durable ledger entry before releasing escrow. A
crash can temporarily count both the payment and its still-held deposit; that
reduces available allowance. The next authorization or recovery completes the
idempotent sequence. It cannot turn the interrupted payment into free allowance.

Incomplete, pruned, or unsupported chain history leaves the deposit held. This is
visible unresolved escrow. Recovery trusts the selected RPC's finalized responses;
operators must configure an RPC for the selected network. Existing escrow remains
counted when the allowance's network changes.

The seller uses the library's atomic settlement and cleanup. A failed atomic
claim can leave an open channel. Cleanup follows expiry and abandon-close rules,
returns the unused deposit, and does not replay a failed charge.

## Release boundary

These checks validate the prepared source, npm tarballs, and staged website.
Publishing the packages and updating the production aliases are separate release
actions. Public URL verification must run after those actions. No hackathon entry
is claimed as submitted by this report.
