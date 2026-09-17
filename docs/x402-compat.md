# x402 wire compatibility — v1 vs v2 (ticket L-01)

Research date: **2026-09-07**. Author: implementing agent (L-01). Method: read this repo's
own wire code, quote the x402 v2 specification and the CDP/x402.org docs from primary
sources, then hit real live x402 sellers with a plain read-only `GET` (no payment, nothing
signed) and record the raw 402s. All source URLs and access date are given inline.

This document began as the output of L-01 (research only). It now tracks the shipped code:
L-02 added v2 alongside v1 and closed against a real settled payment (§8, §9), and the Solana
rail landed (§10). **Status as of 2026-09-16:** the buyer (`payingFetch`) speaks v1 and v2 by
auto-detection; the `CdpFacilitator` is v2-capable and version-selectable; our own EVM seller
(`paymentGate`) still advertises v1 on purpose (its Base 402 stays byte-identical), and only
the Solana rail advertises v2. §1, §2, §5 and §6 describe the current code; §3 and §4 are the
primary-source evidence dated 2026-09-07.

---

## 1. Summary verdict

**The live ecosystem is x402 v2, and this repo's buyer now speaks v1 and v2.** Every one of
the 100 resources in Coinbase's live CDP bazaar, and every real endpoint the §4 probe hit,
answers with `x402Version: 2`, a CAIP-2 network (`eip155:8453` Base, `eip155:84532` Base
Sepolia), the challenge in the `PAYMENT-REQUIRED` header, and the price field named `amount`.
No live v1 seller exists in the bazaar. A v1-only buyer cannot transact against any of them,
and it fails before it reaches a facilitator: it reads `accepts` from the JSON body, has no
`eip155:*` mapping, and reads the `maxAmountRequired` field v2 sellers omit.

The buyer handles both wires by detecting the version from `x402Version` and answering in kind
(`src/payer.ts:216`, `:276`). It reads the challenge from the `PAYMENT-REQUIRED` header or the
JSON body, whichever carries `accepts[]` (`payer.ts:201-215`); reads the price from `amount` or
`maxAmountRequired` (`src/types.ts:30`); maps CAIP-2 to and from bare names so a seller quoting
`eip155:84532` is the same chain as a `base-sepolia` agent (`src/live.ts:80-92`, `:128`); sends
the v2 `PAYMENT-SIGNATURE` header and nested `{ accepted, payload }` envelope, or the v1
`X-PAYMENT` header and flat envelope (`payer.ts:302`, `src/live.ts:548-561`); and reads the
receipt from `PAYMENT-RESPONSE`/`transaction` (v2) or `x-payment-response`/`txHash` (v1)
(`payer.ts:334`, `:344`). This is proven end to end: real testnet USDC settled against a
third-party v2 seller (§9), and real mainnet USDC settled (M-01/M-02, 2026-09-07).

v1 is not removed (decision **D-5**). Two places stay v1 on purpose. Our own EVM seller
(`paymentGate`) advertises `x402Version: 1`, reads `x-payment`, and replies `X-PAYMENT-RESPONSE`
so its Base 402 body is byte-identical to what it always emitted (`src/seller.ts:73-75`, `:232`,
`:299`); only the Solana rail advertises v2 (`seller.ts:95-109`). And `CdpFacilitator` defaults
to `x402Version: 1` so a v1 seller keeps working, taking `2` when a v2 caller constructs it
(`src/facilitator-cdp.ts:74`, `:119-123`). The whole v1 path stays covered in
`test/wire.test.ts`.

One caveat carried from L-01: the CDP `/verify` and `/settle` v2 body shape follows the spec
and matches what live sellers advertise, but has not been round-tripped against a real CDP
`/verify` with CDP credentials. The §9 settlement went through Mart402's own facilitator, not
CDP. See the honesty note in `facilitator-cdp.ts`.

---

## 2. What this repo does today (current code, file:line)

The buyer path is version-detecting; the seller and facilitator keep v1 as the default and add
v2 where a seller needs it.

**Version detection and reply (buyer):**

