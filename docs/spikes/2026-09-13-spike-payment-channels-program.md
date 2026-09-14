# Spike: Solana Payment Channels program (CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX)

Date: 2026-09-13. Read-only inspection. Clones live under
`/private/tmp/claude-501/-Users-fskroes-dev-wallet-pay/3c5c02e8-17e0-4a4a-a764-d5b6e9ee466d/scratchpad/spike-channels/` (abbreviated `SPIKE/` below).

Repos cloned (`git clone --depth 1`):

| Repo | HEAD | Role |
|---|---|---|
| `SPIKE/payment-channels` = github.com/solana-foundation/payment-channels | `3ffa4d6` 2026-08-07 | The program, IDL, generated TS + Rust clients, ADRs, audit PDF |
| `SPIKE/x402` = github.com/x402-foundation/x402 | current main | `upto` scheme (client/server/facilitator) that consumes the program; vendors the Codama client |
| `SPIKE/pay-kit` = github.com/solana-foundation/pay-kit | `df19fb5` 2026-09-11 | MPP `session` + x402 `upto` SDKs in 9 languages; surfpool on-chain harness |

Note: `payment-channels/justfile:144` still points `repo_url` at `https://github.com/Moonsong-Labs/solana-payment-channels` (the original author, used for verified builds). The canonical public repo is `solana-foundation/payment-channels`.

---

## 1. Program instructions

Source of truth: `SPIKE/payment-channels/docs/003-program-instructions.md` (ADR-003) and `SPIKE/payment-channels/program/payment_channels/src/instructions/*.rs`. Dispatch is one discriminator byte: `program/payment_channels/src/lib.rs:43-58`.

Every instruction takes an exact account list (missing OR extra accounts are rejected), except `distribute` which has a dynamic recipient-ATA tail (`docs/003-program-instructions.md:26`).

| Disc | Name | Tx signers | Transition |
|---|---|---|---|
| 1 | `open` | `payer` + `rent_payer` (may be the same key) | none -> OPEN |
| 2 | `settle` | none (permissionless crank; authority = Ed25519 precompile voucher) | OPEN -> OPEN |
| 3 | `topUp` | `payer` | OPEN -> OPEN |
| 4 | `settleAndSeal` | `payee` (+ optional voucher) | OPEN/CLOSING -> SEALED |
| 5 | `requestClose` | `payer` | OPEN -> CLOSING |
| 6 | `seal` | none | CLOSING -> SEALED (after grace) |
| 7 | `distribute` | none | OPEN -> OPEN ; SEALED -> DISTRIBUTED or deallocated |
| 8 | `withdrawPayer` | `payer` | SEALED -> SEALED (one-shot refund) |
| 9 | `reclaim` | none | DISTRIBUTED -> deallocated |
| 228 | `emitEvent` | event-authority PDA (self-CPI only) | internal |

### `open` (disc 1) — `src/instructions/open.rs:240-300`, docs `003:28-73`
Args wire after discriminator (`docs/003:41`):
`salt(u64 LE) || deposit(u64 LE) || grace_period(u32 LE) || open_slot(u64 LE) || count(u32 LE) || entries(count x 34)`; each entry `recipient(32) || bps(u16 LE)`.

Accounts (index: name, signer, writable):
0 `payer` S W (funds token deposit; `open.rs:249` requires signer)
1 `rent_payer` S W (funds PDA + escrow ATA rent via system CPI; `open.rs:255` requires signer; MAY equal payer)
2 `payee` - - (not curve-checked, may be a PDA)
3 `mint` - -
4 `authorized_signer` - - (must be on-curve Ed25519 key, `open.rs:271`; does NOT sign open)
5 `channel` - W (PDA)
6 `payer_token_account` - W (ATA(payer, mint))
7 `channel_token_account` - W (ATA(channel, mint), created here)
8 `token_program`, 9 `system_program`, 10 `rent`, 11 `associated_token_program`, 12 `event_authority`, 13 `self_program`

Checks: `deposit > 0`, `grace_period > 0`, `payer != payee`, `open_slot <= clock.slot && clock.slot - open_slot <= 1500` (`open.rs:275-278`). Emits `Opened{channel, open_slot}`.

