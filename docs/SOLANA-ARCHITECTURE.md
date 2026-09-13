# Solana rail and payment channels: architecture

Written 2026-09-13 against `main` at `84e75ba` (`allowance-kit@0.5.1`, 96 tests green).
This is the work order for adding a **Solana rail** and the **x402 `upto` payment-channel
scheme** to allowance-kit, Wallie Cloud and onewallie.com. It is written for implementing
agents. Nothing in it is implemented yet. Terms in *italics* on first use are defined in
[GLOSSARY.md](GLOSSARY.md) (section "Solana and payment channels").

Evidence behind every decision lives in `docs/spikes/`:

- [2026-09-13-solana-research.md](spikes/2026-09-13-solana-research.md): hackathon state,
  program facts, `upto` and MPP wire shapes, facilitator support, sandbox, IDs, signing.
- [2026-09-13-spike-paykit-vs-handroll.md](spikes/2026-09-13-spike-paykit-vs-handroll.md):
  hands-on install and API spike of `@solana/pay-kit`, `@x402/svm`, `@solana/kit`.
- [2026-09-13-spike-payment-channels-program.md](spikes/2026-09-13-spike-payment-channels-program.md):
  the on-chain program, instruction by instruction, from a clone of the repo.

Read those before you change a decision here. Change decisions in section 2, not in tickets.

---

## 0. How to work from this document

Same rules as [RELEASE-PLAN.md §0](RELEASE-PLAN.md): zero runtime dependencies in
`allowance-kit` (optional peers, lazy `import()`, like `viem` today in `src/live.ts:172-181`),
tests are `node --test "test/*.test.ts"`, every money path adds tests for "settles exactly
once, replay rejected, insufficient funds rejected, the rail blocks", no secret on disk,
plain-English user text, v1 wire shapes untouched.

Two rules that are new here:

- **The EVM path must not change behaviour.** Every ticket's "done when" includes "the 96
  existing tests pass and a Base agent never loads `@solana/kit`".
- **Escrow is a third money state.** Today money is *spent* or *available*. A channel
  deposit is neither until the seller settles. Every ledger, policy, dashboard and Cloud
  change in this plan has to show escrowed money as its own number. Do not fold it into
  "spent".

Ticket format is the RELEASE-PLAN one: `ID Title.` owner · size · depends · files · body ·
*Done when:*. Sizes: S under half a day, M one to two days, L three or more.

---

## 1. Facts this plan stands on (verified 2026-09-13)

**Hackathon.** "Agentic Payments" on hackathons.solana.com is `status: funding`, $0 of $50k,
no dates, no tracks, no sponsors, no rules, 21 registrations. It launches only when sponsors
escrow ~$50k, then a two-week build window. Two hackathons are ahead of it in the queue.
Build this because Solana x402 volume is real, not for the event. Recheck the page before
committing calendar time.

**The program.** Solana Payment Channels, program id
`CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX`, repo
`github.com/solana-foundation/payment-channels`, MIT, Cantina audit report dated
2026-07-27. Deployed on **mainnet-beta, devnet and the 402.surfnet.dev sandbox** with the same
programData address (RPC-confirmed). Upgrade authority is one bare key per cluster (different keys on mainnet and
devnet), not burned, no multisig statement. Nine instructions: `open`, `settle`, `topUp`,
`settleAndSeal`, `requestClose`, `seal`, `distribute`, `withdrawPayer`, `reclaim`. There is
no `voucher` or `refund` instruction. A *voucher* is 50 signed bytes read from an Ed25519
precompile instruction placed directly before `settle`/`settleAndSeal`. A refund is
`settleAndSeal(has_voucher=0)` then `distribute`, or the payer path `requestClose`, wait
*grace period*, `seal`, `withdrawPayer`. Channel state is 256 bytes; the fields that matter
to us are `deposit`, `settled` (the watermark), `grace_period`, `payer`, `payee`,
`authorized_signer`, `mint`, `open_slot`, `status` (OPEN 0, SEALED 1, CLOSING 2,
DISTRIBUTED 3).

**Voucher.** Exactly 50 bytes: `[0x56,0x01] || channel PDA (32) || cumulative u64 LE (8) ||
expires_at i64 LE (8, 0 = none)`. **Cumulative, not delta.** No nonce. Replay is prevented
by the strict `settled < cumulative <= deposit` watermark and by `open_slot` being a PDA seed.
Ed25519, signable with `node:crypto` alone.

**x402 `upto` on Solana** (spec `specs/schemes/upto/scheme_upto_svm.md` in
`x402-foundation/x402`). Three facts that overturn last session's mental model:

1. **One channel per HTTP request.** `upto` is "open, serve one request, settle and seal".
   It is not "open once, sign many vouchers". The many-voucher streaming shape is *MPP
   session*, a different protocol with different headers. Out of scope by decision (§2.2).
2. **The buyer never signs a voucher.** The buyer signs the `open` transaction only. The
   **seller's** `receiverAuthorizer` key signs the single voucher for the metered amount.
   The buyer's authorization is the deposit; the seller's honesty is bounded by it.
3. **No hosted facilitator supports Solana `upto` today.** CDP, x402.org and PayAI all
   answer `exact` only for Solana (`/supported` checked live). The spec allows the seller to
   use its own key as `feePayer`. So Wallie's seller must **self-facilitate**: run the
   `@x402/svm/upto/facilitator` code in-process with a hot key that holds SOL.