- `src/payer.ts:216` — `const isV2 = Number(headerJson?.x402Version ?? bodyJson?.x402Version ?? 1) >= 2;`
- `src/payer.ts:276` — the outgoing payment answers in kind: `x402Version: isV2 ? 2 : 1,`
- `src/payer.ts:201-215` — reads the challenge from the base64 `PAYMENT-REQUIRED` header or the
  JSON body, preferring whichever carries `accepts[]` (a v2 seller often leaves the body `{}`,
  §4c).

**Header names (buyer): both families, chosen by version:**

- `src/payer.ts:302` — request header `isV2 ? "PAYMENT-SIGNATURE" : "X-PAYMENT"`
- `src/payer.ts:334` — receipt header `isV2 ? "payment-response" : "x-payment-response"`
- `src/payer.ts:344` — receipt hash `receipt.transaction ?? receipt.txHash` (v2 names it
  `transaction`, v1 `txHash`)

**Network identifiers: bare names and CAIP-2, mapped both ways:**

- `src/live.ts:56-72` — `NETWORKS` keyed by `base` (8453) and `base-sepolia` (84532)
- `src/live.ts:80-83` — `CAIP2_ALIASES`: `eip155:8453 → base`, `eip155:84532 → base-sepolia`
- `src/live.ts:90-92` — `networkInfo` resolves a bare name or a CAIP-2 id
- `src/live.ts:128-142`, `:451` — the live agent's hard network constraint is `sameChain`, not
  string-equality, so `eip155:84532` is accepted for a `base-sepolia` agent and a genuinely
  different chain is still refused before anything is signed.

**Price field: `amount` (v2) or `maxAmountRequired` (v1):**

- `src/types.ts:3-24` — `AcceptsEntry` carries both `amount` and `maxAmountRequired`, plus the
  CDP bazaar's `recipient`/`currency` aliases (§4a)
- `src/types.ts:30-42` — `offerAmount`/`offerPayTo`/`offerAsset` read the v2 field first, fall
  back to v1
- `src/payer.ts:231` — the buyer reads the amount through `offerAmount(rawOffer)`

**Signed payload shape: flat (v1) or nested (v2), same signature:**

- `src/live.ts:507-572` — `encodePaymentEvm` signs one EIP-712 `TransferWithAuthorization`, then
  emits either the flat v1 `{ x402Version, scheme, network, resource, payload }` or the nested
  v2 `{ x402Version:2, accepted, payload }`, chosen from `unsigned.x402Version`
- `src/live.ts:558`, `src/payer.ts:287` — the v2 `accepted` echoes the seller's chosen offer
  verbatim (`acceptedOffer`), because a v2 facilitator matches it against what it advertised and
  throws on fields it never sent
- `src/payer.ts:400-413` — the mock encoder mirrors both shapes so a keyless test buyer can
  answer either seller

**Facilitator: v2-capable, version-selectable, v1 by default:**

- `src/facilitator-cdp.ts:74` — `this.x402Version = opts.x402Version ?? 1;`
- `src/facilitator-cdp.ts:114-123` — posts `{ x402Version, paymentPayload, paymentRequirements }`
  to `/platform/v2/x402/{verify,settle}` opaquely, so the same class serves both versions
- `src/facilitator-cdp.ts:108` — reads `res.transaction ?? res.txHash` for the settled hash

**Seller (`paymentGate`): v1 for EVM by design, v2 for Solana:**

- `src/seller.ts:73-75` — `versionFor`: Solana → 2, EVM and mock → 1
- `src/seller.ts:232`, `:299` — the EVM seller reads `x-payment` and replies `X-PAYMENT-RESPONSE`
- `src/seller.ts:95-109` — a Solana gate advertises v2: CAIP-2 network, the USDC mint as
  `asset`, and `extra.feePayer` from the facilitator's `/supported`

`extra.name` / `extra.version` (the EIP-712 USDC domain) are unchanged between v1 and v2
(`src/live.ts:574-583`).

---

## 3. What the spec says now (quoted, with source URLs + date)

Accessed 2026-09-07.

**Primary spec — `coinbase/x402`, `specs/x402-specification-v2.md`**
(https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md, raw fetched
2026-09-07). Its Version History table:

> | v2.0 | 2025-12-9 | Protocol v2: CAIP-2 networks, restructured PaymentPayload/Required, ResourceInfo separation, extensions support |

