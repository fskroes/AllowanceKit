# Canary runs

A canary run is a recorded, dated result of `scripts/canary.ts` — the script that proves the
real buyer path works end to end (allowance, on-chain balance check, approval gate, ledger).
This directory is the evidence trail: one file per run, so a claim like "mainnet works" always
points at a transaction anyone can check on BaseScan.

Record a run here as `YYYY-MM-DD-<network>.md` with:

- the exact command and the network (`base-sepolia`, `base`, `solana`, `solana-devnet`),
- the payer wallet address and the amount funded / per-call cap (and, for Solana `upto`, the
  ceiling, the metered actual, and the refund),
- the settled tx hash / signature and an explorer link for each (BaseScan for Base, Solana
  Explorer for Solana; a sandbox / mainnet-fork run has no public explorer, so record the
  channel PDA and the signature),
- the ledger rows the run asserted (one payment, one block), and
- anything that failed and how it was fixed (every fix gets a test — see CONTRIBUTING.md).

The Base runs come from `scripts/canary.ts`; the Solana runs from `scripts/canary-solana.ts`.

Referenced by RELEASE-PLAN.md tickets **M-02** (Base mainnet proof) and **L-02** (the buyer
canary against a real third-party x402 seller on Base Sepolia), and by SOLANA-ARCHITECTURE.md
ticket **SOL-09** (the Solana `upto` canary). Recorded:

- `2026-09-07-base.md` — Base mainnet, $0.01 USDC.
- `2026-09-07-base-sepolia-mart402.md` — third-party v2 seller, $0.004 USDC
  (`scripts/l02-thirdparty.ts`, Mart402).
- `2026-09-13-solana-surfnet-sandbox.md` — Solana `upto` end to end on the 402.surfnet.dev
  sandbox: metered $0.03 of a $0.10 ceiling, on-chain `settled == $0.03`, $0.07 refunded, real
  signature. The public-devnet run (an explorer-verifiable signature) and the mainnet $1 run
  are the human step (`node --env-file=.env scripts/canary-solana.ts --devnet --record`).