The `accepts[]` entry: `scheme: "upto"`, CAIP-2 `network`, `amount` (ceiling at verify,
actual at settle), `asset` (mint), `payTo` (cold wallet, 100% of the distribution),
`maxTimeoutSeconds`, and `extra { paymentFlow: "escrow", feePayer, receiverAuthorizer,
withdrawDelay, tokenProgram, recentBlockhash, recentSlot }`. `feePayer` becomes the channel
`payee` and `rent_payer` and co-signs `open`; `receiverAuthorizer` becomes
`authorized_signer`; `withdrawDelay` becomes `grace_period`. The `PAYMENT-SIGNATURE`
payload is `{ from, maxAmount, deposit, channelId, expiresAt, validAfter, nonce, openSlot,
authorizedSigner, openTransaction (base64 v0 tx, payer signed, feePayer unsigned), type:
"deposit" }`. Constraint: `deposit == maxAmount == accepts.amount`. Refund is the seller
settling with `amount: "0"`. `PAYMENT-RESPONSE` carries `{ success, payer, transaction,
network, amount }` where `amount` is what was actually charged.

**x402 `exact` on Solana.** Payload is `{ transaction: base64 }`: a v0 transaction with
compute-budget, `TransferChecked` and memo, payer signed, `extra.feePayer` unsigned. CDP
supports it on mainnet and devnet (API key). x402.org's facilitator supports devnet `exact`
free, no key. The buyer needs USDC and **no SOL**.

**IDs.** USDC mint mainnet `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, devnet
`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`. CAIP-2 mainnet
`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, devnet `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`.
v1 bare names `solana`, `solana-devnet`. (Last session wrote `EQnzfwaE…` for devnet. That
string appears in no package. Do not use it.)

**Libraries.** `@x402/svm` 2.25.0 (Apache-2.0, 65k weekly downloads, peer `@solana/kit
>=5.1`) ships the buyer `exact` and `upto` schemes, the seller `upto` scheme, the in-process
`upto` facilitator, the vendored program client, PDA derivation and the voucher codec.
Minimal install with `@solana/kit`: 36 MB, 52 packages, no peer warnings. `@x402/core` is
type-only for us: a resolve-hook test proved that importing `@x402/svm`, its client and
facilitator subpaths loads no `zod`, `viem`, `mppx` or `ox`. `@solana/pay-kit` 0.10.0 (276
weekly downloads, created 2026-06) pulls `mppx` and through it `viem` (72 MB), vendors a
stale `@x402/svm` 2.23.0, and has no hook between verify and settle. Its channel operator
code is private to `createPayKit`. The `@payment-channels/client` package in the program
repo is **not on npm** (404). `@solana/kit` is zero-dep and uses native WebCrypto Ed25519.
A `node:crypto` Ed25519 key injected as a `TransactionPartialSigner` produced a valid
`exact` payload and a valid `upto` `open` payload in the spike, zero RPC calls for `upto`.

**Sandbox.** `https://402.surfnet.dev:8899` is a hosted Surfpool mainnet fork (genesis =
mainnet, so CAIP-2 mainnet id) with the program and mainnet USDC. Faucet verified live:
`requestAirdrop` and `surfnet_setTokenAccount [owner, mint, {amount}]`, no auth. Reset
cadence undocumented. Local equivalent: `@solana/surfpool` 1.5.0.

---

## 2. Decisions

### 2.1 Build on `@x402/svm` + `@solana/kit` as optional peers. Not on `@solana/pay-kit`. Not hand-rolled.

Fernando's first lean was pay-kit. Both were spiked. The result:

| | `@solana/pay-kit` | `@x402/svm` (+ `@solana/kit`) | hand-roll |
|---|---|---|---|
| What it is | MPP-first server framework (gates, catalogue, sessions) | the x402 Solana mechanism package pay-kit itself wraps | our own v0 tx compile, base58, PDA on-curve check, Codama layouts |
| x402 `upto` operator | private `X402Upto` adapter, only via `createPayKit` | public `upto/facilitator` `settle()` deposit and claim paths | ~800-1200 LOC (estimate), breaks silently on program upgrade |
| Hook between verify and settle | none at adapter level | `onAfterVerify {abort}` in core; or one line in our own `paymentGate` | ours |
| Weight | 298 MB, 250 pkgs, `viem` via `mppx` | 36 MB, 52 pkgs | 0 |
| Maturity | 0.10.0, 276 dl/week, vendors stale svm 2.23 | 2.25.0, 65k dl/week, Apache-2.0 | n/a |
| Signer injection | needs full kit `KeyPairSigner` | plain `{address, signTransactions}`; `node:crypto` proven | ours |

pay-kit adds nothing over `@x402/svm` for x402 except a 30-line usage meter. It is the
right library for *MPP session*, which is out of scope (§2.2). **Reversal condition:** if
§2.2 is reopened and MPP session is wanted, revisit pay-kit for the session half only; the
x402 half stays on `@x402/svm` either way.

Shape: `@x402/svm` and `@solana/kit` become `optionalDependencies`-style peers exactly like
`viem` (`peerDependencies` + `peerDependenciesMeta.optional`). A new `src/solana.ts` lazy
imports them. A Base agent never touches them. `doctor` reports them like it reports `viem`.

### 2.2 Scope is `upto` only. MPP session is deferred.

