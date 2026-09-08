# Changelog

All notable changes to `allowance-kit` (published on npm as `allowance-kit`, and
under the `wallie` alias) are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Money-path changes (`chain`, `seller`, `payer`, `live`, `wallet`, `reservations`,
`policy`) are called out because they decide whether real USDC can move safely.

## [Unreleased]

## [0.5.1] - 2026-09-08

Runtime follow-ups that Wallie Cloud needs (RELEASE-PLAN ticket C-10). Ships as
`0.5.1` via `scripts/release.sh 0.5.1`; the cloud keeps accepting 0.5.0 clients
that send none of the below.

### Added

- **`threshold` cloud events.** The `cloud` channel now sends a `threshold` event
  on every 50/80/100 % allowance crossing (not just the human alert), so the cloud
  feed has the budget rows and its "budget 100 %" SMS has something to fire on.
  These are cloud-only, on the same fire-once-per-crossing high-water logic; the
  local threshold alert is unchanged.
- **Heartbeat carries `version`.** `createAgent` and `createLiveAgent` now include
  the runtime version (the value `--version` prints) in the cloud heartbeat, so the
  control plane can show which runtime an agent is on. Resolved once from
  `package.json` via the new `src/version.ts`.
- **`doctor` reports the cloud row.** When the `cloud` channel is enabled, `doctor`
  now shows whether `WALLIE_CLOUD_KEY` is set and whether `GET /v1/me` answers. It
  is a warning, never a failure, so `doctor`'s exit code still turns only on the
  wallet key.

### Fixed

- **`Retry-After` is honoured on a cloud 429**, bounded to 60 s (0.5.0 ignored it
  and used its own backoff). Other channels are unaffected.

## [0.5.0] - 2026-09-07

Working toward `0.5.0` — "mainnet-proven": a CLI front door for real money, x402
version compatibility, and release hygiene.

### Added

- **Real money is reachable from the CLI, without writing code.** `init --live
  [--network base-sepolia|base] [--rpc <url>]` derives the payer address from
  `AGENT_PRIVATE_KEY` (read from the environment only — never written to disk),
  marks the directory live, and prints the funding instruction. Before this, only
  code calling `createLiveAgent` could mark a directory live.
- **`pay <url> [--method] [--body]`** runs `payingFetch` for the directory's mode
  and prints the outcome: exit `0` on a paid call, `2` on a policy block, `1` on error.
- **`doctor`** checks Node version, `viem`, the wallet key, RPC reachability,
  state-dir permissions and configured alert channels; exits non-zero on a broken setup.
- **Mainnet guardrails.** On Base mainnet, `init --live --network base` requires a
  typed confirmation (or `--yes` for scripts), a top-up over $50 requires `--yes`, and
  every `policy` change prints a `REAL MONEY` reminder.
- **x402 v2 alongside v1 in the buyer.** `payingFetch` detects the version from
  `x402Version` (in the `PAYMENT-REQUIRED` header or the body), reads the challenge from
  wherever the seller put `accepts[]` (v2 often leaves the body empty), and answers in
  kind — `PAYMENT-SIGNATURE`/`PAYMENT-RESPONSE` headers, the `amount` field, CAIP-2
  networks (`eip155:8453` ↔ `base`), and the nested v2 payload. v1 is untouched.
- `docs/x402-compat.md` — primary-sourced findings on x402 v1 vs v2 that drove the above.
- Continuous integration (`.github/workflows/ci.yml`): build, pack and audit on Node
  20.11 / 22 / 24, full test suite on 24.
- This `CHANGELOG.md` and a `SECURITY.md`; annotated git tags for every past release.

### Known

- **No real third-party seller has been paid yet.** The v2 buyer is proven against
  in-repo mock sellers built from the recorded live wire shapes (`docs/x402-compat.md`
  §4), not yet against a live seller on the network — that canary run (ticket L-02's
  acceptance test) needs a funded testnet wallet and is not recorded in
  `docs/canary-runs/` yet.
- **The `CdpFacilitator` v2 body is written but not round-tripped against real CDP** —
  it needs CDP credentials and a signed payload to verify. It defaults to v1.
- **Mainnet has never been exercised.** The buyer path is proven on Base Sepolia only.

## [0.4.0] — 2026-08-29

The release that makes real money work, and makes a "yes" stop meaning "yes, forever".

### Changed

- **Breaking — approval grants expire and have a budget.** `approve <id>` now covers
  exactly the amount approved, for 24 hours, and draws down as payments authorize
  against it. Previously a single yes was a standing licence for that host and price.
  `--budget <usd>` and `--expires <30m|2h|7d|never>` widen it deliberately;
  `decideApproval(rt, id, true, { budgetMicro, expiresInMs })` is the SDK equivalent.
- **Breaking** — `PolicyRule` gained `insufficient_funds`; exhaustive `switch`
  statements over it need a new arm.
- **Breaking** — `topUp`, `decideApproval` and `allowanceRemaining` take
  `AllowanceRuntime` (a live agent and a practice agent both satisfy it). `AgentRuntime`
  extends it and still carries `chain: MockChain`.
- **Breaking** — `ApprovalStore`, `PolicyStore` and `NotifyStore` take an optional
  agent name and scope themselves to it.

### Fixed

