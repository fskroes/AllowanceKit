# Solana research for the Wallie architecture doc

Date: 2026-09-13. Read-only research. Every claim carries a URL. "Verified live" means I ran the RPC/HTTP call myself on this date.

---

## 1. Solana "Agentic Payments" hackathon

Page: https://hackathons.solana.com/hackathons/agentic-payments-mtxd9fkr

Facts from the page's embedded Next.js payload (scraped 2026-09-13):

- `status: "funding"`, shown on the site as "SEEKING SPONSORS".
- `funding_goal: 5000000` (cents) = **$50,000**. `current_funding: 0`.
- `launch_date: null`, `submission_deadline: null`, `judging_deadline: null`. **No dates exist yet.**
- `bounties: []` and `main_track_prizes: []`. **Zero tracks, zero sponsors.**
- `registrationCount: 21`, `submissionCount: 0`, `judgeUserIds: []`.
- `created_at: 2026-09-11T19:45:56Z` (the hackathon was proposed two days ago).
- `rules: null`. **Submission requirements: not published for this hackathon.**
- Theme text: "AI agents are becoming some of the busiest payers on Solana, settling millions in USDC a week through protocols like x402 ... Payment Channels now let an agent authorize a spending limit once and settle all of its usage in a single transaction. Build agents that buy data, compute, and services onchain, the wallets and spending controls that keep them safe, and the tooling merchants and APIs need to accept them."