Fernando's decision. `upto` is the x402 path, matches the existing two-phase
`payingFetch` flow, and is what the hackathon brief names first. MPP session needs a second
protocol surface (`WWW-Authenticate: Payment`, `Authorization: Payment`, `Payment-Receipt`),
client-signed cumulative vouchers, an idle-timeout state machine and `distributionSplits`.
Revisit after `upto` ships, with the question "does any buyer we can name need streaming?"
Everything in this plan that touches channel state is written so that a session later adds
rows, not tables: the *channel store* already records `settled` as a cumulative watermark.

### 2.3 Wallie's seller self-facilitates `upto`.

Forced by fact 3 in §1. The seller process holds two hot keys: `feePayer` (SOL for fees
and rent, co-signs `open`, is the channel `payee`) and `receiverAuthorizer` (signs the one
voucher). Both from env, never disk. `payTo` stays the cold wallet. When a hosted
facilitator adds Solana `upto`, `paymentGate` gains a `facilitatorUrl` option and the
in-process path becomes the fallback; the `Facilitator` interface in `src/chain.ts` does not
change.

### 2.4 One env var for the key, format by network.

`AGENT_PRIVATE_KEY` stays the name. For an EVM network it is the 32-byte hex key as today.
For a Solana network it is the 64-byte secret as **base58** (what Phantom exports) or a JSON
array of 64 bytes (what `solana-keygen` writes). `normalizePk` grows a Solana branch; `doctor`
names the expected format per network. No second env var.

### 2.5 The buyer keeps zero SOL for the happy path and needs dust SOL for the escape path.

`exact` and `upto` `open` are fee-paid by the seller side. The payer escape path
(`requestClose`, `seal`, `withdrawPayer`) needs the payer to sign and someone to pay fees.
Nobody else will. So `channels reclaim` requires ~0.01 SOL in the agent wallet, `doctor`
warns when it is absent on a Solana network, and the docs say so in the first paragraph
about channels. This is a product fact, not a bug.

### 2.6 The MCP server is a separate package.

`packages/wallie-mcp` depends on `allowance-kit` and `@modelcontextprotocol/sdk`. The
zero-dep rule holds for `allowance-kit`; the MCP package is a thin adapter and may have
deps. Published as `wallie-mcp` (the `wallie` alias pattern, see `packages/wallie/`).

### 2.7 Test rail: sandbox first, devnet second, mainnet by canary only.

Unit tests need no network. Integration tests run against `402.surfnet.dev` (or a local
`@solana/surfpool`) gated by `SOLANA_SANDBOX=1`. One live devnet test is gated by
`AGENT_PRIVATE_KEY` + `SOLANA_NETWORK=solana-devnet` like `test/live-money.test.ts` is
gated today. Mainnet is a recorded canary run in `docs/canary-runs/`, never CI.

---

## 3. Target architecture

### 3.1 Runtime, after this plan

```
 human ── CLI (allowance-kit / wallie) ── local dashboard ── channels view (locked value)
              │
              ▼
      .allowance/  config.json · ledger.jsonl · reservations · channels.json (NEW)
              │
              ▼
 agent ──▶ payingFetch(ctx, url) ── policy rails ── reservation ── sign ── settle
  │  │                                   │                            │
  │  │   402 (v1|v2) with accepts[]      │ rail: EVM  → EIP-3009 via viem (unchanged)
  │  │   selectOffer picks by chain,     │ rail: Solana exact → v0 tx via @x402/svm (NEW)
  │  │   then by scheme preference       │ rail: Solana upto  → open tx + channel store (NEW)
  │  ▼                                   ▼
  │ MCP server (packages/wallie-mcp) ── tools: pay_fetch · get_budget · list_channels · approve
  │
  ▼
 seller: paymentGate(opts, handler)
   ├─ exact: verify → settle via Facilitator (CDP for Solana exact, MockChain for practice)
   └─ upto (Solana): settleDeposit (co-sign open, broadcast) → policy hook → handler with meter
                     → settleClaim(actual) or refund(0) → PAYMENT-RESPONSE     (self-facilitated)

 Notifier ──▶ human channels · Cloud: kinds payment · blocked · approval · threshold · channel (NEW)
 Wallie Cloud ──▶ escrow watchdog: "deposit unsettled > N min" alert (NEW) · channels in dashboard
```

### 3.2 Module map

New files. Everything else is an edit at a named seam.

| File | Role | Loads Solana libs? |
|---|---|---|
| `src/solana.ts` | Solana network table (`SOLANA_NETWORKS`: CAIP-2, v1 name, USDC mint, default RPC, token program), `normalizeSolanaKey`, `solanaSigner(seed)` (a `node:crypto` Ed25519 `TransactionPartialSigner`), `usdcBalanceMicroSolana` (plain JSON-RPC `getTokenAccountBalance`, no lib), `encodePaymentSolanaExact`, `encodePaymentSolanaUpto`. Lazy imports `@x402/svm` and `@solana/kit` inside the encode functions only. | yes, lazily |
| `src/channels.ts` | `ChannelStore` over `.allowance/channels.json` (locked like reservations), `ChannelRecord`, transitions, `reconcileChannels(rpc)` (reads PDA status on-chain), `reclaimChannel` (requestClose / seal / withdrawPayer), `escrowedMicro(agent)`. | only in `reconcile`/`reclaim` |
| `src/seller-upto.ts` | the self-facilitated operator loop for `paymentGate`: advertise `upto`, `settleDeposit`, policy hook, `Meter`, `settleClaim`/refund, receipt. Wraps `@x402/svm/upto/facilitator` and `upto/server`. | yes |
| `src/voucher.ts` | 50-byte voucher encode/decode/sign/verify with `node:crypto`. Zero deps. Used by tests and by `seller-upto.ts` to double-check what the library signs. | no |
| `packages/wallie-mcp/` | MCP stdio server exposing the runtime as tools. | via allowance-kit |
| `test/solana-wire.test.ts`, `test/voucher.test.ts`, `test/channels.test.ts`, `test/seller-upto.test.ts`, `test/solana-sandbox.test.ts`, `test/solana-devnet.test.ts` | see §7 | last two, gated |
| `scripts/canary-solana.ts` | the Solana twin of `scripts/canary.ts` | yes |

