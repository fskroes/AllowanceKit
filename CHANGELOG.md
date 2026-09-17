# Changelog

All notable changes to `allowance-kit` (published on npm as `allowance-kit`, and
under the `wallie` alias) are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Money-path changes (`chain`, `seller`, `payer`, `live`, `wallet`, `reservations`,
`policy`) are called out because they decide whether real USDC can move safely.

## [Unreleased]

## [0.7.1] - 2026-09-17

Re-publish of 0.7.0. `allowance-kit@0.7.0` registered on npm but never became
installable, so `wallie@0.7.0` and `wallie-mcp@0.7.0` could not resolve their
`allowance-kit` dependency. 0.7.1 ships the same code across all three packages;
there are no source changes from 0.7.0.

## [0.7.0] - 2026-09-17

Behavior-derived attestation turns the agent's private audit ledger into a
signed, portable reputation claim, and takes the trust model all the way to
chain-anchored: a seller can verify **what the agent did** (payments, on-chain)
and **who the agent is** (ERC-8004 registry) without trusting the Wallie brand.

### Added

- **Behavior attestation core (`src/attestation.ts`).** `summarize` (pure,
  zero-dep), `attest` / `attestFromLedger`, and `verifyAttestation` compress the
  ledger into a counts-only summary and sign it with an EIP-712 envelope over a
  keccak256 digest of the canonical JSON. Hosts, urls, and per-payment amounts
  never leave the agent. viem is a lazy optional peer, so the core stays
  dependency-free.
- **Issuer + seller wiring.** `runtime.attest()` on `LiveAgentRuntime`
  (`src/live.ts`) signs a claim from the agent's own ledger with the payer key,
  so the payer address is the identity. `requireAttestation(policy, handler)`
  and `attestationOf(req)` (`src/attestation-gate.ts`) let a seller gate a route
  on cheap floors (`minPayments`, `agents` allowlist, `accept()`, `maxAgeSecs`,
  ...), with `bindToPayer` closing the copied-attestation replay gap.
- **v2 on-chain payment re-check (`src/attestation-chain.ts`).**
  `verifyAttestationOnChain` / `enforceOnChain` confirm each opt-in evidence
  `txHash` has a `success` receipt carrying an ERC-20 `Transfer` **log** whose
  `from` is the agent (USDC when the network is known). Reading the log, not
  `tx.from`, is what makes it correct for x402's facilitator-relayed EIP-3009
  settlement.
- **v2 ERC-8004 registry identity (`src/attestation-identity.ts`).**
  `verifyAttestationIdentity` / `enforceIdentity` resolve the agent's opt-in
  `registryAgentId` against the on-chain Identity Registry and confirm the
  attesting address is the agent's `getAgentWallet` or `ownerOf`. Canonical
  registry addresses ship as defaults (`ERC8004_IDENTITY_REGISTRY`, Base +
  Base Sepolia). `isContractRevert` walks the viem cause chain so an RPC outage
  propagates instead of being misread as "not registered".
- **Tests, demo, docs.** 59 attestation tests
  (`test/attestation{,-gate,-chain,-identity}.test.ts`), a no-network end-to-end
  `demo/attestation.ts` (issue, verify, tamper, on-chain re-check, registry
  resolve), and `docs/attestation.md`. All exported from `src/index.ts`.

## [0.6.0] - 2026-09-15

The Solana rail and submission package (tickets **SOL-01 … SOL-10**) add a
second chain family — `exact` payments symmetric with Base, and a self-facilitated `upto`
payment-channel scheme for metered calls — behind the same allowance runtime, rails, ledger
and cloud. `@x402/svm` and `@solana/kit` are optional peers, lazy-loaded; a Base agent never
resolves them. All entries below are grouped newest ticket first.

### Added

- **Submission pack (SOL-10).** Reproducible pitch and walkthrough sources under
  `demo/submission/`, hand-in text and proof links under `docs/submission/`, and
  an installable `wallie-mcp` package with its chain libraries. The release flow
  publishes `allowance-kit`, `wallie`, and `wallie-mcp` together.
- **Fresh-consumer release check.** `node scripts/verify-release.ts` packs all
  three packages, installs them in a temporary project, and exercises SDK imports,
  the CLI alias, the CLI demo, and MCP tool discovery over a real stdio transport.
- **Persistent seller cleanup.** The library's cleanup worker starts at seller
  initialization, saves only public channel facts, resumes after restart, and
  stops through `gate.stop()` or `operator.stop()`. `channels sweep --seller`
  provides an explicit recovery command. Atomic claim failures leave channels
  recoverable under the program's expiry and refund rules.