Platform mechanics (https://hackathons.solana.com/how-it-works):

- A hackathon launches when deposited sponsor bounties reach ~$50k; an admin then schedules it. Only one hackathon runs at a time.
- Sponsors create bounty tracks and deposit USDC into on-chain escrow.
- Build window is two weeks from launch. A submission is a GitHub repo, live demo, pitch video and/or walkthrough; a builder picks up to 3 sponsor tracks.
- Two judging lanes: main track (Solana Foundation judges) and sponsor tracks (sponsor judges).
- Registration needs a wallet or Google login. No other eligibility rules listed.

Queue context (https://hackathons.solana.com/hackathons): "Stocklana" is live ($100k), "Perps and Prediction Markets" is scheduled ($100k), "Agentic Payments" is third with $0/$50k.

Related but separate events (not this hackathon): Solana x402 Hackathon, up to $135k, five tracks, https://solana.com/x402/hackathon.

---

## 2. Payment Channels program `CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX`

### Repo and status

- Repo: https://github.com/solana-foundation/payment-channels (MIT, created 2026-04-14, last push 2026-09-01, 7 stars, description "Agentic payments primitive (x402/MPP)"). No GitHub releases exist (https://github.com/solana-foundation/payment-channels/releases).
- Docs in repo: `docs/001-payment-channel-state-machine.md`, `002-http-protocol.md`, `003-program-instructions.md`, `004-batch-voucher-settlement.md`, `005-channel-rearm.md`, `006-settlement-rollup.md`.
- Launch post: https://solana.com/news/payment-channels-1-million-payments-per-second (Alibaba Cloud APIs live at launch).
- Concept doc: https://pay.sh/docs/building-with-pay/payment-channels/concept

### Deployment (verified live 2026-09-13 via `getAccountInfo`)

| Cluster | RPC | Result |
|---|---|---|
| mainnet-beta | https://api.mainnet-beta.solana.com | executable, owner BPFLoaderUpgradeab1e, programData `CghQXkmw2F6p1exMETiZdNeUx9QGraWsNZ4eom1Cuiw1` |
| devnet | https://api.devnet.solana.com | executable, same programData address |
| sandbox | https://402.surfnet.dev:8899 | executable, same programData address |

The README and the x402 spec only say "mainnet"; the devnet deployment is confirmed by RPC, and the `@x402/svm` upto README lists both mainnet and devnet as supported (https://github.com/x402-foundation/x402/blob/main/typescript/packages/mechanisms/svm/src/upto/README.md, "Supported Networks").

### Instruction set (exact names, discriminators)

Source: https://github.com/solana-foundation/payment-channels/blob/main/docs/003-program-instructions.md

| Instruction | Disc | Args | Signers | Precondition |
|---|---|---|---|---|
| `open` | 1 | `salt u64`, `deposit u64`, `grace_period u32`, `open_slot u64`, `recipients` | payer, rent_payer | channel absent; `open_slot <= clock.slot <= open_slot + 1500` |
| `settle` | 2 | none (voucher read from Ed25519 precompile ix at index-1) | none | status OPEN |
| `topUp` | 3 | `amount u64` | payer | status OPEN |
| `settleAndSeal` | 4 | `has_voucher u8` | payee | OPEN or CLOSING |
| `requestClose` | 5 | none | payer | OPEN |
| `seal` | 6 | none | none (permissionless) | CLOSING and grace elapsed |
| `distribute` | 7 | `recipients Vec<DistributionEntry>` | none | OPEN or SEALED; SHA-256 preimage must match `distribution_hash` |
| `withdrawPayer` | 8 | none | payer | SEALED, not yet withdrawn |
| `reclaim` | 9 | none | none | DISTRIBUTED and `clock.slot > open_slot + 1500` |
| `emitEvent` | 228 | internal | event_authority | self-CPI only |

There is no instruction literally named `voucher` or `refund`. A voucher is an off-chain signed message consumed by `settle` / `settleAndSeal`. A refund is `settleAndSeal(has_voucher=0)` then `distribute` (returns `deposit - settled` to payer), or the payer path `requestClose` -> wait grace -> `seal` -> `withdrawPayer`. Rust snake_case names in the x402 spec: `settle_and_seal`, `request_close`, `withdraw_payer`, `top_up`.

`open` account order (14 accounts): payer (w,s), rent_payer (w,s), payee, mint, authorized_signer, channel (w), payer_token_account (w), channel_token_account (w), token_program, system_program, rent sysvar, associated_token_program, event_authority, self_program. Source: https://github.com/x402-foundation/x402/blob/main/specs/schemes/upto/scheme_upto_svm.md

### Channel account layout (256 bytes)

Source: https://github.com/solana-foundation/payment-channels/blob/main/docs/001-payment-channel-state-machine.md

| Offset | Field | Type |
|---|---|---|
| 0 | discriminator | u8 (=1) |
| 1 | version | u8 (=1) |
| 2 | bump | u8 |
| 3 | status | u8 |
| 4 | salt | u64 LE |
| 12 | deposit | u64 LE (escrowed) |
| 20 | settled | u64 LE (highest voucher cumulative, the watermark) |
| 28 | payout_watermark | u64 LE |
| 36 | closure_started_at | i64 LE |
| 44 | payer_withdrawn_at | i64 LE |
| 52 | grace_period | u32 LE (seconds) |
| 56 | distribution_hash | [u8;32] SHA-256 of splits |
| 88 | payer | Pubkey |
| 120 | payee | Pubkey |
| 152 | authorized_signer | Pubkey (voucher signer) |
| 184 | mint | Pubkey |
| 216 | rent_payer | Pubkey |
| 248 | open_slot | u64 LE |

Status enum: `OPEN=0`, `SEALED=1`, `CLOSING=2`, `DISTRIBUTED=3`.

PDA seeds: `["channel", payer, payee, mint, authorized_signer, salt LE u64, open_slot LE u64]`.

### Voucher wire format

Sources: docs/003 above, and https://github.com/x402-foundation/x402/blob/main/typescript/packages/mechanisms/svm/src/payment-channels/voucher.ts

- Exactly **50 bytes**, Ed25519-signed by `authorized_signer`, verified on-chain via the Ed25519 precompile instruction placed at `current_index - 1` (error 230 if missing).
- Layout: `[0x56, 0x01]` magic (2) || channel PDA (32) || `cumulative_amount` u64 LE (8) || `expires_at` i64 LE (8, `0` = no expiry).
- **Cumulative**, not delta. Rule: `settled < cumulative <= deposit`. Newer vouchers supersede older ones.

### Fees, timeouts

- `rent_payer` (the facilitator/feePayer in x402 upto) funds SOL fees plus channel PDA and escrow ATA rent at `open`; rent returns to `rent_payer` at final `distribute`/`reclaim`. `payer` supplies only the token deposit. Source: scheme_upto_svm.md "Fee Payment Model".
- `OPEN_SLOT_WINDOW = 1500` slots (~10 min): `open` must land within 1500 slots of `open_slot`; `reclaim`/deallocation needs `clock.slot > open_slot + 1500`.
- `grace_period` (seconds, set at `open`, must be > 0) gates the permissionless `seal` after `requestClose`. In x402 this is `extra.withdrawDelay`. MPP recommends `gracePeriodSeconds: 900`.

### Audit

- Cantina, report dated **2026-07-27**: https://github.com/solana-foundation/payment-channels/blob/main/audits/report-cli-cantina-7e1ee899-54e4-4841-8c70-c73e667a0a39-2026-07-27-solana-foundation-payment-channels-9c97d575.pdf

### TypeScript client

- Package name in repo: `@payment-channels/client` v0.1.0, deps `@solana/kit ^6.1.0`, `@solana/program-client-core ^6.1.0`. Source: https://github.com/solana-foundation/payment-channels/blob/main/clients/typescript/package.json
- Generated by Codama (`codama.js`, `codama-visitors.mjs` at repo root; output in `clients/typescript/src/generated/`).
- **Not on npm.** `npm view @payment-channels/client` returned 404 on 2026-09-13. Consumers vendor generated copies: `@x402/svm` ships `src/payment-channels/generated/` and `@solana/pay-kit` ships `typescript/packages/mpp/src/generated/payment-channels/`.
- Rust client under `clients/rust/`.

---

## 3. x402 `upto` scheme on Solana

Spec docs:

- Generic: https://github.com/x402-foundation/x402/blob/main/specs/schemes/upto/scheme_upto.md
- **SVM-specific (the one that matters):** https://github.com/x402-foundation/x402/blob/main/specs/schemes/upto/scheme_upto_svm.md
- Overview: https://docs.x402.org/schemes/overview (upto supports `authorization` flow only)
- TS package: `@x402/svm` 2.25.0 with subpaths `./upto/client`, `./upto/server`, `./upto/facilitator` (npm view, 2026-09-13). README: https://github.com/x402-foundation/x402/blob/main/typescript/packages/mechanisms/svm/src/upto/README.md

### `accepts[]` entry (verbatim from scheme_upto_svm.md)

```json
{
  "scheme": "upto",
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "amount": "10000",
  "asset": "<mint>",
  "payTo": "<server-cold-wallet>",
  "maxTimeoutSeconds": 300,
  "extra": {
    "paymentFlow": "escrow",
    "feePayer": "<server-hot-wallet>",
    "receiverAuthorizer": "<server-hot-wallet>",
    "withdrawDelay": 3600,
    "tokenProgram": "<token-program>",
    "recentBlockhash": "<cached>",
    "recentSlot": 341000000
  }
}
```

`extra` fields: `paymentFlow: "escrow"`, `feePayer` (becomes channel `payee` and `rent_payer`, co-signs `open`), `receiverAuthorizer` (becomes `authorized_signer`, signs vouchers only), `withdrawDelay` (integer > 0, becomes `grace_period`, should be >= `maxTimeoutSeconds`), `tokenProgram`, optional `memo`, `recentBlockhash`, `lastValidBlockHeight`, `recentSlot`, `validAfter`. `amount` is the max at verify time and the actual charge at settle time.

### PAYMENT-SIGNATURE payload (`UptoPayload`)

```json
{
  "from": "<payer-base58>",
  "maxAmount": "10000",
  "expiresAt": 1893456000,
  "validAfter": 1000000,
  "nonce": "123456789",
  "openSlot": 341000000,
  "channelId": "<channel-pda-base58>",
  "deposit": "10000",
  "authorizedSigner": "<receiverAuthorizer>",
  "openTransaction": "<base64-encoded-tx>",
  "type": "deposit"
}
```

Envelope: `{ "x402Version": 2, "accepted": {scheme, network, amount...}, "payload": {...} }` base64 in the `PAYMENT-SIGNATURE` header (v2 spec: https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md). Constraints: `deposit == maxAmount == accepts.amount`; `expiresAt` nonzero; client signature on `openTransaction` is the authorization; `type` is `"deposit"` (before handler) or `"claim"` (after handler, set by server). Channel PDA is derived from `[ "channel", from, extra.feePayer, asset, extra.receiverAuthorizer, u64(nonce), u64(openSlot) ]`.

Open tx rules: fee payer == `extra.feePayer`; signers exactly `{from, feePayer}`; no ALT lookups; optional compute budget (<= 400k CU, <= 5,000,000 microlamports/CU); exactly one `open` (disc 1); optional suffix of up to 3 Lighthouse + 1 Memo.

### Two-phase settle and refund

- Phase "deposit": facilitator co-signs and broadcasts `open` before the resource runs.
- Phase "claim": server sets `paymentRequirements.amount` to the metered charge and attaches `voucherSignature` (Ed25519 by `receiverAuthorizer`, over the 50-byte voucher) unless delegated to the facilitator; facilitator runs Ed25519 precompile + `settle_and_seal(has_voucher=1)` then `distribute`.
- **Refund:** "the server MUST NOT charge for work it did not deliver. It settles the request as a refund by setting `paymentRequirements.amount` to `0`." Zero amount uses `settle_and_seal(has_voucher=0)` then `distribute`; full deposit returns to the client, `transaction` in `PAYMENT-RESPONSE` is still non-empty.
- Client escape hatch if the server never settles: `request_close`, wait `withdrawDelay`, `withdraw_payer`.
- `PAYMENT-RESPONSE`: `{ success, payer, transaction, network, amount }` where `amount` may be `"0"`.
- Facilitator dedup cache keys: `upto:deposit:<network>:<channelId>`, `upto:<network>:<channelId>`, 120 s eviction.

### Facilitators that support `upto` on Solana (verified live via `/supported`, 2026-09-13)

| Facilitator | URL | Solana `upto`? |
|---|---|---|
| x402.org (testnet) | https://x402.org/facilitator/supported | **No.** `upto` only on `eip155:84532`; Solana devnet is `exact` only (feePayer `CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5`). |
| PayAI | https://facilitator.payai.network/supported | **No.** `exact` on Solana mainnet + devnet; `batch-settlement` on Solana mainnet (experimental, `apiKeyRequired: true`). No `upto` on any network. |
| Coinbase CDP | https://api.cdp.coinbase.com/platform/v2/x402/supported (API key) | **No.** Docs table: Solana and Solana Devnet are `exact` only. https://docs.cdp.coinbase.com/x402/network-support |
| Self-hosted | https://github.com/x402-foundation/x402/tree/main/examples/typescript/facilitator/upto | Yes. Express example on port 4022, "Solana Devnet SOL for channel opens" via `SVM_PRIVATE_KEY`, `upto` only. |

Conclusion: as of today, to run `upto` on Solana you self-facilitate (the spec allows the server to use its own key as `feePayer`) or run the reference facilitator.

---

## 4. MPP "session"

- MPP = **Machine Payments Protocol**, co-authored by Stripe and Tempo, released 2026-03-18, session primitive added 2026-04-29/30. Sources: https://stripe.com/blog/machine-payments-protocol, https://docs.stripe.com/payments/machine/mpp, https://mpp.dev/
- It is **not x402**. It is a separate HTTP 402 protocol using the `WWW-Authenticate: Payment` / `Authorization: Payment` headers defined in "The Payment HTTP Authentication Scheme" (`draft-httpauth-payment-01`). Specs: https://github.com/tempoxyz/mpp-specs and rendered at https://paymentauth.org/
- Intents: `charge`, `session`, `subscription`. Session methods today: Tempo, Lightning, Solana, XRPL, Stellar, EVM, Hedera (https://mpp.dev/ and repo tree `specs/methods/*/draft-*-session-00.md`).
- **Solana session spec:** https://paymentauth.org/draft-solana-session-00.html (source: https://github.com/tempoxyz/mpp-specs/blob/main/specs/methods/solana/draft-solana-session-00.md). Authors: Ludo Galabru, Jo Desormeaux (Solana Foundation), Michael Assaf (Moonsong Labs). Published 2026-09-09, Informational, expires 2027-03-13. Companion charge spec: https://paymentauth.org/draft-solana-charge-00.html
- Shape: challenge `request` carries `amount` (per unit), `unitType`, `suggestedDeposit`, `minimumDeposit`, `recipient`, `currency` (mint), `network` (`"mainnet" | "devnet" | "localnet"`, no default), `channelProgram` (base58, client must verify against its expected program), `recentBlockhash`, `recentSlot`, `feePayer`/`feePayerKey`, `voucherSigner: "client" | "operator"`, `operator`, `gracePeriodSeconds` (recommended 900), `idleTimeoutOptionsSeconds`, `distributionSplits [{recipient, shareBps}]`.
- Credential is a discriminated union on `action`: `open` (with base64 tx, `channelId`, `payer`, `deposit`, `openSlot`), `voucher` (client-signed cumulative voucher), `use` (bearer proof, operator-signed vouchers), `topUp`, `close`. Voucher JSON `{channelId, cumulativeAmount, expiresAt}` + `{signer, signature, signatureType: "ed25519"}`; the signed bytes are the same 50-byte layout as section 2.
- Same program: the repo's `docs/002-http-protocol.md` aligns to `draft-solana-session-00`, and pay-kit's `Session.ts` defaults `channelProgram` to `CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX` (https://github.com/solana-foundation/pay-kit/blob/main/typescript/packages/mpp/src/server/Session.ts, line 151).

Differences from x402 `upto` (from https://solana.com/news/payment-channels-1-million-payments-per-second and both specs):

| | x402 `upto` | MPP `session` |
|---|---|---|
| Scope | one metered HTTP request = one channel | one channel, many requests, streaming |
| Voucher signer | server (`receiverAuthorizer`) or delegated facilitator | client (`voucherSigner: client`) or operator |
| Close | facilitator seals right after the request | idle-timeout or cooperative `close` |
| Fee payer | x402 facilitator (`extra.feePayer`) | optional `feePayerKey`, else client |
| Splits | single `payTo` at 100% | `distributionSplits` |
| Headers | `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE` | `WWW-Authenticate: Payment` / `Authorization: Payment` / `Payment-Receipt` |

SDKs: `mppx` 0.9.3 (wevm, https://github.com/wevm/mppx) has no `./solana` export; the Solana method lives in `@solana/pay-kit` 0.10.0 (deps `@solana/kit >=6.5.0`, `mppx >=0.5.5`) and `@solana/mpp` 0.7.0 (npm view 2026-09-13). pay-kit docs: https://pay.sh/docs/sdk/typescript (`createPayKit`, `createPayKitClient`, intents `charge/upto/session`).

---

## 5. `402.surfnet.dev` sandbox

- Landing page https://402.surfnet.dev is a Next.js app titled "Surfnet - Ephemeral Solana Networks" (content is client-rendered). pay-kit README calls it the "Live playground" and describes "the Solana Payment Sandbox (a hosted test validator, no real funds)" with a built-in faucet and receipt links: https://github.com/solana-foundation/pay-kit/blob/main/README.md
- RPC endpoint: **`https://402.surfnet.dev:8899`** (pay.sh TS quickstart uses `createPayKit({ rpcUrl: 'https://402.surfnet.dev:8899' })`, https://pay.sh/docs/sdk/typescript).
- Verified live 2026-09-13: `getVersion` -> `{"solana-core":"4.0.0","surfnet-version":"1.4.0"}`. `getGenesisHash` -> `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d` (it is a **mainnet fork**, so the mainnet CAIP-2 id applies).
- **Hosts the channel program: yes.** `getAccountInfo(CHNL...)` returns executable with the same programData as mainnet. Mainnet USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` exists (82-byte mint). Devnet USDC `4zMMC9...` does **not** exist on the sandbox (empty account).
- Faucet = Surfpool cheatcodes (https://solana.com/docs/tools/surfpool/rpc/cheatcodes). Verified live with a throwaway key:
  - `requestAirdrop [pubkey, 1000000000]` -> credited 1 SOL (min 890880 lamports).
  - `surfnet_setTokenAccount [owner, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", {"amount": 1000000}]` -> owner holds 1.000000 USDC. Optional 3rd param `tokenProgram` before `update`.
  - Other cheatcodes available: `surfnet_setAccount`, `surfnet_timeTravel`, `surfnet_pauseClock`, `surfnet_resetAccount`, `surfnet_streamAccount`, `surfnet_cloneProgramAccount`, `surfnet_getSurfnetInfo`.
- Local equivalent for CI: `@solana/surfpool` 1.5.0 npm package. pay-kit's harness does `Surfnet.startWithConfig({ remoteRpcUrl })`, `streamAccount(CHNL...)`, `fundSol`, `fundToken(owner, USDC, amount, TOKEN_PROGRAM)`: https://github.com/solana-foundation/pay-kit/blob/main/harness/src/onchain/surfnet.ts (also references a subscriptions program `De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44`).
- Not a facilitator: `https://402.surfnet.dev/supported` returns S3 `NoSuchKey`; port 8900 (WS) answers 400 to plain HTTP. pay CLI `--sandbox` targets `https://debugger.pay.sh` endpoints (https://github.com/solana-foundation/pay).

---

## 6. Mints, chain ids, x402 network ids

| Item | Value | Source |
|---|---|---|
| USDC mainnet-beta | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | https://developers.circle.com/stablecoins/usdc-contract-addresses |
| USDC devnet | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | https://developers.circle.com/stablecoins/usdc-on-testing-networks |
| Genesis hash mainnet-beta | `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d` | verified live `getGenesisHash` |
| Genesis hash devnet | `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` | verified live `getGenesisHash` |
| CAIP-2 mainnet-beta | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (first 32 chars of genesis) | https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md |
| CAIP-2 devnet | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` | same |
| CAIP-2 testnet | `solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z` | https://github.com/x402-foundation/x402/blob/main/typescript/packages/mechanisms/svm/src/constants.ts |
| x402 v1 names | `solana`, `solana-devnet` | `/supported` outputs above |
| x402 v2 names | the CAIP-2 ids; client registration pattern `"solana:*"` | https://docs.x402.org/core-concepts/network-and-token-support |
| Decimals | 6 | same |

---

## 7. Facilitator support today (verified live `/supported`, 2026-09-13)

- **Coinbase CDP:** `https://api.cdp.coinbase.com/platform/v2/x402/supported` (needs `CDP_API_KEY_ID`/`CDP_API_KEY_SECRET`; unauthenticated returns "Unauthorized"). Solana mainnet + devnet, **`exact` only**, v1 and v2, feePayer `BENrLoUbndxoNMUS5JXApGMtNykLjFXXixMtpDwDR9SP`. `upto`/`batch-settlement` are EVM only. Sources: https://docs.cdp.coinbase.com/x402/network-support, https://docs.cdp.coinbase.com/api-reference/v2/rest-api/x402-facilitator/get-supported-payment-schemes-and-networks
- **x402.org (testnet only):** `https://x402.org/facilitator`. Solana devnet `exact` v1+v2, feePayer `CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5`, `smartWalletSupported: true`. No Solana `upto`.
- **PayAI:** `https://facilitator.payai.network` (`/verify`, `/settle`, `/supported`; free tier, API keys at https://merchant.payai.network). Solana mainnet `exact` v1+v2 (feePayer `CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww`), devnet `exact` (feePayer `2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4`), mainnet `batch-settlement` experimental with `apiKeyRequired: true` and `batchPolicy` (USDC, min deposit 10000, max 100000000, `maxWithdrawDelay` 3600, 2 channels/account, idle close 86400 s). No `upto`.
- Other listed Solana facilitators (schemes not documented): Corbits, Dexter (`dexter.cash/facilitator`), Solvador, Meridian. https://docs.x402.org/dev-tools/facilitators
- `https://facilitator.pay.sh/supported` does not exist (Vercel `DEPLOYMENT_NOT_FOUND`).

---

## 8. Signing in Node with minimal deps

- **`node:crypto` alone (zero deps)** covers Ed25519 fully: `generateKeyPairSync('ed25519')`, `sign(null, data, privateKey)` -> 64-byte sig, `verify(null, data, publicKey, sig)`, `createPrivateKey({key, format:'jwk'})` for a raw 32-byte seed (JWK `d` = seed, `x` = pubkey, both 32 bytes), and `'raw-private'`/`'raw-public'` formats (Stability 1.1). Source: https://nodejs.org/api/crypto.html. Verified locally on Node v24.18.0 (sig length 64, verify true).
- WebCrypto `subtle.sign('Ed25519', ...)` is stable since v23.5.0 / v22.13.0 / v20.19.3 (added experimental v18.4.0). Source: https://nodejs.org/api/webcrypto.html
- **`@solana/kit`** 8.3.0 (engines `node >= 20.18.0`) is the Anza 2.x line of web3.js, zero third-party deps, uses native WebCrypto Ed25519; `@solana/keys` exports `generateKeyPair`, `createKeyPairFromBytes(64)`, `createKeyPairFromPrivateKeyBytes(32)`, `signBytes(privateKey, data)`, `verifySignature`. Polyfill `@solana/webcrypto-ed25519-polyfill` only for old runtimes. Sources: https://github.com/anza-xyz/kit, https://github.com/anza-xyz/kit/blob/main/packages/keys/README.md
- **`@solana/web3.js` 1.99.0** is the maintenance line (branch `maintenance/v1.x`); the whole Solana Foundation stack here (`payment-channels` client, `@x402/svm`, `@solana/pay-kit`) is built on `@solana/kit` and codama-generated instruction builders.
- Recommendation for Wallie: sign the 50-byte voucher and any off-chain message with `node:crypto` (`sign(null, ...)`) and a 32-byte seed; for building/signing the `open` transaction use `@solana/kit` (`createKeyPairSignerFromBytes`, which the x402 facilitator example also uses) plus the codama-generated `getOpenInstruction` vendored from `@x402/svm` or the payment-channels repo. Solana transaction signing is Ed25519 over the serialized message bytes, so `node:crypto` also works if we hand-encode the message; that is what `@solana/kit` does internally via WebCrypto.

---

## Open questions

1. **Hackathon**: no dates, tracks, rules or sponsors exist yet. Whether it ever launches depends on $50k of sponsor deposits. Recheck https://hackathons.solana.com/hackathons/agentic-payments-mtxd9fkr before committing effort.
2. **Devnet program upgrade authority and parity with mainnet**: both clusters point at the same programData address, but I could not confirm the deployed bytecode is byte-identical or who holds the upgrade authority. Not found in docs.
3. **`@payment-channels/client` on npm**: not published. No statement of intent to publish found. Vendoring the generated client (as `@x402/svm` does) is the only path today.
4. **Hosted `upto` facilitator for Solana**: none found (CDP, x402.org, PayAI all `exact` only on Solana). Whether CDP plans Solana `upto` is not stated anywhere I could find.
5. **402.surfnet.dev reset cadence and rate limits**: not documented. The faucet works without auth; how often state is wiped is not stated.
6. **pay-kit versions**: npm has `@solana/pay-kit` 0.10.0 but the repo `package.json` says 0.11.0; `@solana/mpp` npm 0.7.0 vs repo 0.10.0. Unpublished changes exist; check before pinning.
7. **MPP session on Solana "status"**: mpp.dev lists it as a supported method and the draft is dated 2026-09-09, but I found no production operator besides the pay.sh/Alibaba Cloud announcement. Maturity beyond "draft-00" is not stated.
8. **Node `crypto.sign` Ed25519 "Added in" versions**: the docs page did not surface the history rows through my fetch; Ed25519 support in `sign`/`verify` predates Node 12 in practice, but the exact row was not captured.