- **A live agent could not be funded at all.** `topUp()` reached for the mock chain's
  faucet, which a live runtime does not have, so it threw — and every real payment was
  refused as `budget_exhausted` against a $0.00 allowance. It now records the ceiling
  without a faucet.
- **The CLI told a live directory it was practice money.** `init`, `topup` and `status`
  printed "no real money can move" over an allowance governing real USDC. A directory is
  now marked when `createLiveAgent` claims it, and every reader says
  `REAL MONEY — payments settle in USDC on <network>`.

### Added

- **The wallet is reconciled against the chain.** A live agent reads its real USDC
  balance over JSON-RPC and refuses payments the wallet cannot cover
  (`insufficient_funds`) before signing. Cached 15s, fail-open.
- **`network` is a hard constraint on a live agent.** A seller quoting a different chain
  is refused before anything is signed. Defaults to `base-sepolia`.
- **SMS and push.** `notify sms <e164>` over Twilio, `notify push <topic>` over ntfy.
- **Alerts are retried and failures recorded** — three attempts with backoff, none on a
  401, the rest logged to `notify-failures.jsonl` and surfaced by `notify` and `status`.
- **`notify heartbeat <url>`** — a dead-man's switch pinged while the dashboard runs.
- **Several agents per state directory** — `--agent <name>` everywhere, per-agent limits,
  and `allowance-kit agents` to list them.
- `scripts/canary.ts --buyer [--network base]` — the buyer runtime end to end.
- New exports: `AllowanceRuntime`, `listAgents`, `modeOf`, `readMode`, `writeMode`,
  `describeMode`, `describeTopUp`, `usdcBalanceMicro`, `BalanceCache`, `RPC_DEFAULTS`,
  `RpcError`, `startHeartbeat`, `DEFAULT_GRANT_TTL_MS`, `policyFileName`, `TWILIO_ENV`,
  and the `DecideOptions` / `DeliveryResult` / `DeliveryFailure` / `ModeInfo` /
  `SettlementMode` types.

## [0.3.0] — 2026-08-28

### Added

- **Notifications.** `notify webhook`, `notify email`, `notify test`, `notify off`.
  Alerts fire at 50/80/100% of the allowance, on every block, and on every payment
  queued for a human. Webhook payloads carry a Slack/Discord-shaped `text` field plus
  flat structured detail. Email goes over Resend or Postmark's REST API; the key is read
  from the environment and never written to disk. New exports: `NotifyStore`, `Notifier`,
  `deliver()`, `defaultNotifyConfig`, `providerEnvVar()`, and the `NotifyConfig` /
  `NotifyEvent` / `NotifyMessage` types. `AgentRuntime` gained `notifyStore`.
- **The CLI answers to the name you typed.** Run it as `wallie` and every hint says
  `npx wallie`; run it as `allowance-kit` and they say `npx allowance-kit`. The dashboard
  follows the same name.
- The dashboard's Settings panel shows where alerts go, or says nobody is told.

`wallie` on npm is an alias for this package: same CLI, same SDK, the name
[onewallie.com](https://onewallie.com) uses.

## [0.2.0] — 2026-08-28

### Changed

- **Breaking** — `totalBudgetUsd` is now **enforced**. An agent funded above its
  configured budget stops at the budget. Previously the field was display-only.
- **Breaking** — `PolicyStore.save()` throws `PolicyValidationError` on unknown fields,
  wrong types and negative amounts. Previously typos were written silently.
- **Breaking** — `PaidResult` gained a required `quotedMicro`; `blockedBy.rule` narrowed
  from `string` to the `PolicyRule` union and gained `recoverable`.
- **Breaking** — `buildPolicyRails()` requires `stateDir` (it owns the lock and the
  reservation store).
- `recordPayment` / `recordBlocked` may return a promise.

### Added

- `topUp()`, `DEFAULT_AGENT_NAME`, `RULE_LABELS`, `POLICY_FIELDS`,
  `validatePolicyPatch()`, `policyWarnings()`, `effectiveBudgetMicro()`,
  `ReservationStore`, `runDemo()`, and `allowance-kit` as a second bin name.

### Fixed

- Parallel `payingFetch` calls can no longer overspend the velocity or budget rails.
- Seller-rejected payments now set `error`, log a `settlement_rejected` ledger row and
  release the hold.
- `init` prints real file paths; the dashboard allowance meter measures the allowance
  instead of the spend.

## [0.1.1] — 2026-08-26

### Added

- First npm publish: the SDK entry point (`allowance-kit`), the Coinbase CDP facilitator
  adapter for sellers, and the live-network payer.

## [0.1.0] — 2026-08-25

### Added

- Initial release: the buyer-side allowance runtime for x402 — `payingFetch`, the policy
  rails (budget, per-call cap, velocity circuit breaker, host allowlist, kill switch),
  the append-only audit ledger, and practice-money settlement on a local mock chain.

[Unreleased]: https://github.com/fskroes/AllowanceKit/compare/v0.5.1...HEAD
[0.5.1]: https://github.com/fskroes/AllowanceKit/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/fskroes/AllowanceKit/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/fskroes/AllowanceKit/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/fskroes/AllowanceKit/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/fskroes/AllowanceKit/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/fskroes/AllowanceKit/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/fskroes/AllowanceKit/releases/tag/v0.1.0
