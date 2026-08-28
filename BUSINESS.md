# Business model

Open-source core ([the repo](README.md)) drives distribution and trust. Monetization on top:

1. **Hosted Allowance Cloud** — multi-agent allowances for teams/orgs: SSO, webhooks (block alerts → Slack), spend analytics, fiat top-up via card. $20/mo per workspace + 1% of settled volume past free tier.
2. **Compliance pack** — EU AI Act Art. 26 evidence exports (signed ledger digests, policy-version-at-tx-time attestation), retention policies. Enterprise pricing.
3. **Facilitator revenue share** — default hosted facilitator routes through CDP-style settlement; share of the ~$0.001/tx facilitator economics at scale.

The wedge is precise: sellers already have x402 middleware; **nobody owns the moment a human says "here's $5, go work" and stays in control.**

## Open pricing questions

- The landing page's Stripe button reads **€20/mo** while the pricing card and this document say **$20/mo**. Pick one currency and make all three agree before the next campaign.
- Notifications (email/SMS on 50/80/100% of allowance, on every block, on every queued approval) are the most obviously chargeable feature and are not built yet. They are also the difference between a dashboard someone has to watch and a guardrail that works overnight.
