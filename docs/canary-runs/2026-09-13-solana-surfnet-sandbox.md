# 2026-09-13 · solana sandbox (402.surfnet.dev) — Solana upto (SOL-09)

The live buyer runtime opened a payment channel, metered the call, settled the
actual on-chain and had the rest refunded — the Solana `upto` money path end to
end (docs/SOLANA-ARCHITECTURE.md §4.3, SOL-05/SOL-09), against a **real** Solana
validator with **real** transaction signatures.

This is the autonomous half of SOL-09: the 402.surfnet.dev sandbox is a Surfpool
fork of mainnet-beta (the program `CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX`
and mainnet USDC are present, genesis = mainnet, so the network id is `solana`),
with a free faucet (`requestAirdrop`, `surfnet_setTokenAccount`). No funded key is
needed, so the agent can run and record it. The public-devnet run with an
explorer-verifiable signature, and the mainnet $1 run, are the human step below.

## Seller (self-facilitated)

No hosted facilitator speaks Solana `upto` (see `docs/x402-compat.md` §10), so the
seller runs the operator in-process (`createSolanaUptoOperator`, SOL-04) with two
generated hot keys — a fee payer (holds SOL, co-signs `open`, pays rent, signs
`settleAndSeal`) and an authorizer (signs the voucher). The gate meters $0.001 per
row and charges the actual through `meter.charge`, clamped to the ceiling.

## Command

```
SOLANA_SANDBOX=1 node scripts/canary-solana.ts --sandbox --record
```

Phase A (hermetic, always) passed first; Phase B is the record below.

## Wallets & limits

- Buyer: `2pH2irxaeynYTcQUwpxJTq8D9in2TH2fv4shgQzfXU5y`
- Seller fee payer: `EKV5pvoLvLhw1V3p6GdHhVBqryxPx2hKXj7NepRBrjAt` (airdropped 0.5 SOL)
- Buyer funded via the surfnet faucet: **$1.00 USDC**, 0.05 SOL (dust for the escape path)
- Ceiling (deposit escrowed): **$0.10** · per-call cap **$0.15** · rows **30** → actual **$0.03**

## Channel & settlement

- Network: `solana` · RPC `https://402.surfnet.dev:8899`
- Channel PDA (channelId): `8U8G8e3wNLz4phM7fEba6L8uLfgMmGmSyrRAX3yLX3k8`
  (sandbox / mainnet-fork — no public explorer)
- Settle signature: `5yfq51teSbCEtJUZpKKKgN7vbHipHWh4XfSK4VhgUwNuG1XEHNue5keNqVzDkXbvKhVk3qnQ6N7HnwdW2dt92Cip`
- Metered actual settled on-chain (PDA `settled` watermark, offset 20): **$0.0300**
- Refunded to the buyer by `distribute`: **$0.0700**
- Buyer USDC delta: **exactly $0.0300** (deposit out, 70 % refunded in the same step)

## Ledger row

```json
{"t":"payment","scheme":"upto","amountMicro":"30000","depositMicro":"100000","refundMicro":"70000","channelId":"8U8G8e3wNLz4phM7fEba6L8uLfgMmGmSyrRAX3yLX3k8"}
```

## Result

`res.ok = true`. The channel opened at the ceiling, the seller metered $0.03,
`settleAndSeal` raised the on-chain `settled` watermark to exactly $0.03, and
`distribute` returned the $0.07 difference — the buyer wallet lost only the actual
charge. The buyer's escrow book, channel store and audit ledger all agree, and the
same run proved the rail that matters: an open whose **ceiling** exceeds the
per-call cap is refused before any deposit (`rule=per_call_cap`). No fixes needed.

## Still the human step (SOL-09 done-when: a devnet signature)

The sandbox proves the money path on a real validator, but its signatures are not
verifiable on a public explorer. To stamp a **public devnet** `upto` settle:

1. Create a Solana keypair (`solana-keygen new`) and set `AGENT_PRIVATE_KEY` to
   its JSON array (or a Phantom base58 export).
2. Fund it with **devnet USDC** at https://faucet.circle.com (pick "Solana
   Devnet") — there is no programmatic devnet USDC faucet, so this is manual. A
   dime is enough; the canary escrows a $0.10 ceiling and settles $0.03.
3. Run: `node --env-file=.env scripts/canary-solana.ts --devnet --record` and
   paste the printed block into `docs/canary-runs/<date>-solana-devnet-upto.md`.

The **mainnet** $1 canary (`--devnet --network solana`) is the same, with real
USDC — the deliberate human gate.