Edited seams (exact lines as of `84e75ba`):

- `src/live.ts:44-60` `NETWORKS` stays EVM-only; `networkInfo()` at `:74` learns to answer
  Solana ids by delegating to `src/solana.ts`. `createLiveAgent` at `:160-275` branches on
  network family after `:183` (key parse) and before `:218` (balance) and `:233`
  (`encodePayment`). `selectOffer` at `:104-118` gains scheme preference (§4.2).
- `src/policy.ts:215-298` `evaluatePolicy`: two new inputs on the context, `escrowedMicro`
  and `scheme`; see §5 for the exact rail changes.
- `src/payer.ts:166` (`chooseOffer`), `:206` (authorize), `:243-246` (encode and send),
  `:270-287` (receipt): the `upto` branch records the channel before the send and resolves it
  from the receipt (§4.3).
- `src/seller.ts:16-34` `advertise` returns one entry today; it returns an array. `:73` and
  `:80` are verify and settle; the `upto` path goes through `src/seller-upto.ts` instead.
- `src/types.ts`: `AcceptsEntry` already has `extra`; add `UptoPayload`, `SolanaExactPayload`
  and `ChannelRecord` types. v1 shapes untouched.
- `src/notify.ts:59` `CloudEventKind` gains `"channel"`.
- `src/ledger.ts:4-10` `LedgerEvent`: the `payment` row gains optional `scheme`,
  `depositMicro`, `refundMicro`, `channelId`. No new kind.
- `src/cli.ts:31-51`: new subcommand `channels` (`list`, `reconcile`, `reclaim <id>`),
  `init --live --network solana-devnet`, `doctor` rows.
- `src/dashboard-server.ts` and `public/dashboard.html`: escrow number and channels table.
- `src/index.ts`: export the new public names (§8).

### 3.3 Money states

| State | Where it lives | Counted by |
|---|---|---|
| spent | ledger `payment` rows | budget, velocity (as today) |
| reserved | `reservations.json` (120 s TTL) | budget (as today) |
| **escrowed** | `channels.json` rows in status `opened` | budget (new), dashboard, Cloud |
| available | wallet USDC on-chain minus the three above | `insufficient_funds` rail |

Rule: `spendable = min(totalBudget, funded) − spent − reserved − escrowed`. A reservation
for an `upto` request converts into an escrow row when the `open` transaction is sent, and
the escrow row converts into a `payment` row (actual amount) plus a refund note when the
receipt arrives. The reservation TTL of 120 s does not apply to escrow; escrow has its own
clock, `withdrawDelay`.

---

## 4. Wire flows

### 4.1 Buyer, Solana `exact`

Same steps as Base today; only the encoder changes.

1. `payingFetch` preflight authorize, GET, 402, parse (v1 or v2), `chooseOffer`.
2. `selectOffer` keeps offers whose `network` resolves to the agent's network (CAIP-2
   `solana:…` or bare `solana`/`solana-devnet`) and whose `asset` is the USDC mint for that
   network. Cheapest `exact` wins unless §4.2 says otherwise.
3. authorize the exact amount, reserve.
4. `encodePaymentSolanaExact(signer, offer, unsigned)`: lazy import
   `@x402/svm/exact/client`, `new ExactSvmScheme(signer, { rpcUrl })`,
   `createPaymentPayload(2, offer)`. One `fetchMint` RPC call unless cached. If
   `offer.extra.recentBlockhash` is present, no blockhash call. The signer signs the v0
   message with `node:crypto`; `extra.feePayer` stays unsigned.
5. Header: v2 `PAYMENT-SIGNATURE` = base64 `{x402Version:2, resource, accepted: offer
   verbatim, payload:{transaction}}`. v1: same shape under `X-PAYMENT` with `x402Version:1`.
   The header codec stays ours (`src/payer.ts`), never `@x402/core/http`, so `zod` never
   loads.
6. Receipt parse unchanged. `txHash` is the Solana signature string from `transaction`.

### 4.2 Offer selection with two schemes

When a seller advertises both `exact` and `upto` for the same resource, prefer `exact`
when the quoted `amount` is at or below `perCallMaxUsd`, otherwise `upto` if its ceiling
fits the policy (§5). Reason: `exact` settles in one transaction with no escrow window.
Override with `LiveAgentOptions.preferScheme: "exact" | "upto"`. A policy field is not
added for this; it is a runtime option.

### 4.3 Buyer, Solana `upto` (one request, one channel)

