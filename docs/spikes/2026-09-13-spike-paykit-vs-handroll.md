# Spike: pay-kit / @x402/svm vs hand-roll for allowance-kit's Solana rail

Date: 2026-09-13. Node v24.18.0, npm 11.16.0. Spike dir: `scratchpad/spike-paykit/`. Project untouched.

## Verdict

Do not build on `@solana/pay-kit`. Build on `@x402/svm` + `@x402/core` for the wire format and the channel program client, loaded as an **optional peer** the same way `viem` is today (`src/live.ts:172-181` pattern), and keep allowance-kit's own `paymentGate` / `Facilitator` contract (`src/seller.ts:73-80`) as the policy seam. Hand-roll nothing on the channel side.

Why not pay-kit: it is an opinionated server framework (gates, pricing catalogue, MPP), 0.10.0 with 276 weekly downloads, pulls `mppx` -> `viem` (72 MB) and `@solana/kit` 6.x as hard deps, vendors a pinned copy of `@x402/svm` 2.23.0 inside its bundle, and its channel-operator code (`X402Upto`) is a private adapter with no public constructor path other than `createPayKit`. It gives allowance-kit nothing that `@x402/svm` does not already export, and costs a framework.

Why not a full hand-roll: the `exact` payload is a base64 v0 transaction with 4 instructions and a partial signature; the `upto` payload is a v0 `open` transaction against `CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX` plus a 50-byte voucher format. Reproducing that without `@solana/kit` means writing v0 message compilation, base58, ATA/PDA derivation (needs an ed25519 on-curve check that `node:crypto` does not expose), and the Codama-generated `open` / `settle_and_seal` / `distribute` instruction encoders. Feasible (~800-1200 LOC estimate, speculation) but it duplicates a maintained 65k-downloads/week package and any program upgrade breaks it silently.

Honest hybrid: allowance-kit core stays zero-dep. A `solana` module lazy-imports `@x402/svm` and `@solana/kit` (both optional peers). The buyer injects its own `TransactionPartialSigner` (address + `signTransactions`) built from `node:crypto` ed25519, proven below. The seller keeps its own verify -> policy -> settle loop and calls `@x402/svm`'s `UptoSvmScheme` facilitator in-process for channel open / voucher / seal. `@x402/core` (zod dep) can be avoided on the buyer path if allowance-kit encodes the `PAYMENT-SIGNATURE` header itself (it is `base64(JSON)`), but the `SchemeNetworkClient.createPaymentPayload` call itself does not need core at runtime.

## Packages

| package | version | published | deps (direct) | peer | license | weekly dl | repo |
|---|---|---|---|---|---|---|---|
| `@solana/pay-kit` | 0.10.0 | 2026-09-09 | 6: `@solana-program/compute-budget`, `@solana-program/token`, `@solana-program/token-2022`, `@solana/keychain-memory`, `@solana/kit >=6.5`, `mppx >=0.5.5` | none | MIT (README; npm `license` field absent) | 276 | github.com/solana-foundation/pay-kit (`typescript/packages/pay-kit`), created 2026-06-26 |
| `@x402/svm` | 2.25.0 | 2026-09-04 | 5: `@x402/core ~2.25`, `@noble/hashes`, `@solana-program/token 0.9`, `token-2022 0.6`, `compute-budget 0.11` | `@solana/kit >=5.1.0` | Apache-2.0 | 65,377 | github.com/x402-foundation/x402 |
| `@x402/core` | 2.25.0 | 2026-09-03 | 1: `zod ^3.24` | none | Apache-2.0 | 224,294 | same |
| `@x402/fetch` | 2.25.0 | 2026-09-04 | 1: `@x402/core` | none | Apache-2.0 | n/a | same |
| `@x402/express` | 2.25.0 | 2026-09-04 | `@x402/core`, `@x402/extensions` | `express ^4||^5`, `@x402/paywall` | Apache-2.0 | | same |
| `@x402/hono` | 2.25.0 | 2026-09-04 | `@x402/core`, `@x402/extensions` | `hono ^4`, `@x402/paywall` | Apache-2.0 | | same |
| `x402` (legacy v1 monopackage) | 1.2.0 | 2026-04-16 | 13 incl. `viem`, `wagmi`, `@solana/kit ^5`, zod | | Apache-2.0 | | x402-foundation |
| `mppx` (pulled by pay-kit) | 0.9.3 | 2026-09-11 | `ox`, `zod ^4`, `@stripe/stripe-js`, `eventsource-parser`, `structured-headers`; pulls `viem` | | MIT | 89,071 | github.com/wevm/mppx |
| `@solana/payment-channels` | 404 | | | | | | |
| `@solana-program/payment-channels` | 404 | | | | | | |

