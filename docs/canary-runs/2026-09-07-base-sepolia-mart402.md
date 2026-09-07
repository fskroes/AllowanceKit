# 2026-09-07 · base-sepolia (third-party seller) — L-02

The live buyer settled a real payment against a **third-party** x402 seller on
Base Sepolia — not our own `paymentGate`. This closes L-02's done-when: "the
buyer canary passes against one real third-party x402 seller … on Base Sepolia,
and that run is recorded under docs/canary-runs/."

## Seller

**Mart402** — a PDF-extraction API (https://mart402.dev), x402 **v2** on
`eip155:84532` (Base Sepolia). Its deterministic products run fully on the
sandbox against real testnet USDC; found via the ecosystem hunt after QuickNode
advertised but would not settle testnet. `/v1/parse` requires a free `quote_id`
first, so the harness quotes a public dummy PDF, then pays.

- Seller offer: `scheme: exact`, `network: eip155:84532`,
  `asset: 0x036CbD53842c5426634e7929541eC2318f3dCF7e` (Base Sepolia USDC),
  `payTo: 0xE3244a21D0d68bFa78b7CAd8C3b8777aDFbB3188`, `extra {name: USDC, version: 2}`.

## Command

```
node --env-file=.env scripts/l02-thirdparty.ts
```

Live buyer runtime (`createLiveAgent` on `base-sepolia`): v2 402 negotiation,
`selectOffer`, EIP-3009 signing, settlement via the seller's own facilitator.

## Wallet & limits

- Payer wallet: `0xe48f38f38e88e6275a155f772508ee6953a4425B`
- On-chain USDC before: **$39.92** on base-sepolia
- Allowance topped up: **$2.00** · per-call cap: **$1.50** · approval required at $5.00+
- Allowed host: `mart402.dev`

## Settled transaction

- Amount: **$0.0040 USDC** (1-page deterministic parse; quoted $0.004)
- Tx hash: `0xf53b18b0e0effcd93f171f2cce941c0a3c1775992548a9d38829c683d18d817e`
- Block: **46518690**
- On-chain receipt (Base Sepolia RPC): `status 0x1`, `to 0x036cbd…f7e` (USDC), 2 logs
  (EIP-3009 Transfer + AuthorizationUsed), settled by facilitator relayer
  `0xd407e409e34e0b9afb99ecceb609bdbcd5e7f1bf` (paid the gas — the payer held no ETH).
- BaseScan (Sepolia): https://sepolia.basescan.org/tx/0xf53b18b0e0effcd93f171f2cce941c0a3c1775992548a9d38829c683d18d817e

## Response body (the seller actually did the work)

```json
{ "ok": true, "pages": 1, "route": "docling", "markdown": "## Dummy PDF file",
  "receipt_id": "rcpt_ca9df6cf84bf4cf5a6a0", "seconds": 21.32 }
```

`X-Receipt-Id: rcpt_ca9df6cf84bf4cf5a6a0` — re-fetchable free at
`/v1/receipts/{id}` per the seller's docs.

## Ledger rows

```json
{"t":"topup","agent":"l02-agent","amountMicro":"2000000","source":"human::l02","balanceAfterMicro":"2000000"}
{"t":"payment","agent":"l02-agent","url":"https://mart402.dev/v1/parse","host":"mart402.dev","amountMicro":"4000","txHash":"0xf53b18b0e0effcd93f171f2cce941c0a3c1775992548a9d38829c683d18d817e","balanceAfterMicro":"2000000"}
```

## Result

`"ok": true`, HTTP 200, exit 0. The v1+v2 buyer negotiated a foreign v2 402,
selected the cheapest same-chain USDC offer, signed a real EIP-3009
authorization sent under `PAYMENT-SIGNATURE` (accepted as-is — no `X-PAYMENT`
fallback needed), and the seller's facilitator settled it on Base Sepolia and
returned the parsed document. No fixes required.

**L-02 is closed:** the buyer is proven end-to-end against a real third-party
seller, through settlement, on Base Sepolia — the step QuickNode could not
complete (see docs/x402-compat.md §8).