### `settle` (disc 2) — `src/instructions/settle.rs:43-57`, docs `003:75-92`
No args. Accounts: 0 `channel` W, 1 `instructions_sysvar`. Requires status OPEN (`settle.rs:51`). Reads the voucher from the Ed25519 precompile ix at `current_index - 1` and sets `settled = cumulative_amount`.

### `topUp` (disc 3) — docs `003:94-113`
Args: `amount(u64)`. Accounts: 0 `payer` S W, 1 `channel` W, 2 `payer_token_account` W, 3 `channel_token_account` W, 4 `mint`, 5 `token_program`.

### `settleAndSeal` (disc 4) — `src/instructions/settle_and_seal.rs:76-122`, docs `003:115-133`
Args: one byte `has_voucher(u8)`. Accounts: 0 `payee` S, 1 `channel` W, 2 `instructions_sysvar`.
- `payee.is_signer()` required (`settle_and_seal.rs:83`), must equal `Channel.payee` (`:109`).
- Allowed from OPEN, or from CLOSING only while `now < closure_started_at + grace_period` (`:95-103`). Rejected once grace has elapsed (payee lost its window; anyone can `seal` instead).
- If `has_voucher != 0`, verifies the preceding Ed25519 ix exactly like `settle` and advances `settled` (`:113-116`). `has_voucher == 0` seals at the current watermark (zero-charge close).
- Sets status SEALED, `closure_started_at = 0`.

### `requestClose` (disc 5) — `src/instructions/request_close.rs:37-60`
No args. Accounts: 0 `payer` S, 1 `channel` W. Requires OPEN, payer == `Channel.payer`. Sets `closure_started_at = now (unix)`, status CLOSING. Also freezes `deposit` (no more `topUp`).

### `seal` (disc 6) — `src/instructions/seal.rs:40-58`
No args. Accounts: 0 `channel` W. Requires CLOSING and `now >= closure_started_at + grace_period` (`seal.rs:49-55`, error 2201 `SealGracePeriodNotElapsed`). Sets SEALED.

### `distribute` (disc 7) — `src/instructions/distribute.rs`, docs `003:156-189`
Args: `count(u32 LE) || entries` (the splits preimage; SHA-256 must equal `Channel.distribution_hash`).
Accounts: 0 `channel` W, 1 `payer` W, 2 `rent_payer` W (not signer, must equal recorded), 3 `channel_token_account` W, 4 `payer_token_account` W, 5 `payee_token_account` W, 6 `treasury_token_account` W (= ATA(TREASURY_OWNER, mint)), 7 `mint`, 8 `token_program`, 9 `event_authority`, 10 `self_program`, 11..N recipient ATAs (one per preimage entry, same order).
- From OPEN: pays cumulative floor deltas `floor(settled*bps/10000) - floor(payout_watermark*bps/10000)` to each recipient, payee gets the `10000 - sum(bps)` remainder; advances `payout_watermark`.
- From SEALED (`distribute.rs:312-330`): final deltas, then **refunds `deposit - settled` to payer** if `payer_withdrawn_at == 0`, sweeps residual dust to treasury, closes the escrow ATA. Then deallocates the channel PDA in place (all lamports to `rent_payer`) if `clock.slot > open_slot + 1500`, else marks DISTRIBUTED for later `reclaim`.
- With 32 recipients a v0 tx + address lookup table is mandatory (`docs/003:162`).

### `withdrawPayer` (disc 8) — `src/instructions/withdraw_payer.rs:66-130`
No args. Accounts: 0 `payer` S, 1 `channel` W, 2 `channel_token_account` W, 3 `payer_token_account` W, 4 `mint`, 5 `token_program`. Requires SEALED and `payer_withdrawn_at == 0`; transfers `deposit - settled` to payer, stamps `payer_withdrawn_at = now`. Does not close the PDA. This is the payer's independent refund path if nobody runs `distribute`.

### `reclaim` (disc 9) — `src/instructions/reclaim.rs:40-44`
No args, no signers. Accounts: 0 `channel` W (must be DISTRIBUTED), 1 `rent_payer` W (must equal recorded). Requires `clock.slot > open_slot + 1500` (error 2414 `ChannelCloseTooEarly`). Batchable.

Error codes: full table at `docs/003-program-instructions.md:227-352`; canonical `program/payment_channels/src/errors.rs`.

---

