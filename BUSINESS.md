# Business model

Open-source core ([the repo](README.md)) drives distribution and trust. Monetization on top:

1. **Hosted Allowance Cloud** — multi-agent allowances for teams/orgs: SSO, webhooks (block alerts → Slack), spend analytics, fiat top-up via card. €20/mo per workspace + 1% of settled volume past free tier.
2. **Compliance pack** — EU AI Act Art. 26 evidence exports (signed ledger digests, policy-version-at-tx-time attestation), retention policies. Enterprise pricing.
3. **Facilitator revenue share** — default hosted facilitator routes through CDP-style settlement; share of the ~$0.001/tx facilitator economics at scale.

The wedge is precise: sellers already have x402 middleware; **nobody owns the moment a human says "here's $5, go work" and stays in control.**

## Open pricing questions

- **Settled 2026-08-28: the price is €20/mo.** The Stripe button always charged euros; the pricing card and this document said dollars. All three now agree. Revisit if a US-heavy campaign makes dollar pricing worth the second Stripe product.
- Notifications shipped in 0.3.0 as webhook and email, in the open-source core. What stays paid is the part a laptop cannot do: **hosted alerting that fires when your machine is off**, plus SMS and escalation. Free alerts only work while the agent is running somewhere you control — which is exactly the gap Cloud sells against.