- **`x402Version` must be 2.** PaymentRequired field table: "`x402Version` | number |
  Required | Protocol version identifier (**must be 2**)". PaymentPayload, SettlementResponse
  and VerifyResponse all carry `"x402Version": 2` in their examples.
- **`accepts[]` entry fields** (spec §5.1.2): `scheme`, `network`, **`amount`** (not
  `maxAmountRequired`), `asset`, `payTo`, `maxTimeoutSeconds`, optional `extra`. The example
  network is `"eip155:84532"`.
- **Network identifiers are CAIP-2, required** (spec §11.1): "Networks in x402 v2 use CAIP-2
  … `{namespace}:{reference}` (e.g., `eip155:8453` for Base mainnet)". Listed: `eip155:84532`
  Base Sepolia, `eip155:8453` Base mainnet, plus Avalanche and Solana.
- **Header name** appears in the spec's own example error string (§5.1.1):
  `"error": "PAYMENT-SIGNATURE header is required"`. The spec is otherwise transport-agnostic
  ("Transport-specific implementations map these response types to appropriate transport
  mechanisms"); the concrete HTTP header names come from the launch post below and are
  confirmed empirically in §4.
- **PaymentPayload is restructured** (spec §5.2.2): top-level `x402Version`, optional
  `resource`, **`accepted`** (the chosen PaymentRequirements object), `payload`
  (scheme-specific — for exact-EVM, `{ signature, authorization }`), `extensions`.
- **Facilitator `POST /verify` body** (spec §7.1):
  `{ x402Version: 2, paymentPayload, paymentRequirements }`. Same three keys this repo
  already posts, but v2 version and v2 nested shapes.
- **Discovery** (spec §8.1) returns items each with their own `x402Version` field — the
  example even shows a resource with `"x402Version": 1`, i.e. the directory is version-aware
  and *could* still list a v1 resource.

**Launch post — "Introducing x402 V2"** (https://www.x402.org/writing/x402-v2-launch,
accessed 2026-09-07; page last-updated 2026-06-24). Backward-compatibility, verbatim:

> "x402's reference SDKs are fully backward-compatible with V1."

It also states the header change: the deprecated `X-*` headers are removed in favour of
`PAYMENT-SIGNATURE`, `PAYMENT-REQUIRED`, `PAYMENT-RESPONSE`, with all payment data moved to
headers so the response body is freed up; and that networks/assets adopt CAIP standards.

**Network & token support**
(https://docs.x402.org/core-concepts/network-and-token-support, accessed 2026-09-07): lists
EVM networks exclusively as `eip155:<chainId>` (`eip155:8453`, `eip155:84532`, `eip155:1`),
Solana as `solana:<genesisHash>`, etc. No bare-name form is documented.

**CDP facilitator docs**
(https://docs.cdp.coinbase.com/x402/core-concepts/facilitator, accessed 2026-09-07): the
supported-networks/schemes table is presented as "x402 v2 support," and networks are given
in CAIP-2 (`eip155:8453`, `eip155:84532`). No v1/`X-PAYMENT` backward-compatibility statement
appears in the facilitator doc itself.

---

## 4. Raw 402 responses observed from real endpoints (verbatim)

Source of endpoints: the **CDP bazaar discovery API**, a public unauthenticated GET —
`https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources` (HTTP 200, 100 items,
fetched 2026-09-07). **Every one of the 100 items used `"network": "eip155:8453"`.** Each
item carries both v1 and v2 field names fused together (`amount` **and** `maxAmountRequired`,
`payTo` **and** `recipient`, `asset` **and** `currency`) — the directory dual-populates for
compatibility, but the live sellers themselves (below) mostly emit v2 fields only.

I then issued a plain read-only `GET` (no `X-PAYMENT`, no payment, nothing signed) to five
endpoints. Recorded verbatim below (long base64 blobs and JSON-schema `extensions` elided
with `…` where noted; the payment-relevant fields are complete).

### 4a. `api.onesource.io` — GET https://api.onesource.io/api/chain/block-number (2026-09-07)

Status `HTTP/2 402`. Selected response headers:

```
content-type: application/json
cache-control: no-store
payment-required: eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQYXltZW50IHJlcXVpcmVkI… (base64)
www-authenticate: Payment id="…", realm="api.onesource.io", method="tempo", intent="charge", request="…"
```

Response body (verbatim, `extensions` schema elided):

```json
{"x402Version":2,"resource":{"url":"https://api.onesource.io/api/chain/block-number","description":"Latest Ethereum block height - current chain tip via eth_blockNumber","mimeType":"application/json"},"accepts":[{"scheme":"exact","network":"eip155:8453","asset":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","currency":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","amount":"1000","maxAmountRequired":"1000","payTo":"0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea","recipient":"0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea","maxTimeoutSeconds":3600,"extra":{"credentialTypes":["authorization"],"name":"USD Coin","version":"2"}},{"scheme":"batch-settlement","network":"eip155:8453", … }],"extensions":{ … },"error":"Payment required","meta":{"cost_usdc":"0.001","endpoint":"/api/chain/block-number","network":"eip155:8453"},"payment_rails":[{"assets":["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"],"chain":"eip155:8453","rail":"x402","recipient":"0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea"},{"assets":[…],"chain":"tempo:4217","rail":"mpp","recipient":"0x19B8e99079A5558ff4460357b0a78e14a7F600B7"}], … }
```

Note: onesource puts `accepts` in the body **and** the base64 `payment-required` header, and
dual-populates v1 field names (`maxAmountRequired`, `recipient`, `currency`) alongside the v2
ones. It advertises a second `batch-settlement` scheme and a non-x402 `tempo` rail too.

### 4b. `weather.payapi.market` — GET https://weather.payapi.market/current (2026-09-07)

Status `HTTP/2 402`, header `payment-required: eyJ4NDAyVmVyc2lvbiI6IDIs…`. Body (verbatim,
`extensions` elided) — note this seller emits **v2 fields only** (no `maxAmountRequired`, no
`recipient`):

```json
{"x402Version":2,"error":"Payment required","resource":{"url":"https://weather.payapi.market/current","description":"Current weather conditions for any global location — temperature, feels-like, humidity, precipitation, wind, and human-readable weather description."},"accepts":[{"scheme":"exact","network":"eip155:8453","asset":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","amount":"1000","payTo":"0xFFc458dB291b4ABcE020fE3de4f91F2770E537b1","maxTimeoutSeconds":300,"extra":{"name":"USD Coin","version":"2"}}],"extensions":{ … }}
```

### 4c. `x402uselessfacts.vercel.app` — GET https://x402uselessfacts.vercel.app/api/useless-fact (2026-09-07)

Status `HTTP/2 402`. **Response body is literally `{}`** — the challenge lives only in the
`payment-required` base64 header. Decoded `accepts[0]` from that header (verbatim):

```json
{"x402Version":2,"accepts":[{"scheme":"exact","network":"eip155:8453","amount":"1000","asset":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","payTo":"0xD7d49D6a12Ee3852f29A52A40908069bF4e48914","maxTimeoutSeconds":300,"extra":{"name":"USD Coin","version":"2"}}]}
```

This is the case that most clearly breaks our buyer: `payer.ts:119` does
`await first.json()` → `{}`, so `required.accepts?.[0]` is `undefined` and we return
"seller returned 402 with no acceptable payment methods" without ever looking at the header.
`vibesprings.net/api/price/btc-usd` (also fetched 2026-09-07) behaves identically — 402 with
body `{}`, everything in the header, `network eip155:8453`, `amount "2000"`.

### 4d. `gas.apitoll.cloud` — GET https://gas.apitoll.cloud/v1/base/gas (2026-09-07)

Status `HTTP/1.1 402 Payment Required`, header `PAYMENT-REQUIRED: eyJ4NDAyVmVyc2lvbiI6Mi…`
(uppercase). Body is a plain human message:
`{"error":"payment_required","message":"This endpoint requires an x402 micropayment (USDC on Base). See the 402 \`accepts\` for payment details."}`.
Decoded header `accepts[0]`: `scheme "exact"`, `network "eip155:8453"`, `amount "1000"`,
`asset 0x8335…2913`, `extra.name "USD Coin"`, `extra.version "2"`.

### 4e. `api.exa.ai/search` — GET (2026-09-07)

A `GET` returns `HTTP/2 404 {"error":"Not found"}` (the endpoint is POST-only; I did not
POST, to stay strictly read-only). Still evidence: its CORS header
`access-control-expose-headers` lists `PAYMENT-REQUIRED,PAYMENT-RESPONSE,payment-required,payment-response,WWW-Authenticate,Payment-Receipt,…`
— i.e. it too uses the v2 `PAYMENT-*` header family, not `X-PAYMENT`.

**Endpoints down / not fully testable:** the x402.org testnet facilitator discovery path
(`https://x402.org/facilitator/discovery/resources`) returned 404 (that host serves the
facilitator, not this route). Exa could not be driven to a 402 without a POST body. Neither
gap changes the verdict; the CDP bazaar and the four 402s above are conclusive.

---

## 5. Field-by-field: what the code does, against what v2 requires

The middle column is the current code. The buyer handles both wires; each row notes where the
seller or facilitator differs.

| Field / header | What this repo does now | v2 — what live sellers & the spec require |
| --- | --- | --- |
| `x402Version` | buyer detects and echoes (`payer.ts:216`, `:276`); facilitator selectable, default 1 (`facilitator-cdp.ts:74`); EVM seller 1, Solana seller 2 (`seller.ts:73`) | `2` (required; spec §5.1.2) |
| Challenge transport | buyer reads the `PAYMENT-REQUIRED` header or the body, whichever has `accepts[]` (`payer.ts:201-215`) | 402 **`PAYMENT-REQUIRED` header** (base64); body often `{}` (§4c) |
| Payment request header | buyer sends `PAYMENT-SIGNATURE` (v2) or `X-PAYMENT` (v1) (`payer.ts:302`); EVM seller reads `x-payment` (`seller.ts:232`) | `PAYMENT-SIGNATURE` (launch post; spec §5.1.1) |
| Receipt header | buyer reads `payment-response` (v2) or `x-payment-response` (v1); hash `transaction ?? txHash` (`payer.ts:334`, `:344`) | `PAYMENT-RESPONSE` (launch post; §4e) |
| Network id | buyer maps `eip155:8453 ↔ base`, `eip155:84532 ↔ base-sepolia` (`live.ts:80-92`); same-chain gate (`live.ts:128`, `:451`) | CAIP-2 `eip155:8453` / `eip155:84532` (spec §11.1; every §4 endpoint) |
| Price field | buyer reads `amount ?? maxAmountRequired` (`types.ts:30`, `payer.ts:231`) | `amount` (spec §5.1.2; §4b/4c/4d emit `amount` only) |
| Recipient / asset | buyer reads `payTo ?? recipient`, `asset ?? currency` (`types.ts:35-42`) | `payTo` / `asset`; CDP directory adds `recipient` / `currency` aliases (§4a) |
| `PaymentPayload` shape | flat (v1) or nested `{ accepted, payload }` (v2), `accepted` echoed verbatim (`live.ts:548-561`, `payer.ts:287`) | nested: `{ x402Version:2, resource?, accepted, payload, extensions? }` (spec §5.2.2) |
| Facilitator `/verify` `/settle` | `/platform/v2/x402/{action}`, body `{ x402Version, paymentPayload, paymentRequirements }` (`facilitator-cdp.ts:114-123`) | same path and keys, `x402Version:2` + v2 nested payload (spec §7.1) |
| Offer selection | buyer keeps `exact`/`upto` on its own chain that settle as plain USDC, cheapest (`live.ts:166-209`) | sellers advertise several offers/chains/tiers at once (§4a, §8) |

`extra.name` / `extra.version` (the EIP-712 USDC domain, `"USD Coin"` / `"2"`) are unchanged
between v1 and v2 (`live.ts:574-583`), the one part of the domain that already matched.

---

## 6. How the buyer speaks both (implemented; L-02 closed)

L-02 added v2 alongside v1; the money-path proof is §8 and §9. This section is what the code
does, in the order a request flows. The subsections are cited from the source.

### 6.1 Detect the version and read the challenge
The buyer reads both the base64 `PAYMENT-REQUIRED` header and the JSON body, prefers whichever
carries `accepts[]`, and sets `isV2` from `x402Version` (`payer.ts:201-216`). Reference-SDK
sellers return body `{}` (§4c); reading the body alone, as v1 did, mis-reported them as "no
payment methods".

### 6.2 Read the price and the aliased fields
`offerAmount` reads `amount` (v2) or `maxAmountRequired` (v1); `offerPayTo`/`offerAsset` read
the `recipient`/`currency` aliases the CDP bazaar dual-populates (`types.ts:30-42`, §4a).

### 6.3 Match the network by chain, not by string
`CAIP2_ALIASES` maps `eip155:*` to and from bare names and `sameChain` compares by chainId, so
`eip155:84532` is accepted for a `base-sepolia` agent and a different chain is refused before
signing (`live.ts:80-142`, `:451`). This was the single biggest v1 blocker: the old gate was a
bare-string compare that rejected every `eip155:*` seller.

### 6.4 Answer in the version the seller spoke
The outgoing `x402Version` mirrors the seller's (`payer.ts:276`). The signing is identical
between versions; only the envelope differs, chosen from `unsigned.x402Version`: flat for v1,
nested `{ x402Version:2, accepted, payload }` for v2, with `accepted` echoing the seller's
offer verbatim (`live.ts:503-561`, `payer.ts:287`). The wire headers follow the version too:
`PAYMENT-SIGNATURE`/`PAYMENT-RESPONSE` for v2, `X-PAYMENT`/`X-PAYMENT-RESPONSE` for v1
(`payer.ts:302`, `:334`).

### 6.5 Post the facilitator body
`CdpFacilitator` posts `{ x402Version, paymentPayload, paymentRequirements }` to
`/platform/v2/x402/{verify,settle}`; the three keys are the same in both versions, so the class
is v2-capable by construction and `x402Version` selects the envelope (default 1)
(`facilitator-cdp.ts:74`, `:114-123`).

v1 stays supported (decision **D-5**) and green in `test/wire.test.ts`. Our own EVM
`paymentGate` still emits v1 (§1, §2); the Solana rail is v2 (§10).

**Re-check date:** the ecosystem moves fast (v2 spec 2025-12-09, launch post updated
2026-06-24). Re-verify this document by **2026-12-07** (3 months out): re-run the §4 discovery
and curl probe and re-read the CDP facilitator doc, watching for (a) any live v1 seller
reappearing, (b) removal of the "backward-compatible with V1" promise, (c) a v3, and (d)
whether our EVM seller should move to v2.

---

## 7. Reproduce this

```sh
# live directory of real sellers (public, no auth) — check the network ids
curl -s https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources \
  | python3 -c 'import sys,json;print({a["network"] for it in json.load(sys.stdin)["items"] for a in it["accepts"]})'

# a real 402, headers + body (no payment sent)
curl -sS -D - https://weather.payapi.market/current
curl -sS -D - https://x402uselessfacts.vercel.app/api/useless-fact   # body is {}, see the payment-required header

# the spec
curl -s https://raw.githubusercontent.com/coinbase/x402/main/specs/x402-specification-v2.md
```

---

## 8. L-02 live run against a real third-party seller (2026-09-07)

Ran the live buyer runtime against **`https://x402.quicknode.com/api/ping`** — a real
third-party x402 **v2** seller (not our `paymentGate`) that advertises a 20-offer 402 across
Base, Base Sepolia, Polygon, Amoy, X Layer, and Solana. Harness: `scripts/l02-thirdparty.ts`.
Two real buyer bugs surfaced, each fixed with a wire test; each fix moved the seller's
response to the next failure layer, which is how we know they were real:

1. **Blind `accepts[0]` selection.** The buyer paid the first offer, which was QuickNode's
   `$1.00` "credit drawdown" tier → `400 auth_required` ("Credit drawdown payments require
   SIWX authentication"). Fix: `selectOffer` (src/live.ts) — keep only `exact`-scheme offers
   on the agent's own chain that settle as a plain USDC `TransferWithAuthorization` (an
   `extra.verifyingContract` naming a different contract, e.g. Circle Gateway, is dropped),
   then take the cheapest. Now selects the `$0.001` per-request tier on `eip155:84532`.

2. **Normalized offer + wrong-typed `resource` on the v2 wire.** Our v2 `accepted` carried
   fields the seller never sent (`maxAmountRequired`, a synthesized `resource` string) and a
   top-level `resource` string where the spec wants a ResourceInfo object → `400 "Unexpected
   error verifying payment"`. Fix: echo the seller's chosen offer **verbatim** under
   `accepted` (src/payer.ts `acceptedOffer`), and omit the optional top-level `resource`.
   This got the payment **past QuickNode's signature verification** — the error advanced to a
   settlement-routing decision.

**Where it stopped:** with a spec-valid, verified payload, QuickNode answers
`404 unsupported_network` for `eip155:84532` — a network it advertised itself in the same
402. That is a seller-side testnet-settlement limitation, not a buyer defect: the buyer
negotiated the real v2 402, selected the right offer, signed a real EIP-3009 authorization,
and produced a payload their verifier accepted.

**L-02 status (superseded — see §9):** against QuickNode the buyer was proven up to the
settlement boundary only. The missing last step — a fully-**settled** third-party testnet
payment — was completed on 2026-09-07 against a different seller.

## 9. L-02 closed: settled against Mart402 (2026-09-07)

The seller that "actually settles what it advertises" turned out to be **Mart402**
(https://mart402.dev) — a PDF-extraction API running x402 **v2** on `eip155:84532`, whose
deterministic products run fully on its Base Sepolia sandbox against real testnet USDC. Its
`/v1/parse` takes a free `quote_id` first; the harness (`scripts/l02-thirdparty.ts`) quotes a
public dummy PDF, then pays.

Result: `ok: true`, HTTP 200, the parsed document returned (`"markdown": "## Dummy PDF file"`),
**$0.004 USDC settled on-chain** — tx
`0xf53b18b0e0effcd93f171f2cce941c0a3c1775992548a9d38829c683d18d817e` (block 46518690,
receipt `status 0x1`, EIP-3009 Transfer + AuthorizationUsed logs, gas paid by the seller's
facilitator relayer). Full record: `docs/canary-runs/2026-09-07-base-sepolia-mart402.md`.

**No new buyer code was needed** beyond the two QuickNode fixes (§8). Notably, Mart402's
`agents.md` documents retrying with the legacy `X-PAYMENT` header, but it accepted our v2
`PAYMENT-SIGNATURE` header as-is — so real v2 sellers read the new header, and no `X-PAYMENT`
fallback was required. The buyer now has an end-to-end **settled** proof against a real
third-party v2 seller on Base Sepolia. **L-02 is closed.**

---

## 10. Solana rail — `exact` and `upto` (SOL-01 … SOL-09, 2026-09-13)

Snapshot date: **2026-09-13**. The Solana rail landed in SOL-01 … SOL-08 (branch
`feat/solana-exact-rail`); this section is the primary-sourced compat note SOL-09 requires,
built the same way as §1–§9: quote each facilitator's own `/supported`, then say what the
buyer and seller do about it.

### 10.1 Summary verdict

**Solana on x402 is `exact` when a hosted facilitator settles it, and `upto` only when the
seller settles it itself.** Every hosted facilitator I checked advertises Solana **`exact`
only**; none advertises Solana **`upto`**. `exact` is symmetric with the Base path — the buyer
signs a `TransferChecked`, the facilitator co-signs as fee payer and pays SOL — so allowance-kit
speaks it through CDP (mainnet + devnet, API key) and through x402.org's free devnet
facilitator. `upto` (a metered call backed by a payment channel, the scheme that makes an
agent's per-call cost equal to what it used, not what it feared) has **no hosted facilitator on
Solana at all**, so Wallie's seller **self-facilitates**: it runs the `@x402/svm/upto`
facilitator role in-process with its own fee-payer and authorizer keys (`src/seller-upto.ts`,
SOL-04). This is not a workaround; it is the only way to offer Solana `upto` today, and it is
why the money-path proof for `upto` is our own canary (§10.3), not a third-party seller.

### 10.2 What the facilitators advertise (quoted `/supported`, 2026-09-13)

**x402.org facilitator** — `GET https://x402.org/facilitator/supported` (the free one
allowance-kit uses for Solana devnet `exact`). Solana kinds, verbatim:

```json
{ "x402Version": 2, "scheme": "exact",
  "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  "extra": { "feePayer": "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5",
             "features": { "smartWalletSupported": true } } }
{ "x402Version": 1, "scheme": "exact", "network": "solana-devnet",
  "extra": { "feePayer": "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5" } }
```

Its `signers` map confirms one Solana fee payer for the cluster:
`"solana:*": ["CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5"]`. It **does** offer `upto`, but
only on `eip155:84532` (Base Sepolia, `extra.facilitatorAddress` `0xd407e409…`) — **not** on
any Solana network. So: Solana → `exact` only.

**PayAI facilitator** — `GET https://facilitator.payai.network/supported`. Advertises a long
list of EVM networks in both v1 (`base`, `base-sepolia`, `avalanche`, `sei`, `polygon`,
`xlayer`, `arbitrum`, …) and v2 (`eip155:8453`, `eip155:84532`, `eip155:43114`, …). **No
`solana:*` or `solana-devnet` kind appears, and no `upto` kind appears.** PayAI is EVM-`exact`
today, despite ecosystem write-ups listing it as Solana-capable — so it is not a Solana `upto`
option either.

**CDP facilitator** — `GET https://api.cdp.coinbase.com/platform/v2/x402/supported` answers
`Unauthorized` without a JWT (unlike the discovery endpoint in §7, `/supported` is gated). CDP's
own docs list Solana support as **`exact`, mainnet and devnet**
(`https://docs.cdp.coinbase.com/x402/network-support`, accessed 2026-09-13); no `upto` scheme is
listed for any network. `CdpFacilitator` (`src/facilitator-cdp.ts`) is wired for Solana `exact`
and passes the CAIP-2 network in the v2 body (SOL-02).

**402.surfnet.dev** — the sandbox is a Solana **RPC** (a Surfpool mainnet fork), not an x402
facilitator; `GET /supported` returns S3 `NoSuchKey`. It provides the validator, program and
faucet the canary settles against (§10.3), and the seller's in-process operator plays the
facilitator role there.

### 10.3 What this repo does about it

- **`exact` (Solana), buyer + seller** — SOL-01/SOL-02. Buyer `encodePaymentSolanaExact`
  signs the v0 transaction and leaves `extra.feePayer` unsigned for the facilitator; seller
  `advertise` returns a Solana entry with the mint as `asset` and `extra.feePayer` from
  `/supported`. CDP (mainnet + devnet) and x402.org (devnet) settle it. Symmetric with Base.
- **`upto` (Solana), self-facilitated** — SOL-03 … SOL-06. Because no hosted facilitator
  settles Solana `upto`, `paymentGate` runs the operator itself; the buyer escrows the ceiling
  as a channel deposit, the seller meters and settles the actual, the difference refunds in the
  same step, and the buyer's policy rails gate on the **ceiling**.
- **Proof** — `scripts/canary-solana.ts` (SOL-09) settles a real `upto` channel on the
  402.surfnet.dev sandbox: metered $0.03 against a $0.10 ceiling, on-chain `settled` watermark
  $0.03, wallet delta exactly $0.03, $0.07 refunded, recorded with the real signature in
  `docs/canary-runs/2026-09-13-solana-surfnet-sandbox.md`. The public-devnet run (an
  explorer-verifiable signature) and the mainnet $1 run are the human step; the script prints a
  paste-ready record on `--devnet`/`--network solana`.

### 10.4 Reproduce this

```sh
# the free facilitator's supported schemes/networks — Solana is exact-only
curl -s https://x402.org/facilitator/supported \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print([k for k in d["kinds"] if "solana" in k["network"]])'

# PayAI: no Solana kind at all
curl -s https://facilitator.payai.network/supported \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print([k["network"] for k in d["kinds"] if "solana" in k["network"]])'

# the Solana upto money path, end to end, real signatures (free faucet, no key)
SOLANA_SANDBOX=1 node scripts/canary-solana.ts --sandbox --record
```