## 2. Channel account layout

`SPIKE/payment-channels/program/payment_channels/src/state/channel.rs:81-156`, mirrored with byte offsets in `docs/001-payment-channel-state-machine.md:40-66`. `#[repr(C)]`, align 1, exactly **256 bytes** (`channel.rs:348-350` const-assert). All multi-byte ints stored LE as byte arrays.

| Offset | Size | Field | Type | Notes |
|---|---|---|---|---|
| 0 | 1 | `discriminator` | u8 | `AccountDiscriminator::Channel = 1` |
| 1 | 1 | `version` | u8 | `CURRENT_CHANNEL_VERSION = 1` |
| 2 | 1 | `bump` | u8 | canonical bump |
| 3 | 1 | `status` | u8 | 0 Open, 1 Sealed, 2 Closing, 3 Distributed (`channel.rs:31-53`) |
| 4 | 8 | `salt` | u64 | PDA disambiguator |
| 12 | 8 | `deposit` | u64 | escrow ceiling; raised by `topUp` only in OPEN |
| 20 | 8 | `settlement.settled` | u64 | cumulative voucher watermark |
| 28 | 8 | `settlement.payout_watermark` | u64 | amount already paid out by `distribute`; `<= settled` |
| 36 | 8 | `closure_started_at` | i64 | unix ts set by `requestClose`; 0 otherwise |
| 44 | 8 | `payer_withdrawn_at` | i64 | 0 = refund not yet taken |
| 52 | 4 | `grace_period` | u32 | seconds; set at `open`; non-zero |
| 56 | 32 | `distribution_hash` | [u8;32] | SHA-256 of splits preimage |
| 88 | 32 | `payer` | Address | refund destination + payer authority |
| 120 | 32 | `payee` | Address | seals cooperatively; implicit remainder recipient |
| 152 | 32 | `authorized_signer` | Address | voucher signer |
| 184 | 32 | `mint` | Address | |
| 216 | 32 | `rent_payer` | Address | receives all SOL rent at close |
| 248 | 8 | `open_slot` | u64 | per-incarnation epoch, also a PDA seed |

PDA seeds (`channel.rs:15-21`, `find_pda` at `:238-258`):
`[b"channel", payer, payee, mint, authorized_signer, salt.to_le_bytes(), open_slot.to_le_bytes()]` under program `CHNLx...`.
Escrow = canonical ATA `ATA(channel_pda, mint, token_program)`.
Event authority PDA seed: `b"event_authority"` (`docs/003:225`).

Because `open_slot` is a seed, every channel incarnation has a fresh address. No `bump` is passed by the client; the program finds it on-chain (`docs/002:47`). CU note: grind `salt` until both PDA and escrow ATA land on bump 255 (`docs/003:46`).

---

## 3. Voucher

Definition: `program/payment_channels/src/instructions/mod.rs:27-92`; verification: `src/instructions/helpers/voucher.rs:24-101`; precompile parser: `src/instructions/helpers/ed25519/parse.rs:62-134`, constants `ed25519/consts.rs`.

**Signed bytes: exactly 50 bytes** (`VOUCHER_PAYLOAD_SIZE == 50`, `mod.rs:92`):

| Offset | Size | Field | Encoding |
|---|---|---|---|
| 0 | 2 | `magic` | `[0x56, 0x01]` ('V', format version 1) — domain separator |
| 2 | 32 | `channel_id` | channel PDA bytes |
| 34 | 8 | `cumulative_amount` | u64 LE |
| 42 | 8 | `expires_at` | i64 LE unix seconds; `0` = no expiry |

There is **no nonce and no epoch field**. Semantics are **cumulative**: the voucher carries the total authorised so far, not a delta. On-chain checks (`voucher.rs:66-98`, in order):
1. `magic == [0x56,0x01]` else `VoucherBadMagic` (238)
2. `channel_id == channel account address` else `VoucherChannelMismatch` (232)
3. `expires_at == 0 || now < expires_at` else `VoucherExpired` (233) (note: `now == expires_at` is expired; negative expires_at fails closed)
4. `cumulative_amount <= deposit` else `VoucherOverDeposit` (235)
5. `cumulative_amount > settled` (strict) else `VoucherWatermarkNotMonotonic` (234)
6. precompile pubkey `== Channel.authorized_signer` else `VoucherSignerMismatch` (237)

