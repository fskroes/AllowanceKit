# x402 wire compatibility — v1 vs v2 (ticket L-01)

Research date: **2026-09-07**. Author: implementing agent (L-01). Method: read this repo's
own wire code, quote the x402 v2 specification and the CDP/x402.org docs from primary
sources, then hit real live x402 sellers with a plain read-only `GET` (no payment, nothing
signed) and record the raw 402s. All source URLs and access date are given inline.

This document is the output required by L-01. It does not change any code. Ticket L-02 acts
on the recommendation at the end.

---

## 1. Summary verdict

**The live ecosystem has moved to x402 v2, and this repo speaks v1 only. As it stands today,
the buyer path (`payingFetch`) cannot transact against a single seller in the public CDP
directory.** Every one of the 100 resources in Coinbase's own live bazaar, and every one of
the five real endpoints I hit by hand, answers with **`x402Version: 2`**, advertises its
network in **CAIP-2** form (`eip155:8453` for Base, `eip155:84532` for Base Sepolia),
carries the challenge in the **`PAYMENT-REQUIRED` header** (base64), and names the price
field **`amount`** — not the v1 `X-PAYMENT` request header, not bare `base`/`base-sepolia`,
not `maxAmountRequired`. The x402 v2 specification (`coinbase/x402`, spec version v2.0 dated
2025-12-09; publicly launched as "x402 V2" on x402.org) makes `x402Version: 2` and CAIP-2
networks **required**. The CDP facilitator docs list support as "x402 v2".

v1 is **not formally killed**: the x402 V2 launch post states "x402's reference SDKs are
fully backward-compatible with V1" and promises "no breaking changes," and the discovery
schema still carries a per-resource `x402Version` that may read `1`. But *no live v1 seller
exists in the CDP bazaar today*, so backward-compatibility protects old clients talking to
old servers — it does not let our v1-only client talk to the v2 servers that now make up the
market. And our client breaks **before it ever reaches a facilitator**: it reads `accepts`
from the JSON body (empty `{}` on reference-SDK sellers, who put it in the header), it has no
mapping for `eip155:*` networks, and it does `BigInt(offer.maxAmountRequired)` on a field
v2 sellers omit. Per decision **D-5**, v1 stays supported; **v2 must be added alongside it
(L-02) before the buyer canary can pass against a third-party seller.**

One honesty caveat: I could not directly test whether the CDP `POST /verify` and `/settle`
endpoints still *accept* a v1-shaped body with a bare network name — that needs CDP
credentials and a signed EIP-3009 payload, which is out of scope for read-only research.
The verdict above rests on what sellers *advertise* and what the spec *requires*, both of
which are conclusive on their own: even a v1-tolerant facilitator would not help, because our
buyer never gets past parsing the seller's v2 402.

---

## 2. What this repo sends today (quoted, with file:line)

All from branch `feat/live-money-0.4.0`.

**`x402Version` is hard-coded to `1`:**

- `src/payer.ts:147` — the buyer's outgoing payment: `x402Version: 1,`
- `src/seller.ts:44`, `:76`, `:83` — our seller's 402 body: `x402Version: 1,`
- `src/facilitator-cdp.ts:63` — `this.x402Version = opts.x402Version ?? 1;`
- `src/types.ts:17,22` — `PaymentRequiredBody` / `PaymentPayload` carry a numeric
  `x402Version` (set to 1 everywhere it is produced).

**Header names are the v1 `X-PAYMENT` family:**

- `src/payer.ts:167` — buyer sends `headers: { …, "X-PAYMENT": encoded }`
- `src/payer.ts:191` — buyer reads the receipt from `paid.headers.get("x-payment-response")`
- `src/seller.ts:41` — our seller reads `req.headers["x-payment"]`
- `src/seller.ts:87` — our seller replies with `res.setHeader("X-PAYMENT-RESPONSE", …)`

**Network identifiers are bare names, and only two are known:**

- `src/live.ts:42-58` — `NETWORKS` is keyed by `"base-sepolia"` (chainId 84532) and
  `"base"` (chainId 8453). There is no `eip155:*` key anywhere.
- `src/seller.ts:17` — `const network = opts.network ?? "mock-ledger";`
- `src/live.ts:171-175` — a live agent throws if `unsigned.requirements.network !== network`
  (string-equality against the bare name), so a seller quoting `eip155:8453` is refused
  before signing even if it is the same chain.

**The buyer expects `accepts[]` in the JSON body, and reads `maxAmountRequired`:**

- `src/payer.ts:119-121` — `const required = (await first.json()) as PaymentRequiredBody;
  const offer = required.accepts?.[0];` (no header fallback)
- `src/payer.ts:132` — `const amountMicro = BigInt(offer.maxAmountRequired);`
- `src/types.ts:3-14` — `AcceptsEntry` has `maxAmountRequired` and `network` (bare), no
  `amount`, no `currency`, no `recipient`.

**The CDP facilitator call already uses the v2 URL path but a v1 body/version:**

- `src/facilitator-cdp.ts:82` — `POST {baseUrl}/platform/v2/x402/${action}` (verify/settle)
- `src/facilitator-cdp.ts:87-91` — body is
  `{ x402Version: this.x402Version /* =1 */, paymentPayload, paymentRequirements }`.
  The envelope key names match v2 (§4), but the version and the nested payload shape are v1.

**The signed EVM payload shape (`src/live.ts:231-247`)** is
`{ x402Version, scheme, network, resource, payload: { signature, authorization } }` —
scheme/network at the top level. v2 instead nests the chosen requirements under an
`accepted` object (see §3, spec §5.2).

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