```
agent            payingFetch                 seller (paymentGate + upto operator)      chain
  │ fetch(url)        │                                 │                                │
  │──────────────────▶│ GET ───────────────────────────▶│ 402 accepts[{upto, amount=CEIL, │
  │                   │◀────────────────────────────────│   extra{feePayer, receiverAuthorizer,
  │                   │                                 │   withdrawDelay, recentBlockhash…}}]
  │                   │ authorize(CEIL) → reservation   │                                │
  │                   │ build open tx (payer signed)    │                                │
  │                   │ ChannelStore.add(opened)  ◀── written BEFORE the send            │
  │                   │ PAYMENT-SIGNATURE {type:deposit, openTransaction…} ─────────────▶│
  │                   │                                 │ settleDeposit: verify open tx, │
  │                   │                                 │ co-sign feePayer, broadcast ──▶│ open
  │                   │                                 │ policy hook (beforeServe)      │
  │                   │                                 │ handler(req,res,meter)         │
  │                   │                                 │ meter.charge(ACTUAL ≤ CEIL)    │
  │                   │                                 │ sign voucher(ACTUAL) w/ receiverAuthorizer
  │                   │                                 │ settleClaim: ed25519 ix +      │
  │                   │                                 │ settleAndSeal + distribute ───▶│ 2 tx
  │                   │ 200 + PAYMENT-RESPONSE {amount:ACTUAL, transaction} ◀───────────│
  │                   │ recordPayment(ACTUAL), ChannelStore.settle(refund=CEIL−ACTUAL)  │
  │◀──────────────────│ PaidResult{costMicro:ACTUAL, quotedMicro:CEIL, channelId}       │
```

Failure branches the buyer must handle:

| Symptom | Buyer action |
|---|---|
| HTTP error before the seller could broadcast `open` (connection refused, 4xx other than 402) | `recordBlocked`/error, release reservation, `ChannelStore.drop` after `reconcile` confirms no PDA on-chain |
| Response arrives with `amount: "0"` | refund: `recordPayment(0)` is wrong; record a `payment` row with `amountMicro: 0`, `refundMicro: CEIL`, so the ledger shows the attempt |
| Timeout or 5xx after the send | channel status `unknown`; `reconcile` reads the PDA: absent → drop; SEALED/DISTRIBUTED → read `settled` from chain and record; OPEN → status `orphaned`, start the `withdrawDelay` clock, emit Cloud `channel/orphaned` |
| `orphaned` and `withdrawDelay` elapsed | `channels reclaim <id>`: `requestClose` → wait grace → `seal` → `withdrawPayer` (needs dust SOL, §2.5) |
| Kill switch flipped mid-request | no new opens; in-flight request finishes (the seller settles in seconds); `channels reconcile` runs on the next CLI/dashboard tick |

The buyer trusts the seller for the metered amount up to the ceiling. That is the protocol.
Wallie's added value is that the ceiling is policy-checked and the escrow is visible.

### 4.4 Seller, Solana `upto` (self-facilitated)

```ts
paymentGate({
  priceMicro: 10_000n,           // exact price, as today
  upto: { ceilingMicro: 100_000n, withdrawDelay: 900 },   // NEW: advertise upto too
  network: "solana-devnet",
  payTo: COLD_WALLET,
  facilitator: cdp,              // used for exact
  solanaOperator: {              // NEW: self-facilitation keys, env var names not values
    feePayerKeyEnv: "SELLER_FEE_PAYER_KEY",
    receiverAuthorizerKeyEnv: "SELLER_AUTHORIZER_KEY",
    rpcUrl: "https://api.devnet.solana.com",
  },
  beforeServe?: (p) => ({ abort: false }),   // policy hook between deposit and handler
}, async (req, res, meter) => {
  const units = await doWork();
  meter.charge(units * 1_000n);  // ACTUAL, capped at ceiling by the gate
  res.end(body);
});
```

Steps inside the gate for an `upto` header: decode; check `accepted` echoes our offer;
`settleDeposit` (library: verify the open tx shape and signers, simulate, co-sign as
`feePayer`, broadcast, wait confirmed; dedup on `channelId` for 120 s); `beforeServe`
hook; run handler with a `Meter`; on handler success `settleClaim(actual)`; on handler
throw or `meter` untouched, refund with `amount: "0"`; write `PAYMENT-RESPONSE`; call
`opts.facilitator`-style `onSettled` for the ledger. The gate must never charge for a
handler that threw. The gate runs `distribute` after `settleAndSeal` so rent returns to
`feePayer`; if `distribute` fails, a `RentCleanup` retry list persists in the seller's state
dir and `channels sweep` retries it (the library's `UptoSvmRentCleanupManager` does this;
wrap it, do not rewrite it).

The treasury ATA for the mint must exist or SEALED `distribute` fails (`docs/spikes/2026-09-13-spike-payment-channels-program.md` §1 and open
question 9). `doctor --seller` checks it.

---

## 5. Policy engine mapping

`evaluatePolicy` order today (`src/policy.ts:215-298`): kill switch, allowlist, blocklist,
per-call cap, velocity, budget, on-chain balance, then approval in the caller. Changes:

