# Canary runs

A canary run is a recorded, dated result of `scripts/canary.ts` — the script that proves the
real buyer path works end to end (allowance, on-chain balance check, approval gate, ledger).
This directory is the evidence trail: one file per run, so a claim like "mainnet works" always
points at a transaction anyone can check on BaseScan.

Record a run here as `YYYY-MM-DD-<network>.md` with:

- the exact command and the network (`base-sepolia` or `base`),
- the payer wallet address and the amount funded / per-call cap,
- the settled tx hash(es) and a BaseScan link for each,
- the ledger rows the run asserted (one payment, one block), and
- anything that failed and how it was fixed (every fix gets a test — see CONTRIBUTING.md).

Referenced by RELEASE-PLAN.md tickets **M-02** (mainnet proof) and **L-02** (the buyer canary
against a real third-party x402 seller on Base Sepolia). Both are recorded:
`2026-09-07-base.md` (mainnet, $0.01 USDC) and `2026-09-07-base-sepolia-mart402.md`
(third-party v2 seller, $0.004 USDC via `scripts/l02-thirdparty.ts`).
