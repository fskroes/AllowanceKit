# Security policy

`allowance-kit` (a.k.a. `wallie`) is a spend-control runtime: its whole job is to
stop an AI agent from spending money it should not. A hole in it can cost real USDC,
so security reports are taken seriously and answered quickly.

## Reporting a vulnerability

Email **hello@onewallie.com** with:

- what the issue is and the impact you see (over-spend, a rail that can be bypassed,
  a key or secret leaking to disk or a log, replay of a payment, etc.),
- the smallest steps or proof-of-concept that reproduces it,
- the version or commit you tested (`allowance-kit --version`).

Please **do not open a public GitHub issue** for a vulnerability, and please do not
post it in Discussions. If you prefer an encrypted channel, say so in a first plain
email and we will arrange one.

You will get an **acknowledgement within 48 hours**. We will confirm the issue, agree
a disclosure timeline with you (90 days by default, sooner for anything actively
exploitable), fix it in a patch release, and credit you in the release notes and
`CHANGELOG.md` unless you ask us not to.

## Supported versions

Fixes land on the latest minor. Older lines are not back-patched — upgrade to the
supported line.

| Version | Supported |
| ------- | --------- |
| 0.4.x   | ✅        |
| < 0.4   | ❌        |

## Scope

In scope — anything that lets money move against the rules, or leaks a secret:

- **Money paths**: `chain.ts`, `seller.ts`, `payer.ts`, `live.ts`, `wallet.ts`,
  `reservations.ts`, `policy.ts`. A payment that settles twice, a rail
  (budget, per-call cap, velocity, host allowlist, approval, kill switch) that can be
  bypassed or raced, a reservation that can be double-spent.
- **Secret handling**: any path that writes a private key, an API key, or a control
  token to disk, a log, an alert payload, or a config file. The tool's promise is that
  keys live only in the environment — a break in that promise is in scope.
- **The local dashboard** (`dashboard-server.ts`): a mutation reachable without the
  control token, or the server binding beyond loopback.
- **The x402 wire handling**: a crafted 402 challenge or receipt that causes an
  over-payment, a signature over unintended data, or signing for the wrong chain.

Out of scope: vulnerabilities in the networks, facilitators (Coinbase CDP), RPC
providers or notification providers themselves; denial of service from a malicious
RPC/seller you chose to point the tool at (it is designed to fail safe, not to be
available); and anything requiring a private key you already hold.

## Handling secrets in a report

Never include a real private key, API key, or mnemonic in a report. Redact them. The
config files the tool writes (`notifications.json`, `mode.json`, `config.json`,
`ledger.jsonl`) are designed to be safe to paste into a bug report — if you find one
that is not, that itself is the vulnerability, so report it (redacted).