No standalone payment-channels TS client exists on npm. The channel client (Codama-generated instruction encoders, PDA finders, voucher codec) ships **inside** `@x402/svm` (`dist/esm/chunk-HUAWM4VZ.mjs`) and is duplicated inside `@solana/pay-kit` (`dist/chunk-FJARCEIW.js:5193`, from `../mpp/dist/generated/payment-channels/*`). `npm search` shows only unrelated third-party channel packages (`@otomat/payment-channel`, `@toon-protocol/client`).

## Install weight

Full spike (`@solana/pay-kit @x402/svm @x402/core @x402/fetch`):
- `du -sh node_modules` = **298 MB**; 250 packages (`npm ls --all --parseable`), 20 top-level dirs + 61 scoped.
- Largest: `@solana/*` 163 MB (kit 6.10.0 + ~50 sub-packages), `viem` 72 MB (via `mppx`), `mppx` 14 MB, `ox` 13 MB.
- Peer warnings: `@solana-program/zk-elgamal-proof@0.1.0` wants `@solana/kit ^5.0`, gets 6.10.0 (`ERESOLVE overriding peer dependency` x3). `@x402/svm`'s own `@solana-program/*` pins (kit ^5) get nested copies under `node_modules/@x402/svm/node_modules/`, so two kit majors coexist.