| Rail | `exact` (unchanged) | `upto` |
|---|---|---|
| `kill_switch` | refuse | refuse new opens; existing escrow untouched |
| host rails | as today | as today |
| `per_call_cap` | amount ≤ cap | **ceiling ≤ cap**. The buyer authorizes the ceiling; the seller can charge up to it |
| `velocity_circuit_breaker` | window sum of `payment` rows + this | window sum of `payment` rows + **escrowed rows opened in the window** + this ceiling. Counts opens, not vouchers (there is one voucher, signed by the seller) |
| `budget_exhausted` | spent + reserved + amount ≤ budget | spent + reserved + **escrowed** + ceiling ≤ budget |
| `insufficient_funds` | wallet ≥ amount | wallet ≥ ceiling (the deposit leaves the wallet at `open`) |
| `human_approval_required` | amount > threshold | ceiling > threshold. A grant for host H at budget B covers opens whose ceiling ≤ remaining grant |
| `settlement_rejected` | facilitator said no | seller's response missing or `success:false` after `open` was broadcast → not a block, an *orphan* (§4.3) |

New `PolicyContext` inputs: `escrowedMicro: bigint` (from `ChannelStore`) and
`scheme: "exact" | "upto"`. No new `PolicyRule` values: every refusal maps onto an existing
rule, with `detail` saying "ceiling" instead of "amount" where it applies, through
`RULE_LABELS`. `policyWarnings` gains one line: "perCallMaxUsd is below the smallest upto
ceiling any seller can advertise" is not knowable, so instead warn when `preferScheme:
"upto"` is set and `perCallMaxUsd` is under $0.01.

Refund accounting: `recordPayment(actual)` settles the reservation; the escrow row records
`refundMicro = ceiling − actual` so budget arithmetic returns the refund to *available* the
moment the receipt is parsed, not when `distribute` lands (the refund is on-chain within the
same seller settle step; if `distribute` fails the seller's rent cleanup retries; the
buyer's USDC is returned by `settleAndSeal`+`distribute` regardless of rent).

---

## 6. Wallie Cloud and dashboard

- **New `CloudEventKind` `"channel"`.** `data.phase` is one of `opened`, `settled`,
  `refunded`, `orphaned`, `reclaimed`. `data` carries `channelId`, `host`, `network`,
  `depositMicro`, `settledMicro`, `refundMicro`, `withdrawDelay`, `txHash`. Emitted after
  the lock, like every event. The cloud adds `"channel"` to `INGEST_KINDS` and stores it; the
  server adapts to the runtime (RELEASE-PLAN §3.1.1 rule).
- **Escrow watchdog.** Runtime side: `channels reconcile` runs from the dashboard tick and
  from `startCloudHeartbeat` every 60 s when any channel is `opened` or `unknown`; it emits
  `orphaned` once per channel. Cloud side: an alert rule "channel orphaned" (email + SMS) and
  a second rule "escrow unsettled longer than N minutes" computed from `opened` events with no
  matching `settled`/`refunded` within N (default 10 min). Heartbeat body gains
  `escrowedMicro` so the Cloud overview can show locked value without events.
- **Approval from a link** (RELEASE-PLAN X-01, still planned) covers channel opens once it
  exists, because the approval request is created before the open with the ceiling as the
  amount. No new endpoint is needed for channels.
- **Local dashboard.** One number "in escrow" next to spent and remaining; a channels table
  (id, host, deposit, settled, refund, status, age, reclaim button gated by the control
  token). Cloud account app: the same table under Events.

---

## 7. Test surface

| Test | Network | Gate | Proves |
|---|---|---|---|
| `test/voucher.test.ts` | none | always | 50-byte layout byte-exact against the spec vector; sign/verify with `node:crypto`; rejects wrong magic, cumulative ≤ settled, expired |
| `test/solana-wire.test.ts` | none | always | `SOLANA_NETWORKS` ids; `selectOffer` on a mixed Base+Solana `accepts[]`; v1 and v2 header shapes for `exact` and `upto`; `accepted` echoed verbatim; `EQnzfwaE` never appears |
| `test/channels.test.ts` | none | always | `ChannelStore` transitions, escrow arithmetic, `spendable` with escrow, orphan clock, reconcile against a fake RPC |
| `test/rails.test.ts` (extend) | none | always | each §5 row: ceiling vs cap, velocity counting opens, budget with escrow, approval on ceiling, kill switch blocks opens |
| `test/seller-upto.test.ts` | none | always | gate with a fake operator: deposit then claim settles once; handler throw refunds with `amount:"0"`; replayed `channelId` rejected; `beforeServe` abort refunds; `accepted` mismatch 402 |
| `test/solana-sandbox.test.ts` | 402.surfnet.dev or local surfpool | `SOLANA_SANDBOX=1` | full loop: faucet, buyer `exact` against our gate + x402.org devnet facilitator is not possible on the sandbox (mainnet genesis), so: buyer `upto` against our self-facilitated gate, actual < ceiling, on-chain `settled` equals actual, payer USDC = start − actual, orphan path with `withdrawDelay: 5` then reclaim |
| `test/solana-devnet.test.ts` | devnet | `AGENT_PRIVATE_KEY` + `SOLANA_NETWORK=solana-devnet` | buyer `exact` against a local gate settling through the free x402.org devnet facilitator; buyer `upto` against our gate; ledger asserted |
| `scripts/canary-solana.ts` | devnet, `--network solana` for mainnet | human | the Solana twin of `scripts/canary.ts`; result recorded in `docs/canary-runs/` |
| EVM regression | none | always | all 96 existing tests; plus one new test that a Base `createLiveAgent` never imports `@solana/kit` (resolve hook, like the spike) |

Local sandbox for CI: `@solana/surfpool` 1.5.0 with the mainnet program streamed in
(`streamAccount(PROGRAM)` pattern from pay-kit's harness), started by the test file when
`SOLANA_SANDBOX=local`. Pre-create the treasury ATA for USDC or `distribute` fails.

---

## 8. Public surface after this plan

New exports from `src/index.ts`: `SOLANA_NETWORKS`, `solanaSigner`, `usdcBalanceMicroSolana`,
`encodePaymentSolanaExact`, `encodePaymentSolanaUpto`, `ChannelStore`, `ChannelRecord`,
`reconcileChannels`, `reclaimChannel`, `encodeVoucher`, `decodeVoucher`, `signVoucher`,
`verifyVoucher`, `Meter`, `UptoGateOptions`. `LiveAgentOptions` gains `preferScheme?`,
`rpcUrl?` already exists. `PaidResult` gains `channelId?` and `refundMicro?`.

CLI: `init --live --network solana-devnet|solana`, `channels list|reconcile|reclaim <id>|sweep`,
`doctor` rows: "solana libs installed", "key format", "SOL for reclaim", "seller: treasury
ATA exists". `pay` unchanged (the scheme is chosen by the runtime).

MCP tools (`packages/wallie-mcp`): `pay_fetch(url, method?, body?)` → `PaidResult`;
`get_budget()` → spent, reserved, escrowed, remaining, window state; `list_channels()`;
`approve(id)` / `deny(id)`; `reclaim_channel(id)`. Stdio transport. One example agent in
`demo/mcp-agent/` that buys from two of the demo sellers, one `exact` and one `upto`, and
hits the ceiling once so judges see a block.

---

## 9. Tickets

Order: SOL-01 → SOL-02 → SOL-03 → SOL-04 → SOL-05 → SOL-06 → SOL-07 → SOL-08 → SOL-09 →
SOL-10. SOL-04 (seller) comes before SOL-05 (buyer `upto`) because no hosted party speaks
Solana `upto`; the buyer needs our seller to talk to. Minimum credible submission: SOL-01
through SOL-07. SOL-08 and SOL-09 make it a winner.

**SOL-01 Solana rail, `exact` buyer.** `agent` · M · depends: — · files `src/solana.ts`,
`src/live.ts`, `src/types.ts`, `src/index.ts`, `package.json`, `test/solana-wire.test.ts`.
Add `@x402/svm` and `@solana/kit` as optional peers. `SOLANA_NETWORKS` with both CAIP-2 ids,
v1 names, mints, default RPCs. `normalizePk` Solana branch (§2.4). `solanaSigner` from a
`node:crypto` Ed25519 seed as a `TransactionPartialSigner`. `usdcBalanceMicroSolana` via
plain JSON-RPC `getTokenAccountsByOwner`/`getTokenAccountBalance` on the USDC ATA, cached by
`BalanceCache`. `createLiveAgent` branches by network family. `selectOffer` resolves
Solana ids. `encodePaymentSolanaExact`. `doctor` rows. *Done when:* a fake 402 with a
Solana devnet `exact` offer produces a header whose decoded `transaction` has two required
signatures, payer signed, `extra.feePayer` unsigned, a `TransferChecked` to the seller ATA
for the exact amount; a Base agent test proves `@solana/kit` was never resolved; 96 + new
tests pass.

**SOL-02 Solana `exact` seller through CDP.** `agent` · S · depends: SOL-01 · files
`src/seller.ts`, `src/facilitator-cdp.ts`, `test/facilitator-cdp.test.ts`. `advertise`
returns an array; a Solana network entry uses the mint as `asset`, `extra.feePayer` from
the facilitator's `/supported`, no EIP-712 `extra`. `CdpFacilitator` passes the CAIP-2
network in v2 bodies. *Done when:* the gate answers a 402 with a Solana `exact` offer whose
`asset` is the devnet mint and settles a mocked CDP response; v1 Base path byte-identical.

**SOL-03 Channel primitives and store.** `agent` · M · depends: SOL-01 · files
`src/voucher.ts`, `src/channels.ts`, `src/ledger.ts`, `src/types.ts`, `src/cli.ts`,
`test/voucher.test.ts`, `test/channels.test.ts`. Voucher codec and sign/verify with
`node:crypto`, byte-exact to the spec. `ChannelStore` (`channels.json`, under the state-dir
lock, statuses `opened | settled | refunded | unknown | orphaned | reclaimed`),
`escrowedMicro`, `reconcileChannels` (RPC `getAccountInfo` on the PDA, decode offsets 3, 12,
20), `reclaimChannel` (three transactions, needs SOL), `channels list|reconcile|reclaim`.
`payment` ledger row gains `scheme`, `depositMicro`, `refundMicro`, `channelId`. *Done
when:* the spec's 50-byte vector round-trips; a channel walked through every status keeps
`escrowedMicro` correct; reconcile against a fake RPC flips `unknown` to the right terminal
state; `audit` prints deposit and refund columns.

**SOL-04 Seller `upto`, self-facilitated.** `agent` · L · depends: SOL-02, SOL-03 · files
`src/seller-upto.ts`, `src/seller.ts`, `src/demo-servers.ts`, `test/seller-upto.test.ts`.
Per §4.4. Wrap `@x402/svm/upto/server` and `upto/facilitator`; keys by env var name;
`Meter`; `beforeServe`; refund on throw; rent cleanup wrapped; `doctor --seller` treasury
ATA row. One demo seller (`demo-servers.ts`) advertises both schemes so the demo story has a
metered call. Money-path tests per CONTRIBUTING: settles exactly once, replay rejected,
insufficient deposit rejected, hook blocks. *Done when:* the gate test suite passes against a
fake operator, and `SOLANA_SANDBOX=1` runs one real open-serve-settle on 402.surfnet.dev
with on-chain `settled == actual`.

**SOL-05 Buyer `upto`.** `agent` · M · depends: SOL-03, SOL-04 · files `src/solana.ts`,
`src/payer.ts`, `src/live.ts`, `test/solana-wire.test.ts`, `test/solana-sandbox.test.ts`.
`encodePaymentSolanaUpto` (zero RPC when `extra` carries blockhash and slot), `selectOffer`
scheme preference (§4.2), the channel row written before the send, receipt → settle or
refund, the failure table in §4.3, `PaidResult.channelId`/`refundMicro`. *Done when:* the
sandbox test buys from the SOL-04 gate with ceiling $0.10 and actual $0.03, ledger shows
`amountMicro 30000, depositMicro 100000, refundMicro 70000`, wallet lost exactly $0.03, and
the orphan path with `withdrawDelay: 5` reclaims the deposit.

**SOL-06 Policy mapping.** `agent` · M · depends: SOL-05 · files `src/policy.ts`,
`src/wallet.ts`, `src/approvals.ts`, `test/rails.test.ts`. Every row of §5. `escrowedMicro`
and `scheme` on the context; `spendable` subtracts escrow; approval on the ceiling; grants
draw down by ceiling and refund by `refundMicro`; kill switch refuses opens. *Done when:*
one test per §5 row, and `allowanceRemaining` equals budget − spent − reserved − escrowed
with one open channel.

**SOL-07 MCP server and example agent.** `agent` · M · depends: SOL-05 · files
`packages/wallie-mcp/`, `demo/mcp-agent/`, `README.md`. §8 tools over stdio with
`@modelcontextprotocol/sdk`. The example agent is a script that drives the MCP server (no
LLM API; if a model is needed for the demo narrative, route through local Claude Code per
the house rule). *Done when:* `npx wallie-mcp` answers `tools/list` with the five tools and
the example agent's transcript shows one `exact` buy, one `upto` buy with a refund, and one
block with `RULE_LABELS` text.

**SOL-08 Cloud channel events and escrow watchdog.** `agent` · M · depends: SOL-05 ·
files `src/notify.ts`, `src/dashboard-server.ts`, `public/dashboard.html`,
`test/cloud.test.ts`; in `~/dev/wallie-cloud`: `lib/ingest.ts`, `lib/watchdog.ts`, `sql/`,
account app. §6 in full. *Done when:* the local cloud stub receives `channel` events in all
five phases; an `opened` with no `settled` within N minutes produces an alert row; the
dashboard shows escrow and the table; the 0.5.1 client is still accepted.

**SOL-09 Canary and docs.** `agent` + `human` · S · depends: SOL-06 · files
`scripts/canary-solana.ts`, `docs/canary-runs/`, `docs/x402-compat.md`, `CHANGELOG.md`,
`GLOSSARY.md`. Devnet canary run recorded; mainnet canary with $1 USDC is the human step.
Compat doc gains a Solana section with the `/supported` snapshots. *Done when:* a dated
canary file shows a devnet `upto` settle with a real signature, and CHANGELOG `[Unreleased]`
lists every SOL ticket.

**SOL-10 Site and hackathon pack.** `human` + `agent` · M · depends: SOL-09 · files in
`~/dev/onewallie-site`. Solana in positioning, a hackathon demo page, 3-minute pitch and
5-minute walkthrough videos (human), register on hackathons.solana.com (human, do it now,
it is free). *Done when:* the page is live behind the alias and both video links resolve.

---

## 10. Open questions (do not block SOL-01 to SOL-04)

1. Upgrade authority of the program is a bare key on both clusters. State it in the docs
   as a trust assumption; nothing we can change.
2. `@solana/kit` major skew: `@x402/svm` program clients pin kit 5 ranges; kit is at 8.3.
   The minimal install resolves to 5.5.1 cleanly. Pin the peer range to what `@x402/svm`
   declares and re-check on every `@x402/svm` bump.
3. Sandbox reset cadence is undocumented. Sandbox tests must create their own accounts
   every run and never assume state.
4. When a hosted Solana `upto` facilitator appears (CDP is the likely one), §2.3 gets a
   `facilitatorUrl` path. Watch `https://api.cdp.coinbase.com/platform/v2/x402/supported`.
5. Cantina report content was not read (PDF, no local extractor). Read it before mainnet
   canary; note any finding that touches `settleAndSeal` or `distribute`.
6. Voucher `expires_at` TTL is a seller product choice. Default proposal: `maxTimeoutSeconds`
   from the offer. Decide in SOL-04.
7. Whether the buyer should ever prefer `upto` over `exact` at equal price. Current answer
   (§4.2): no.

## 11. Human-only checklist

1. Register on hackathons.solana.com now; vote for the hackathon. Free, two minutes.
2. Create two Solana hot keys for the demo seller (`feePayer`, `receiverAuthorizer`), fund
   `feePayer` with devnet SOL (faucet) and later mainnet SOL (~0.05).
3. Fund the agent devnet wallet with Circle faucet devnet USDC and 0.01 SOL for reclaim tests.
4. Decide the mainnet canary amount ($1 USDC, like Base) and run `scripts/canary-solana.ts
   --network solana` when SOL-09 lands.
5. Record the two videos for SOL-10.