- **Seller cleanup state and deposit recovery fixes.** Correct the pinned
  `@x402/svm@2.25.0` cleanup enum through its public signer override. Raw Sealed
  channels finish distribution; Closing channels wait. Record the signed open
  slot in the pre-broadcast index and require finalized absence beyond its
  replay window before cleanup can remove a pending deposit.

- **Solana canary + compat docs (SOL-09).** `scripts/canary-solana.ts` is the Solana twin
  of `scripts/canary.ts`: phase A proves the `upto` buyer, rails and escrow book hermetically
  (no network, no keys); phase B settles a real channel on the 402.surfnet.dev sandbox with a
  real signature via the free faucet; phase C settles on public devnet (`--devnet`) or mainnet
  (`--network solana`, the human step), reading the buyer key from `AGENT_PRIVATE_KEY` and
  printing a paste-ready `docs/canary-runs/` record. First recorded run:
  `docs/canary-runs/2026-09-13-solana-surfnet-sandbox.md` (metered $0.03 of a $0.10 ceiling,
  on-chain `settled == $0.03`, wallet delta exactly $0.03, $0.07 refunded). `docs/x402-compat.md`
  §10 documents, from each facilitator's own `/supported`, that hosted facilitators settle
  Solana `exact` only and none settles Solana `upto` — the reason the seller self-facilitates.
  `docs/GLOSSARY.md`'s Solana section is updated from "planned" to shipped.

- **Cloud channel events + escrow watchdog (SOL-08).** Solana `upto` escrow is now
  a first-class thing the cloud and the dashboard track. A new `channel`
  `CloudEventKind` carries every phase — `opened`, `settled`, `refunded`,
  `orphaned`, `reclaimed` — with the deposit, settled and refund amounts, so the
  feed sees locked money the moment it locks. The cloud heartbeat gains
  `escrowedMicro`, so the overview shows locked value without an event. The local
  dashboard grows an "In escrow" card and a channels table (status, host, deposit,
  settled, refund, age) with a token-gated reclaim button; its state tick
  reconciles open channels against the chain and emits `orphaned` once each. The
  buyer runtime emits `opened`/`settled`/`refunded` inline, and `channels
  reconcile`/`sweep`/`reclaim` emit `orphaned`/`settled`/`reclaimed`. On the cloud
  (`~/dev/wallie-cloud`): `channel` joins `INGEST_KINDS` (routine phases are
  feed-only, `orphaned` alerts, email + SMS), the escrow watchdog raises
  `escrow_stale` for a deposit opened and never resolved past N minutes (default
  10), and the account overview + event feed surface escrow. An older client is
  still accepted unchanged.

