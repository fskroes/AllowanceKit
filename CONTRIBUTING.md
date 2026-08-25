# Contributing to AllowanceKit

Thanks for helping build the trust layer for agentic payments.

## Dev setup

```bash
git clone https://github.com/fskroes/AllowanceKit.git && cd AllowanceKit
npm run demo          # full scenario, no deps beyond Node ≥ 24
```

That's it — zero dependencies, TypeScript runs natively on Node ≥ 24.

## Ground rules

- **Zero runtime dependencies is a feature.** If you need one, argue why in the PR description.
- **Money paths get tests before merge.** Any change touching `chain.ts`, `seller.ts`, or `payer.ts` must demonstrate: happy path settles exactly once, replay is rejected, insufficient funds are rejected.
- **No secrets, ever.** Mock settlement stays deterministic and local. Real-facilitator adapters read keys from env only.
- **Wire compatibility:** changes to `types.ts` must keep x402 v1 shapes intact unless a spec version bump is part of the PR.

## Good first issues

Look for issues labeled `good first issue` — usually docs, dashboard polish, or additional policy rules in `policy.ts`.

## Reporting security issues

Please do NOT open public issues for payment-handling vulnerabilities. Email hello@onewallie.com with details; we'll credit you in the release notes.
