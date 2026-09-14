# 2026-09-14 · solana-devnet — Solana upto (SOL-09)

The live buyer runtime opened a payment channel, metered the call, settled the
actual on-chain and had the rest refunded — the Solana `upto` money path end to
end (docs/SOLANA-ARCHITECTURE.md §4.3, SOL-05/SOL-09), on **public devnet** with
an explorer-verifiable signature. This is the SOL-09 done-when: a devnet `upto`
settle with a real signature.

## Command

```
SELLER_FEE_PAYER_KEY="$(cat ~/wallie-seller-fee.json)" \
SELLER_AUTHORIZER_KEY="$(cat ~/wallie-seller-auth.json)" \
AGENT_PRIVATE_KEY="$(cat ~/wallie-demo-buyer.json)" \
node scripts/canary-solana.ts --devnet --record
```

Buyer funded with devnet USDC (Circle faucet, Solana Devnet); seller fee payer
funded with devnet SOL. Phase A (hermetic) passed first; Phase C is the record
below.

## Wallets & limits

- Buyer: `47bZuXM3Pq3DXxyQ9bDmYZvQeENxTScLBhQiV1nLJ2LU`
- Seller fee payer: `5vJEgqSWiY4EjVJrE6nz83NdRh83Nr7dvSqffjSPoYrR`
- Ceiling (deposit escrowed): $0.1000 · per-call cap $0.15 · rows 30 → actual $0.03

## Channel & settlement

- Network: `solana-devnet` · RPC `https://api.devnet.solana.com`
- Channel PDA (channelId): `BSan6BgKU3n5tPzRerJfRQtgwVBcyYW6jQwgS6YsxAXS`
  https://explorer.solana.com/address/BSan6BgKU3n5tPzRerJfRQtgwVBcyYW6jQwgS6YsxAXS?cluster=devnet
- Settle signature: `Yqw1ZRcG4DHBhhrh4zkkpT1QXHT9CosHC2PfK6vg5hwPCCAyP6GzVz5dBMMGEnkvwaqWjNC8kceR2LnWdjnmVRx`
  https://explorer.solana.com/tx/Yqw1ZRcG4DHBhhrh4zkkpT1QXHT9CosHC2PfK6vg5hwPCCAyP6GzVz5dBMMGEnkvwaqWjNC8kceR2LnWdjnmVRx?cluster=devnet
- Settle tx: finalized at slot 498173798, blockTime 2026-09-14T09:27:31Z, `err: null`, fee 10001 lamports (seller-paid)
- Metered actual settled on-chain: $0.0300
- Refunded to the buyer: $0.0700
- Buyer wallet delta: exactly $0.0300 ($19.97 → $19.94)

## Ledger row

```json
{"t":"payment","scheme":"upto","amountMicro":"30000","depositMicro":"100000","refundMicro":"70000","channelId":"BSan6BgKU3n5tPzRerJfRQtgwVBcyYW6jQwgS6YsxAXS"}
```

## Result

The channel settled at exactly the metered amount and the difference refunded in
the same step; the buyer wallet lost only the actual charge. `upto` proven on
public solana-devnet with a finalized, explorer-verifiable signature.

## Note — canary fix landed in this run

The first devnet attempt opened and settled correctly on-chain (buyer −$0.03) but
the canary's final wallet-delta read fired before devnet finalized the settle
(finalized commitment lags the settle by tens of seconds), so it read the
pre-settle balance and failed `wallet moved 0`. The sandbox (mainnet-fork, instant
finality) never showed this. Fix: `scripts/canary-solana.ts` now polls the buyer
balance until the delta lands (bounded ~60s) before asserting. No money-path
change; the on-chain settlement was correct on the first attempt too.