**Signature scheme:** Ed25519 via the native **Ed25519SigVerify111... precompile**, not in-program verification. The transaction must contain a canonical single-signature precompile instruction **immediately before** `settle` / `settleAndSeal`; the program reads it through the Instructions sysvar at `current_index - 1` (`voucher.rs:30-40`). The precompile ix data is pinned to exactly 162 bytes: `[num_sigs=1][pad=0][7 x u16 offsets][pubkey@16][sig@48][message@112, 50 bytes]`, all three `*_instruction_index` fields = `0xFFFF` (`parse.rs:65-120`). Non-canonical layouts, multiple signatures, and cross-instruction references are rejected (`MalformedEd25519Instruction` 231). The payment-channel instruction itself carries no voucher bytes.

**Replay prevention:**
- Same channel: strict monotonicity (`settled < cumulative`), so a voucher can be applied once and only while it is the highest seen.
- Across incarnations: `channel_id` binds the PDA address, and the address embeds `open_slot`; `open` only accepts `open_slot` within the last 1500 slots and the PDA stays allocated until `clock.slot > open_slot + 1500`, so an address can never host two channels (proof in `src/constants.rs:23-28`). Old vouchers therefore point at an address that cannot be re-derived. `OPEN_SLOT_WINDOW` is consensus-critical and may only ever decrease (`constants.rs:39-57`).
- A refunded/sealed channel cannot accept vouchers (status gate in `settle.rs:51`).

Off-chain, the HTTP layer additionally requires the server to keep `acceptedCumulative` and reject `cumulative <= acceptedCumulative` before delivering service (`docs/002-http-protocol.md:116`).

---

## 4. Timeouts

- **No on-chain timeout on the channel itself.** A channel stays OPEN forever if nobody acts. The only clock inputs are `grace_period` (seconds, per channel, set at `open`, must be `> 0`, no upper bound in program) and `OPEN_SLOT_WINDOW = 1500` slots (rent-reclaim gate only).
- **Payee never settles:** the payer calls `requestClose` (payer-signed; `request_close.rs:37-60`) -> CLOSING, `closure_started_at = now`, `deposit` frozen. During grace only the payee can act (`settleAndSeal` with or without a final voucher, `settle_and_seal.rs:95-103`); `settle` is rejected (status must be OPEN). After `now >= closure_started_at + grace_period`, anyone calls `seal` (`seal.rs:49-58`) -> SEALED. Then the payer calls `withdrawPayer` for `deposit - settled` immediately (`withdraw_payer.rs`), or anyone calls `distribute` with the public splits preimage which also refunds the payer. Worst-case payer wait is exactly one `grace_period` (`docs/001:184`). Grace is in **unix seconds**, not slots.
- **Payer disappears:** payee can `settleAndSeal` at any time from OPEN (no waiting), then `distribute`. Facilitator/payee can seal with `has_voucher = 0` to just recover rent (x402 spec `SPIKE/x402/specs/schemes/upto/scheme_upto_svm.md:45-50`).
- **Defaults (off-chain policy, not program constants):**
  - payment-channels HTTP ADR recommends `gracePeriodSeconds` 900 (`docs/002:36, :73`).
  - x402 `upto` TS client: `DEFAULT_GRACE_PERIOD_SECONDS = 900` (`SPIKE/x402/typescript/packages/mechanisms/svm/src/payment-channels/open.ts:91`); the value used on the wire is `extra.withdrawDelay` which the facilitator must match exactly and SHOULD be `>= maxTimeoutSeconds` (`scheme_upto_svm.md:161`). Facilitator `maxChannelLifetimeSecs` default 3600 (`facilitator/scheme.ts:105`); voucher `expiresAt` must be nonzero for `upto` (`scheme_upto_svm.md:74`).
  - pay-kit MPP session server: `idleTimeoutSeconds = 300` default, server auto-settles on idle (`SPIKE/pay-kit/typescript/packages/mpp/src/server/Session.ts:121, :165-192`); `DEFAULT_SESSION_EXPIRES_AT = 4_102_444_800` (year 2100) as the "no expiry" voucher default (`client/Session.ts:21`).
