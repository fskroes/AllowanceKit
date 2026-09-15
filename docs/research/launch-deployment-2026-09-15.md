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
```

Vercel CLI 54.20.1 merges local dotenv and parent environment values over the
downloaded production environment. Running directly from a checkout can select
a different database. The runner constructs a clean temporary Vercel link,
excludes dotenv files and clears inherited `DATABASE_URL`. Credentials remain
inside the child process. Both the original and isolated checks reported the
missing migration before it was applied; the isolated check passed afterward.

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

## Deployment status

- Cloud PR #2 merged as `ceb40858f5a310032606ff3551cc34f99e3aac54`.
- Website PR #2 merged as `d80710d8408d1e00df5d9abcd1d37f68ceac1150`.
- Production website/domain checks and npm publication are in progress.
- No email, checkout or Stocklana portal submission was sent.