Minimal (`min-svm/`: `@x402/svm @x402/core @x402/fetch @solana/kit`):
- **36 MB**, 52 packages, `@solana/kit` resolves to **5.5.1** (svm's `@solana-program/*` pins force 5.x). No peer warnings.

allowance-kit today (`package.json`): zero `dependencies`, `viem ^2.55` optional peer. Either option breaks the zero-dep rule if made a hard dep; as an optional peer it matches the existing viem pattern.

## Buyer API

`@x402/svm` (types in `dist/esm/*.d.mts`):
- `ExactSvmScheme(signer: ClientSvmSigner, config?: { rpcUrl?: string })` (`exact/client`), method `createPaymentPayload(x402Version, requirements) -> { x402Version, payload: { transaction: base64 } }`. Source: `chunk-FKOM6YTW.mjs:57-133`.
- `UptoSvmScheme(signer, config?)` (`upto/client`), same method, payload `{ channelId, deposit, expiresAt, from, maxAmount, nonce, openSlot, openTransaction, authorizedSigner, validAfter }`. Source: `chunk-ITL5XJMN.mjs:39-90`.
- `ClientSvmSigner = TransactionSigner` from `@solana/kit` (`signer-DflRpcCU.d.mts`). `toClientSvmSigner(s)` is the identity function (`index.mjs:73-75`).
- Network/scheme selection: `@x402/core/client` `x402Client.register("solana:*", scheme)`; the scheme class's `scheme` field (`"exact"` / `"upto"`) plus the network key select. Wildcard `solana:*` supported. `createSvmClient` (`@x402/svm/client`) registers v2 wildcard + v1 names.
- Fetch wrapper: `@x402/fetch` `wrapFetchWithPayment(fetch, x402Client)`.
- `upto` on the buyer side requires the seller's `accepts[].extra` to carry `feePayer`, `receiverAuthorizer`, `withdrawDelay` (`chunk-YHVO7YOO.mjs:257-272`); `recentBlockhash`/`lastValidBlockHeight`/`recentSlot`/`tokenProgram` are optional and skip RPC round-trips when present (`:330-375`).
- The buyer never sends: both schemes return a **partially signed** v0 transaction; `feePayer` (the seller/facilitator) is a required second signer.

`@solana/pay-kit/client`: `createPayKitClient({ signer: KeyPairSigner, rpcUrl, accept?, onProgress? })` -> `{ fetch(input, init?, protocol?) }`. Requires a full `KeyPairSigner` (not just a partial signer). Dispatches MPP vs x402 by response header. No scheme selector, no policy hook.

## Seller API

`@x402/core/server` `x402ResourceServer(facilitatorClients)` has the hooks allowance-kit needs, all chainable (`x402Client-pTJv8yPe.d.mts:152-185` and class decl):
- `onBeforeVerify(ctx) -> void | {abort, reason} | {skip, result}`
- `onAfterVerify(ctx) -> void | {skipHandler} | {abort, reason}` (this is the policy slot between verify and settle)
- `onBeforeSettle(ctx) -> void | {abort} | {skip, result}`
- `onAfterSettle`, `onVerifyFailure`, `onSettleFailure`, `onVerifiedPaymentCanceled`.
- Custom facilitator: constructor takes any object implementing `FacilitatorClient { verify, settle, getSupported }`. In-process `x402Facilitator` (`@x402/core/facilitator`) has the same six hooks (`facilitator/index.d.mts:54-59`).
- Framework shims: `@x402/express`, `@x402/hono`; core `x402HTTPResourceServer.processHTTPRequest(HTTPRequestContext)` is framework-free.
- Server-side scheme registration: `ExactSvmScheme` (`exact/server`, options `{ rpcUrl }`), `UptoSvmScheme` (`upto/server`, options `{ receiverAuthorizerSigner?: MessagePartialSigner, withdrawDelay?, rpcUrl? }`).

allowance-kit's own `paymentGate` (`src/seller.ts:73-80`) already does verify -> settle against a `Facilitator` interface; a policy check is one line between them. Nothing in `@x402/core` is needed to keep that seam.

`@solana/pay-kit` server: `createPayKit({ network, operator: { signer }, rpcUrl, pricing, accept: ['x402'] })`, verbs `requirePayment` / `paid` / `payment`, shims `express` / `hono` / `fetch`. `ProtocolAdapter` contract (`src/adapter.ts`) has a single `verifyAndSettle` method: **no hook between verify and settle** at the adapter level. Policy must be done before calling `requirePayment` or inside the route. `accept: ['x402']` on a gate with fees throws (`gate.ts:215-218`).

## Channel support

Both sides exist in `@x402/svm`, none needs pay-kit:

- Program: `PAYMENT_CHANNELS_PROGRAM_ADDRESS = "CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX"` (`chunk-HUAWM4VZ.mjs:125`). Instruction encoders present: `getOpenInstruction` (`:622`), `getSettleAndSealInstruction` (`:314`), `getDistributeInstruction` (`:240`); `OPEN_SLOT_WINDOW = 1500n` (`:677`).
- Voucher: `encodeVoucherMessageBytes({channelId, cumulativeAmount, expiresAt})` -> 50 bytes = magic `[86,1]` + 32-byte channel PDA + u64 LE cumulative + i64 LE expiresAt (`chunk-HUAWM4VZ.mjs:21-34`). Signed with plain ed25519 by the `receiverAuthorizer` (`MessagePartialSigner.signMessages`).
- Buyer: `UptoSvmScheme.createPaymentPayload` builds the `open` tx (`buildOpenPaymentChannelTransaction`, `:696-804`): compute budget x2, `open`, memo; fee payer = seller/facilitator, payer partially signs.
- Operator (facilitator) side: `@x402/svm/upto/facilitator` `UptoSvmScheme(signer: FacilitatorSvmSigner, config)`:
  - `settle()` with no `voucherSignature` and `requirements.amount === payload.maxAmount` = **deposit path**: simulates, co-signs as fee payer, broadcasts `open` (`upto/facilitator/index.mjs:1393-1482`, `settleDeposit`).
  - `settle()` with `voucherSignature` and `requirements.amount = actual` = **claim path**: verifies voucher, fetches channel, builds `settle_and_seal` + `distribute`, signs, sends (`:1598-1717`, `settleClaim`).
  - `verify()` is a read-only preflight since 2.23 (noted in pay-kit `dist/index.js:6921`).
  - Delegated mode: `authorizerSigner`, `resolveCallerIdentity`, `delegatedAuthStore` in `UptoSvmFacilitatorConfig` let the facilitator sign vouchers on the seller's behalf.
  - Rent housekeeping: `UptoSvmRentCleanupManager` (`abandon_close` / `distribute` / reclaim batching).
  - Storage seams: `UptoChannelStorage`, `PendingSettlementStore`, `UptoDelegatedAuthStore` (in-memory impls provided).
- Metering: not in `@x402/svm`. pay-kit adds a 30-line `Charge` class (`dist/index.js:6850-6867`: `charge(baseUnits)` clamped to ceiling, `settledBaseUnits()`) and `X402Upto.settle(verified, actual)` which signs the voucher with the operator key and calls facilitator `settle` on the claim path (`:6997-7024`). This is the entire "operator" layer pay-kit adds over `@x402/svm`. Trivial to reproduce.
- One channel per request: pay-kit escrows the ceiling on `open` per request and seals after the handler (`paykit.ts:418-470`). Multi-request channels (one open, many vouchers) are supported by the program (`cumulativeAmount`) but neither library exposes a session-style API for x402 `upto`; pay-kit's `session` gate is MPP-only (`gate.ts:26`).

Grep hits (short):
- `"solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"`: `@x402/svm chunk-YHVO7YOO.mjs:37` (`SOLANA_MAINNET_CAIP2`), pay-kit `src/protocol.ts:53`.
- devnet: `"solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"` at `chunk-YHVO7YOO.mjs:38`. **`EQnzfwaE` is not present in any package**; the CAIP-2 devnet reference these libraries use is `EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (first 32 chars of the devnet genesis hash). If allowance-kit's docs use `EQnzfwaE…`, that is a mismatch to fix on our side.
- `facilitator`: 8 files in `@x402/core/dist/esm`, 8 in `@x402/svm/dist/esm`; pay-kit `src/config.ts:30` ("vendored exact-scheme facilitator").
- `session`: 0 files in `@x402/svm`; pay-kit `src/gate.ts:26` (MPP only).

## Signer injection

- `@x402/svm` buyer signer = `@solana/kit` `TransactionSigner` = union of `TransactionPartialSigner | TransactionModifyingSigner | TransactionSendingSigner`. `TransactionPartialSigner` is a plain object `{ address: Address, signTransactions(txs) -> SignatureDictionary[] }` (`@solana/signers/dist/types/transaction-partial-signer.d.ts`). `partiallySignTransactionMessageWithSigners` accepts it. **A caller can inject a signer with no kit key handling.** Proven in `try.ts` with `node:crypto` ed25519: the transaction signs and decodes identically to the kit-generated key path.
- Facilitator/operator signer = `FacilitatorSvmSigner { getAddresses, getSigner?(feePayer) -> TransactionSigner & MessagePartialSigner, signTransaction(base64, feePayer, network), simulateTransaction, sendTransaction, confirmTransaction, getLatestBlockhash, ... }` (`signer-DflRpcCU.d.mts`). `toFacilitatorSvmSigner(kitSigner, rpcConfig)` builds it from a kit signer (`index.mjs:127+`), but the interface is plain and can be implemented by hand around `node:crypto` + raw JSON-RPC. `upto` requires `getSigner` (voucher signing via `signMessages`).
- pay-kit: `PayKitSigner { pubkey, sign(message), signer: MessagePartialSigner & TransactionPartialSigner, isFeePayer, isDemo }`; `Signer.from(kitSigner)` wraps any keychain signer (`src/signer.ts:14-20, 75`). Client side needs a full `KeyPairSigner`.
- `@solana/kit` is required as a runtime import by `@x402/svm` regardless of who signs (transaction message building, codecs, RPC). `@solana/web3.js` is not used (README's last line is stale).

## Script result

`spike-paykit/try.ts` (run with `node try.ts`, Node 24 type-stripping works after `"type": "module"` in `package.json`). Two runs, kit key and `node:crypto` key. Output in `try.out`:

- Kit key `9wrYviX5Vih2ApuFajUeBegsGWhHL12VK18NVza76VKL`, 82 ms; node:crypto key `3fDFoj9bPswc6sRb9bnqwNky6W9ErNDWfvRhUXF1AS3C`, 26 ms. One devnet RPC call (`fetchMint` for USDC decimals/program); blockhash was pinned via `extra.recentBlockhash`.
- Payload: `{ transaction: <base64> }`, 469 wire bytes, v0 message, 2 required signatures (feePayer `Ay1t…` = null/unsigned, payer = signed). Static accounts: feePayer, payer, payer ATA, payTo ATA, USDC devnet mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, ComputeBudget, Memo, Token program. Instructions: SetComputeUnitLimit(5 B), SetComputeUnitPrice(9 B), TransferChecked(10 B), Memo("spike").
- `PAYMENT-SIGNATURE` header = `encodePaymentSignatureHeader({x402Version:2, resource, accepted, payload})` = 1488 chars, base64 of JSON; round-trips through `decodePaymentSignatureHeader`.
- Full base64 of the node:crypto run: `AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACMh8ERMsiycTKR5jPeXOux10FdADQHRYHccGO73cHDF7cSa320uwFQzU/Hnqm405iHzGtXFas2JcA3mVkpA+QAgAIBBAiUErScK+VNVOSP/9on7T72v8li74CW7gEmJ912GrBg+SeBTTqScrVC6hqu9g971BDLomjuttTgWwZ+wrP3xAYrgueWiCejOsYB1zb7ualxkj1vJ7ZVt4jgNtXG3Jrk3T0F0v9ZVulbhkOsQH9ttW6uJjl0kF0QI+cdo95TKOHKWztELLORIVfxOpM9ATQoLQMrX/7NAaLb8bd5BgjfAC6nAwZGb+UhFzL/7K26csOb57yM5bvF9xJrLEObOkAAAAAFSlNamSkhBk0k6HFg2jh8fDW13bySu4HkH6hAQQVEjQbd9uHXZaGT2cvhRs7reawctIXtX1s3kTqM9YV+/wCpAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEBQAFAiBOAAAFAAkDAQAAAAAAAAAHBAIEAwEKDBAnAAAAAAAABgYABXNwaWtlAA==`

`spike-paykit/try-upto.ts` (bonus): `UptoSvmScheme.createPaymentPayload` built an `open` payload in 10 ms with **zero RPC calls** when `tokenProgram`, `recentBlockhash`, `recentSlot` are in `extra`. Output: `channelId 3tEGEKm67hQTRHHLy6eyBpCjbjN2WYbeQ92ziPWxFZTj`, `deposit/maxAmount 50000`, `nonce` (u64 salt), `openSlot 400000000`, `expiresAt = now + maxTimeoutSeconds`, `openTransaction` 755 bytes v0, 2 signers (feePayer unsigned), programs ComputeBudget x2, `CHNLx…`, Memo.

## Risks

1. Zero-dep rule. Any path that reuses the wire builders needs `@solana/kit` (5.x per svm's pins; 6.x if you also want pay-kit) at runtime. Mitigation: optional peer + lazy `import()` exactly like `src/live.ts:172-181`. Buyers on EVM never load it.
2. Kit major split. `@x402/svm` 2.25 pins `@solana-program/*` at kit-5 ranges; pay-kit needs kit >= 6.5. Installing both gives two kit copies and ERESOLVE warnings. Pick one; the min install resolves cleanly to kit 5.5.1.
3. pay-kit vendors `@x402/svm` 2.23.0 in its bundle (`dist/index.js:4477`), so it lags the published 2.25 and cannot be patched by bumping a dep. Also 276 downloads/week, 0.x, created 2026-06-26: API churn risk is real (speculation on churn; the version and age are facts).
4. `@x402/core` brings `zod` 3, but only on the header-codec path. Verified with a `node --import` resolve hook (`spike-paykit/hook.mjs`): importing `@x402/svm`, `@x402/svm/exact/client`, `@x402/svm/upto/client`, or `@x402/svm/upto/facilitator` loads **no** zod/viem/mppx/ox modules; importing `@x402/core/http` (`encodePaymentSignatureHeader`) loads zod. allowance-kit already encodes headers itself, so `@x402/core` stays type-only and never runs. Runtime footprint of the buyer path is `@solana/kit` + `@solana-program/{token,token-2022,compute-budget}` + `@noble/hashes` (RSS delta 40 MB on import).
5. Hand-roll cost if we go dependency-free: v0 message compile + base58 + PDA derivation (ed25519 on-curve check) + Codama instruction layouts for `open`/`settle_and_seal`/`distribute` + voucher codec. The voucher (50 bytes) and header codec are trivial; the rest is where bugs hide and where a program upgrade would break us without a signal. Not recommended.
6. One-channel-per-request model. Neither library exposes a long-lived `upto` session (open once, many vouchers, seal later). If the hackathon story is "stream micro-payments over one channel", allowance-kit must own that state machine itself on top of `@x402/svm`'s facilitator (`settleDeposit` once, then N `Charge`-style vouchers, then one `settleClaim`). The program supports it (`cumulativeAmount`); the library API does not package it.
7. Policy hook location. With `@x402/core` server: `onAfterVerify` returning `{abort}` sits exactly between verify and settle. With allowance-kit's own `paymentGate`: insert between `src/seller.ts:73` and `:80`. With pay-kit: no adapter-level hook (`verifyAndSettle` is one call); policy has to run before `requirePayment`.
8. Devnet CAIP-2 id used by the ecosystem is `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`, not `EQnzfwaE…`. Check allowance-kit docs/consts before wiring.
9. Nothing was sent on-chain; `fetchMint` was the only network call. Settlement paths (`settleDeposit`, `settleClaim`) were read, not executed.