- **Rent recovery timing:** SOL rent comes back only when the PDA is deallocated, which needs `clock.slot > open_slot + 1500` (~10 min). Token refunds are never slot-gated (`docs/003:19`).

---

## 5. Fees

- **Rent:** paid by `rent_payer` (account 1 of `open`), which MUST sign because the program pulls lamports via a system-program transfer CPI (`open.rs:163-167, :253-256`). Being the tx fee payer alone is not enough; the relayer must appear in the account list as `rent_payer` signer. Rent for PDA (256 bytes) + escrow ATA is returned to `rent_payer` at close (`distribute` fast path or `reclaim`). Recorded in `Channel.rent_payer`.
- **Tx fees:** whoever is the transaction fee payer. `open` needs a `payer` signature (token authority) and a `rent_payer` signature; they may be the same key.
- **Payer-needs-no-SOL pattern: yes, and it is the designed default.** The channel struct docs say so directly (`channel.rs:142-146`: "Lets a stablecoin-only client avoid holding SOL: the transaction submitter (typically the operator/fee payer) fronts the rent and reclaims it at close"). Flow: client builds and partially signs `open` as `payer` with `feePayer = rentPayer = operator`, sends the base64 tx to the server (`POST /channel/open` in MPP, `openTransaction` in x402 `upto` payload, `scheme_upto_svm.md:249`), the operator validates the whole compiled message (`docs/002:112-113`; `x402 .../payment-channels/open.ts:454` `verifyOpenTransaction`; pay-kit `mpp/src/server/session/on-chain.ts:538` `verifyOpenTx`), co-signs, and broadcasts.
- In x402 `upto`, the facilitator is `feePayer` + `rent_payer` + `payee` (zero-share) and the server hot key is `authorized_signer` (`scheme_upto_svm.md:37-56, :173-179`). pay-kit documents all four rent/voucher combos; only gasless (operator pays rent) is wired today; self-pay is "not yet wired" (`SPIKE/pay-kit/docs/security/payment-channel-rent-and-voucher-modes.md:21-26`).
- The payer still needs SOL for the escape hatches it submits itself (`requestClose`, `withdrawPayer`) unless someone else fee-pays those; the program does not require the payer to be the fee payer on those either.
- Compute: `open` default CU limit 90k, max 400k in the x402 builder (`open.ts:59-72`).

---

## 6. TypeScript client

Location: `SPIKE/payment-channels/clients/typescript/`.

- `package.json` name: **`@payment-channels/client`**, version `0.1.0`, ESM only (`tsup.config.ts`), `"files": ["dist"]`. **Not published to npm**: `npm view @payment-channels/client` -> E404. No other package name in the repo. `npm search` finds nothing under that name.
- Dependencies (`clients/typescript/package.json:22-25`): `@solana/kit ^6.1.0`, `@solana/program-client-core ^6.1.0`. No `@solana/web3.js`. Codama-generated (`codama.js`, `codama-visitors.mjs`, post-processed by `scripts/narrow-codama-types.mjs` and `scripts/enforce-fixed-account-shapes.mjs`). `safe-codecs.ts` swaps kit's u64/i64 encoders for ones that reject unsafe JS numbers (bigint required).
- `src/index.ts` re-exports only `./generated`. Exports per instruction (`src/generated/instructions/*.ts`): `get<Name>Instruction`, `get<Name>InstructionDataEncoder/Decoder/Codec`, `parse<Name>Instruction`, `<NAME>_DISCRIMINATOR`, for `open` (+ `getOpenInstructionAsync`), `settle`, `topUp`, `settleAndSeal`, `requestClose`, `seal`, `distribute`, `withdrawPayer`, `reclaim`, `emitEvent`. Signer inputs are `TransactionSigner` for `open.payer`, `open.rentPayer` (`open.ts:350-351`), `settleAndSeal.payee` (`settleAndSeal.ts:115`), `requestClose.payer`, `topUp.payer`, `withdrawPayer.payer`.
- Accounts: `decodeChannel`, `fetchChannel`, `fetchMaybeChannel`, `fetchAllChannel` (`src/generated/accounts/channel.ts:141-185`). PDAs: only `findEventAuthorityPda` (`src/generated/pdas/eventAuthority.ts:16`). **No `findChannelPda` helper** in this client; downstream must build the 7 seeds themselves.
- Types: `VoucherArgs` codec (`getVoucherArgsEncoder/Decoder/Codec`, `src/generated/types/voucherArgs.ts:31-63`, fields `magic: number[]`, `channelId`, `cumulativeAmount: bigint`, `expiresAt: bigint`), `OpenArgs`, `DistributionEntry`, `SettleAndSealArgs`, `TopUpArgs`, `ChannelStatus`, events `Opened`, `PayoutRedirected`.
- **No voucher signing/verifying helper, no Ed25519 precompile builder, no operator/server helper** in this client. Tests: 15 vitest cases (`src/__tests__/`), covering encoder safety and parser strictness only.