## 5. Exact diff — v1 (this repo) vs v2 (live today)

| Field / header | v1 — what this repo does | v2 — what live sellers & the spec require |
| --- | --- | --- |
| `x402Version` | `1` (`payer.ts:147`, `seller.ts:44`, `facilitator-cdp.ts:63`) | `2` (required; spec §5.1.2) |
| Challenge transport | 402 **JSON body** with `accepts[]` (`payer.ts:119`) | 402 **`PAYMENT-REQUIRED` header** (base64); body often `{}` (4c) |
| Payment request header | `X-PAYMENT` (`payer.ts:167`, `seller.ts:41`) | `PAYMENT-SIGNATURE` (launch post; spec §5.1.1 error string) |
| Receipt header | `X-PAYMENT-RESPONSE` (`payer.ts:191`, `seller.ts:87`) | `PAYMENT-RESPONSE` (launch post; 4e CORS list) |
| Network id | bare `base` / `base-sepolia` (`live.ts:42-58`) | CAIP-2 `eip155:8453` / `eip155:84532` (spec §11.1; every endpoint in §4) |
| Price field | `maxAmountRequired` (`types.ts:6`, `payer.ts:132`) | `amount` (spec §5.1.2; §4b/4c/4d emit `amount` only) |
| Recipient field | `payTo` | `payTo` (unchanged); CDP directory adds `recipient` alias (4a) |
| Asset field | `asset` | `asset`; CDP directory adds `currency` alias (4a) |
| `PaymentPayload` shape | flat: `{ x402Version, scheme, network, resource, payload:{signature,authorization} }` (`live.ts:231-247`) | nested: `{ x402Version:2, resource?, accepted:{PaymentRequirements}, payload:{…}, extensions? }` (spec §5.2.2) |
| Facilitator `/verify` `/settle` path | `/platform/v2/x402/verify` (`facilitator-cdp.ts:82`) | same path; body `{ x402Version:2, paymentPayload, paymentRequirements }` (spec §7.1) |
| Facilitator request body | `{ x402Version:1, paymentPayload, paymentRequirements }` (`facilitator-cdp.ts:87-91`) | same keys, `x402Version:2` + v2 nested payload |
| Schemes seen | `exact` only | `exact`, plus `batch-settlement` and non-x402 rails (`tempo`/`mpp`) advertised alongside (4a) |

`extra.name` / `extra.version` (the EIP-712 USDC domain, e.g. `"USD Coin"` / `"2"`) are
**unchanged** between v1 and v2 — the one part of `advertise()`/`evmDomain()` that already
matches what live sellers send.

---

## 6. Recommendation for ticket L-02

**v2 must be added alongside v1 (per D-5, v1 is not removed). v1 alone is not sufficient:**
the current buyer cannot complete a single real purchase against the live ecosystem, and it
fails before reaching any facilitator. Concretely, L-02 needs, at minimum:

1. **Read the challenge from the `PAYMENT-REQUIRED` header, not only the body** (`payer.ts`
   around :119). Reference-SDK sellers (useless-fact, vibesprings) return body `{}` — today
   we mis-report them as "no acceptable payment methods." Detect the version from
   `x402Version` (header or body) and branch.
2. **Accept `amount` as well as `maxAmountRequired`** (`payer.ts:132`, `types.ts`). Add
   `amount`/`currency`/`recipient` to `AcceptsEntry` as optional v2 aliases.
3. **Map CAIP-2 networks both ways** — `base ↔ eip155:8453`, `base-sepolia ↔ eip155:84532`
   (`live.ts` `NETWORKS` + the hard-constraint check at `:171-175`, and `seller.ts:17`). This
   is the single biggest blocker: our network gate is a bare-string compare that rejects
   `eip155:*` outright.
4. **Send v2 when the seller sent v2:** `x402Version: 2`, the `PAYMENT-SIGNATURE` request
   header, the `PAYMENT-RESPONSE` receipt header, and the nested `{ accepted, payload }`
   PaymentPayload shape (`payer.ts`, `live.ts:encodePaymentEvm`).
5. **Bump `CdpFacilitator` to `x402Version: 2`** by default (or negotiate per request) and
   emit the v2 nested `paymentPayload` (`facilitator-cdp.ts`). The URL path is already
   `/platform/v2/…`.
6. Keep the whole v1 path intact behind the version detection, and cover every shape in
   `test/wire.test.ts` (per L-02's "done when").

L-02's acceptance test — the buyer canary passing against a real third-party seller on Base
Sepolia — implies also finding a **testnet (`eip155:84532`)** seller; the CDP bazaar sample I
pulled was all Base mainnet (`eip155:8453`), so L-02 should source a Sepolia endpoint from
the bazaar's testnet filter or from the `coinbase/x402` examples.

**Re-check date:** the ecosystem is moving fast (v2 spec 2025-12-09, launch post updated
2026-06-24). This document should be re-verified by **2026-12-07** (3 months out), or sooner
if L-02 slips — specifically re-run the §4 discovery + curl probe and re-read the CDP
facilitator doc, watching for (a) any live v1 seller reappearing, (b) removal of the
"backward-compatible with V1" promise, or (c) a v3.

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

**L-02 status:** the buyer is proven against a real third-party v2 seller up to the
settlement boundary, but a fully-**settled** third-party testnet payment (200 + tx hash,
recorded under `docs/canary-runs/`) has **not** happened yet — it needs a Base-Sepolia seller
that actually settles what it advertises. L-02 remains open on that last step.
