# AllowanceKit 0.6.0: Solana payments and channel recovery

This release prepares `allowance-kit`, `wallie` and `wallie-mcp` at version 0.6.0.
It adds Solana exact payments and metered `upto` channels to the allowance tools,
with the same spending controls exposed through the SDK, CLI, dashboard and MCP.

- Settled payments and grant refunds enter the durable ledger before escrow is
  released. Repeating recovery does not duplicate a payment or refund.
- Missing or incomplete finalized evidence leaves uncertain deposits held.
  Network checks and validated channel snapshots prevent recovery from treating
  funds on another network, or corrupt state, as available allowance.
- Seller cleanup starts automatically, persists public channel facts, retries
  according to the program's expiry/refund rules and drains work on shutdown.
- Cleanup corrects the pinned library's Sealed/Closing mapping and retains
  pending deposit records until finalized absence past the signed open window.
- The offline MCP demo exercises a purchase, a blocked over-budget request and a
  metered payment. Fresh-consumer checks install and run all three npm packages.

Use Node 24 or later to run the source demo:

```sh
git clone --branch v0.6.0 --depth 1 https://github.com/fskroes/AllowanceKit.git
cd AllowanceKit
npm ci
npm run demo:mcp
```

No keys or funded wallets are required. The Solana part uses an offline seller
operator; it is separate from the public devnet proof.

Validation: 231 tests passed, 3 opt-in sandbox tests skipped; TypeScript build and
fresh installation checks passed. The recorded readiness canary deposited $0.10,
charged $0.03 and returned $0.07 in finalized devnet settlement at slot 498210157.
Recovery against the actual chain history recorded one payment and released the
resolved escrow. [Canary details](https://github.com/fskroes/AllowanceKit/blob/v0.6.0/docs/canary-runs/2026-09-14-solana-devnet-readiness.md).

This evidence covers devnet metered settlement. It does not establish mainnet
production traffic or a live Solana exact payment through CDP. Unavailable chain
history can keep escrow held until sufficient finalized evidence is available.
MCP approval tools require a trusted administrative client.

Cloud operators must apply `002_channels.sql` and run `npm run check:schema`
before using hosted escrow overview and heartbeats. This package release does not
apply a hosted database migration.

The [demo page](https://www.onewallie.com/solana.html) leads with the runnable
offline demo. Submission videos are deferred. The Stocklana entry remains a draft
until a tokenized-stock use case is implemented and demonstrated.