Where the missing pieces live (both vendor the same Codama client):
- **x402** `SPIKE/x402/typescript/packages/mechanisms/svm/src/payment-channels/`: `voucher.ts` (`VOUCHER_MAGIC`, `encodeVoucherMessageBytes`, `signVoucher(MessagePartialSigner, ...)`, `verifyVoucherSignature`, `verifyEd25519Signature` via WebCrypto), `onchain.ts` (`buildEd25519VerifyInstruction` :113, `buildSettleAndSealInstructions` :194, `buildDistributeInstruction` :268, `buildReclaimInstruction` :345, `getPaymentChannelsTreasuryOwner` :89), `open.ts` (`findPaymentChannelPda` :181, `buildOpenPaymentChannelTransaction` :215, `verifyOpenTransaction` :454). Published as **`@x402/svm` 2.25.0** (npm, modified 2026-09-04), exports `./upto/client`, `./upto/server`, `./upto/facilitator`; peer dep `@solana/kit >= 5.1.0`. These payment-channel helpers are internal to `@x402/svm` (not a public subpath).
- **pay-kit** `SPIKE/pay-kit/typescript/packages/mpp/src/server/session/on-chain.ts`: `buildEd25519VerifyInstruction` :118, `encodeVoucherMessageBytes` :165, `buildSettleAndSealInstructions` :222, `buildDistributeInstruction` :304, `buildTopUpInstruction` :374, `buildReclaimInstruction` :410, `verifyOpenTx` :538, `submitOpenTx` :904, `submitSettleAndDistribute` :1023; `session/voucher.ts:104` `verifyVoucherForChannel`; `shared/voucher.ts` (`encodeVoucherMessage`, `verifyVoucherSignature`). Published as **`@solana/mpp` 0.10.0** and **`@solana/pay-kit` 0.11.0** (`@solana/kit >= 6.5.0`, `mppx >= 0.5.5`). The "operator" concept exists here: `client/Session.ts:31` `SessionVoucherSigner = 'client' | 'operator'`, `pay-kit/src/config.ts:55-68` `Operator`.

---

## 7. x402 integration

**In the payment-channels repo itself:** none. Only doc references: `README.md` ("Used by pay.sh", links to the x402 `upto` spec and MPP session draft) and `docs/002-http-protocol.md` (MPP `session` HTTP protocol, `POST /channel/open|topup|close`, `Authorization: Payment` voucher header). No `upto`, facilitator, or example server code.

**In `SPIKE/x402` (x402-foundation/x402):**
- Spec: `specs/schemes/upto/scheme_upto_svm.md` (role mapping :24-56, open param table :150-161, PDA derivation :255-262, voucher bytes :295, settle flow :325-367). Also `specs/schemes/batch-settlement/scheme_batch_settlement_svm.md` references the same program.
- TS scheme: `typescript/packages/mechanisms/svm/src/upto/{client,server,facilitator}/scheme.ts`, `upto/README.md`, `upto/facilitator/rentCleanupManager.ts`, `channelStorage.ts`, `delegatedAuthStore.ts`. Server signs vouchers with `receiverAuthorizerSigner` (`server/scheme.ts:283`); client sets `payee = feePayer`, `gracePeriod = withdrawDelay`, `deposit = maxAmount` (`client/scheme.ts:78-89`); facilitator `settleDeposit` (:586) opens, `settleClaim` (:853) sends Ed25519 + `settleAndSeal` + `distribute`.
- Examples: `examples/typescript/servers/upto/index.ts`, `examples/typescript/facilitator/upto/index.ts` (Solana devnet, `RENT_CLEANUP_*` env), `examples/go/servers/upto`, `examples/go/facilitator/upto`.
- Go: `go/mechanisms/svm/upto/`, `go/mechanisms/svm/paymentchannels/program.go`.