- **MCP server (SOL-07).** A new `allowance-kit/mcp` subpath and the `wallie-mcp`
  bin serve the allowance runtime over the Model Context Protocol (stdio), so an
  MCP client pays x402 APIs inside the same policy rails, ledger and escrow book.
  Five tools: `pay_fetch`, `get_budget`, `list_channels`, `decide_approval`
  (§8's `approve`/`deny` as one decision), and `reclaim_channel`. The server binds
  one runtime, resolved from the state dir exactly as the CLI resolves it (live vs
  practice from `mode.json`, the key from `AGENT_PRIVATE_KEY`), so `pay_fetch`
  settles `exact` or `upto` per offer without the caller choosing a scheme.
  `@modelcontextprotocol/sdk` is an optional peer, loaded lazily — importing
  `allowance-kit` never pulls the MCP stack in, only `allowance-kit/mcp` does.
  New: `src/mcp.ts`, `src/mcp-bin.ts` (`allowance-mcp` bin), the `wallie-mcp`
  alias package, and `demo/mcp-agent/` — an offline example agent whose transcript
  shows an `exact` buy, a ceiling block in `RULE_LABELS` language, and a Solana
  `upto` buy that settles below its ceiling and refunds the rest.

- **Policy rails understand escrow and the ceiling (SOL-06).** The `upto` scheme adds a
  third money state next to spent and reserved — `escrowedMicro`, USDC locked in an open
  channel — and the context carries `scheme` and the escrow figure. `spendable` subtracts
  escrow (`allowanceRemaining == budget − spent − reserved − escrowed`); every rail (per-call
  cap, velocity, budget, balance, approval) evaluates the **ceiling**, not the eventual charge;
  a grant draws down by the ceiling and is credited back by `refundMicro` when the seller
  settles below it; and the kill switch refuses new channel opens, not just `exact` sends.

- **Buyer `upto` (SOL-05).** `encodePaymentSolanaUpto` builds and partially signs the `open`
  with zero RPC when the offer `extra` pins the blockhash and slot; `selectOffer` gained a
  scheme preference (`exact` if it fits the per-call cap, else `upto` if the ceiling fits);
  the channel row is written under the state-dir lock **before** the deposit is sent, so a
  send that fails after the header leaves is recoverable; the receipt resolves the channel to
  `settled`/`refunded`/`unknown`; `PaidResult` gained `channelId` and `refundMicro`. An
  over-reporting seller is clamped to the deposit, never trusted.

- **Seller `upto`, self-facilitated (SOL-04).** `src/seller-upto.ts` wraps
  `@x402/svm/upto` server + facilitator so `paymentGate` can offer a metered call with no
  hosted facilitator: a `Meter` (`meter.charge`, clamped to the ceiling), a `beforeServe`
  hook, a refund (`amount: "0"`) when the handler throws or never charges, and rent cleanup
  (`channels sweep`). Keys are configured by env-var name, never value. `doctor --seller`
  checks the treasury ATA. Money-path tests: settles once, replay rejected, insufficient
  deposit rejected, hook blocks.

- **Channel primitives and store (SOL-03).** A zero-dependency `voucher` codec (50 bytes,
  byte-exact to the spec, `node:crypto` Ed25519) and `ChannelStore` (`channels.json`, under
  the state-dir lock; statuses `opened|settled|refunded|unknown|orphaned|reclaimed`) with
  `escrowedMicro`. `reconcileChannels` reads each PDA over JSON-RPC and flips a non-terminal
  row to its on-chain state; `reclaimChannel` runs the payer escape path (three transactions,
  needs SOL). CLI: `channels list|reconcile|reclaim <id>|sweep`. The `payment` ledger row
  gained `scheme`, `depositMicro`, `refundMicro`, `channelId`, and `audit` prints them.

- **Solana `exact` seller through CDP (SOL-02).** `advertise` returns an array; a Solana
  entry uses the mint as `asset` and carries `extra.feePayer` from the facilitator's
  `/supported`, with no EIP-712 `extra`. `CdpFacilitator` passes the CAIP-2 network in its v2
  bodies. The v1 Base path is byte-identical.

- **Solana rail, `exact` buyer (SOL-01).** `@x402/svm` and `@solana/kit` as optional peers;
  `SOLANA_NETWORKS` (both CAIP-2 ids, v1 names, USDC mints, default RPCs, token program);
  `solanaSigner` (a `TransactionPartialSigner` from a `node:crypto` Ed25519 seed);
  `usdcBalanceMicroSolana` over plain JSON-RPC; `encodePaymentSolanaExact`; `createLiveAgent`
  branches by network family; `selectOffer` resolves Solana ids; new `doctor` rows. A Base
  agent proves, in a test, that `@solana/kit` is never resolved.

### Fixed

- **Recovered payments remain spent.** Channel recovery records settlement in
  the ledger before releasing escrow. Channel identifiers make repeated receipt,
  reconciliation, and grant-refund processing idempotent across process restarts.
- **Unknown channel outcomes cannot reset an allowance.** Missing account data
  is checked against finalized transaction history. Incomplete evidence keeps
  deposits held. Sealed channels retain their unsettled escrow, and reclaim
  rereads the watermark after the grace period.
- **Corrupt channel state blocks authorization.** Channel files use validated
  schemas and atomic replacement; malformed data is an error, not an empty book.
- **Pinned Solana Kit compatibility.** The optional peer now stays on the
  tested 5.x major instead of accepting every future major.

- **Lockfile install of the Solana peer tree.** `@x402/svm` pins its own nested
  `@solana-program/token-2022`, whose `@solana/*` peers must sit where that nested
  copy can resolve them; the lockfile now records them there, so `npm ci` (what CI
  runs) reproduces a working Solana `upto` tree instead of a half-hoisted one.

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

[Unreleased]: https://github.com/fskroes/AllowanceKit/compare/v0.7.1...HEAD
[0.7.1]: https://github.com/fskroes/AllowanceKit/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/fskroes/AllowanceKit/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/fskroes/AllowanceKit/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/fskroes/AllowanceKit/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/fskroes/AllowanceKit/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/fskroes/AllowanceKit/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/fskroes/AllowanceKit/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/fskroes/AllowanceKit/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/fskroes/AllowanceKit/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/fskroes/AllowanceKit/releases/tag/v0.1.0