**In `SPIKE/pay-kit`:** MPP `session` (`typescript/packages/mpp/src/{client,server}/Session*.ts`, `server/session/*`), x402 `upto` in Rust (`rust/crates/x402/src/server/upto.rs` per `docs/security/payment-channel-rent-and-voucher-modes.md:55-58`), harness scenarios `harness/src/intents/x402-upto.ts`, Go/Python/Kotlin/Swift generated clients under `*/protocols/programs/paymentchannels/`.

---

## 8. Tests and local validator

payment-channels program tests (`program/payment_channels/tests/`, 218 `#[test]`/`#[rstest]` functions across `open/ settle/ settle_and_seal/ request_close/ seal/ distribute/ withdraw_payer/ reclaim/ top_up/ event_engine/ benchmark/`, each split into `integration.rs` and `e2e.rs`):
- **LiteSVM** `0.11` with `precompiles` feature (needed for the Ed25519 precompile) + `litesvm-token` for Token-2022 (`program/payment_channels/Cargo.toml:42-43`); **mollusk-svm** `0.11` for instruction-level tests (`:59`). No `solana-test-validator`, no bankrun, no surfpool in this repo.
- Run: `just setup && just build-program && just generate-client && just test-program` (`cargo test-sbf`) and `just test-client` (vitest) (`justfile:77-85`). CI: `.github/workflows/ci.yml` (build, lint, `just test-program`, `just test-client`; checks generated clients are committed and current). Toolchain pinned in `rust-toolchain.toml`; program is Pinocchio 0.11, edition 2024, `#![no_std]`.
- Voucher test helpers to copy: `tests/common/voucher.rs:21-65` (`voucher()`, `voucher_payload()`, `build_ed25519_ix()`), `tests/common/mod.rs` (`set_clock`, `advance past reclaim gate`, `ChannelBuilder`).
- Build features: `default = ["localnet"]`; `devnet/testnet/mainnet-beta` features gate `TREASURY_OWNER` (`Cargo.toml:10-19`, `constants.rs:59-118`). **Localnet builds use a `0xBEEF...` placeholder treasury owner**; the deployed mainnet binary uses `Cs2zdfUNonRdRGsiZUQQLdTxzxVvJZmgiX2mpLYKuEqP`.

What a downstream project needs to run the program locally:
1. Either build the `.so` (`cargo build-sbf`, needs Solana platform-tools; treasury placeholder OK for localnet) or **dump the mainnet binary** (`solana program dump CHNLx... payment_channels.so -u m`) and load it into `solana-test-validator --bpf-program CHNLx... payment_channels.so` or LiteSVM/surfpool. The dumped binary has treasury owner `Cs2z...`; a `distribute` from SEALED requires `ATA(Cs2z..., mint)` to exist (pay-kit pre-creates it: `harness/src/onchain/surfnet.ts:76-78`).
2. Simplest: **surfpool** forking mainnet and streaming the program account, exactly as pay-kit does: `Surfnet.startWithConfig({ remoteRpcUrl, offline: false }); surfnet.streamAccount(PROGRAM)` (`harness/src/onchain/surfnet.ts:65-78`, `@solana/surfpool 1.4.0`). Run `HARNESS_ONCHAIN=1 vitest run -c vitest.onchain.config.ts` (`harness/package.json`).
3. Ed25519 precompile must be enabled in whatever SVM you use (LiteSVM needs the `precompiles` feature; test-validator and surfpool have it).
4. A funded SPL mint + ATAs for payer, payee, treasury, and each recipient.

---

## 9. Deployments

Confirmed by RPC `getAccountInfo` today (2026-09-13):

| Cluster | Program | Loader | ProgramData | Upgrade authority | Last deploy slot |
|---|---|---|---|---|---|
| mainnet-beta | `CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX` | BPFLoaderUpgradeab1e | `CghQXkmw2F6p1exMETiZdNeUx9QGraWsNZ4eom1Cuiw1` | `DXtFpbPjcn2hxPnw79x1Pfoj35vXh5AsWBkS37YnXMVv` | 431447053 |
| devnet | same ID | BPFLoaderUpgradeab1e | same ProgramData address | `4zTeC5mVqWLruDexgU2mV66p9t5vCA9JyiZqdGDUspap` | 480232051 |

- The program is **upgradeable** (authority not burned) on both clusters; the two clusters have different authority keys. The repo does not name the authority or say whether it is a multisig (no `squads`/`multisig` mentions). `justfile:174-204` shows deploy uses a single `DEPLOYER_KEYPAIR` as upgrade authority.
- Treasury owner (mainnet): `Cs2zdfUNonRdRGsiZUQQLdTxzxVvJZmgiX2mpLYKuEqP` (`constants.rs:72-76`; confirmed by pay-kit `surfnet.ts:20`). Devnet/testnet constants in source still carry the placeholder (`constants.rs:78-92` "TODO: real devnet owner"), so the devnet binary was built from a tree that differs from `main`, or with a local edit.
- OtterSec verified-build status for mainnet: **not verified** (`https://verify.osec.io/status/CHNLx...` -> `is_verified: false`, on-chain hash `afe23e23...`). `just verify-mainnet` recipe exists but has not been run against the public repo.
- Audit: Cantina, dated 2026-07-27, PDF at `SPIKE/payment-channels/audits/report-cli-cantina-7e1ee899-54e4-4841-8c70-c73e667a0a39-2026-07-27-solana-foundation-payment-channels-9c97d575.pdf` (489 KB). Linked from `README.md` "Security audit". Text extraction failed locally (no poppler; object streams compressed), so findings count/severities were not read.
- Other IDs: SUBSCRIPTIONS program `De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44` (pay-kit `surfnet.ts:15`), Ed25519 precompile `Ed25519SigVerify111111111111111111111111111`.

---

## Open questions

1. **Audit contents.** The Cantina PDF could not be text-extracted here. Number and severity of findings, and whether all are fixed at commit `3ffa4d6`, are unknown. Needs `brew install poppler` or a manual read.
2. **Upgrade authority governance.** Mainnet authority `DXtFpbPjcn2hxPnw79x1Pfoj35vXh5AsWBkS37YnXMVv` is a single key with no public statement about multisig or timelock. A hostile upgrade could change `OPEN_SLOT_WINDOW` or the treasury. Same for devnet `4zTeC5...`.
3. **Build reproducibility.** The on-chain binary is not OtterSec-verified and the `justfile` still points at `Moonsong-Labs/solana-payment-channels`. Which commit is live on mainnet is not stated in the repo.
4. **TS client distribution.** `@payment-channels/client` is not on npm. Options: vendor the generated folder (what x402 and pay-kit do), depend on `@x402/svm` internals (not a public subpath), or depend on `@solana/mpp` (exports `buildSettleAndSealInstructions` etc. from `./server`). Need to decide which.
5. **Kit version skew.** payment-channels client pins `@solana/kit ^6.1.0`; `@x402/svm` accepts `>=5.1.0`; `@solana/pay-kit` requires `>=6.5.0`; npm latest kit is 8.3.0. Must check what wallet_pay already uses before vendoring.
6. **Self-pay mode.** If the payer must pay its own rent (no operator), pay-kit says combos 3 and 4 are "not yet wired" in its SDKs even though the program supports `rent_payer == payer`. A wallet_pay integration doing self-pay has to build `open` itself.
7. **Grace period ceiling.** Program accepts any non-zero `u32` seconds (up to ~136 years). A malicious server could demand a huge `withdrawDelay`; the client SDK should cap it. Not enforced anywhere on-chain.
8. **Voucher expiry vs settlement latency.** `expires_at` is re-checked on-chain at `settle` time; a server that accepts a voucher with a short TTL and settles late loses the payment. `upto` requires nonzero `expiresAt`; MPP session defaults to year 2100. Which policy wallet_pay wants is a product decision.
9. **Treasury ATA precondition.** `distribute` from SEALED hard-fails with `TreasuryAccountMismatch`/`InvalidTreasuryTokenAccount` if `ATA(Cs2z..., mint)` does not exist for the chosen mint. For mainnet USDC it exists; for other mints someone must create it first.
10. **Devnet treasury owner.** Source still has the `0xBEEF` placeholder for devnet, so the actual devnet treasury address is unknown without dumping the binary.
