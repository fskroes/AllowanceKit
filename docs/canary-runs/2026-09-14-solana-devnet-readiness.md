# 2026-09-14 Solana devnet readiness verification

**Passed on the v0.6.0 working tree**, after the channel accounting and seller
cleanup fixes. This record is a new run and does not replace the earlier SOL-09
record. The release commit had not been created when this test ran.

## Command and scope

```sh
node scripts/canary-solana.ts --devnet --network solana-devnet --record
```

The existing named devnet buyer, fee-payer, and authorizer key files were loaded
into the child process environment. No secrets were printed or written into the
repository. `SOLANA_SANDBOX=0` and the public devnet RPC were explicit. No mainnet
transactions or production changes were made.

Phase A passed its offline metered-payment and ceiling-cap checks. Phase C passed
a fresh public devnet payment using the fixed buyer runtime and seller operator.

## Public proof

- Network: `solana-devnet`.
- RPC: `https://api.devnet.solana.com`.
- Buyer: `47bZuXM3Pq3DXxyQ9bDmYZvQeENxTScLBhQiV1nLJ2LU`.
- Seller fee payer: `5vJEgqSWiY4EjVJrE6nz83NdRh83Nr7dvSqffjSPoYrR`.
- Channel: [CQErDVa7ih5L6KE9ss4Hb5un77VXDWe2ZtxC4uFvTWEc](https://explorer.solana.com/address/CQErDVa7ih5L6KE9ss4Hb5un77VXDWe2ZtxC4uFvTWEc?cluster=devnet).
- [Open transaction](https://explorer.solana.com/tx/2fokzn7ohPaY8sstwAmnyvxKrmvATNxoUnTbnsfcFhxvGDsqTRCGECqR6rDfrKjCTSPRnzthGhEwczLZwwFbafKM?cluster=devnet): `2fokzn7ohPaY8sstwAmnyvxKrmvATNxoUnTbnsfcFhxvGDsqTRCGECqR6rDfrKjCTSPRnzthGhEwczLZwwFbafKM`.
- [Settlement transaction](https://explorer.solana.com/tx/oAcbQ7M8gj3E1LveUr8nf8bcqVEmJPpjWXcS3Z5Ez5JYF7YqfnCpcssdnD2hfPeTJNL6tZBeTERNSiiLB3K2FGT?cluster=devnet): `oAcbQ7M8gj3E1LveUr8nf8bcqVEmJPpjWXcS3Z5Ez5JYF7YqfnCpcssdnD2hfPeTJNL6tZBeTERNSiiLB3K2FGT`.
- Settlement finalized at slot **498210157**, block time **2026-09-14T11:06:57Z**.
- Both transactions have `meta.err: null` and finalized signature status.
- Settlement fee: **10001 lamports**, paid by the seller fee payer.

The transactions and token balances were fetched independently from the public
RPC with `getTransaction` at finalized commitment. The signature history was
also fetched at finalized commitment.

| Buyer USDC state | Micro-USDC | USDC |
| --- | ---: | ---: |
| Before open | 19940000 | 19.94 |
| After the deposit | 19840000 | 19.84 |
| After settlement and refund | 19910000 | 19.91 |
| Escrow deposit | 100000 | 0.10 |
| Actual charge, 30 metered rows | 30000 | 0.03 |
| Refund returned | 70000 | 0.07 |

The settlement transaction removes the escrow token account and returns 70000
micro-USDC to the buyer. The net buyer debit across open and settlement is
30000 micro-USDC.

## Ledger and recovery checks

The canary recorded exactly one payment and marked its local channel settled:

```json
{"t":"payment","scheme":"upto","amountMicro":"30000","depositMicro":"100000","refundMicro":"70000","channelId":"CQErDVa7ih5L6KE9ss4Hb5un77VXDWe2ZtxC4uFvTWEc"}
```

The actual finalized transaction responses were replayed through
`solanaAccountRpc().getClosedOutcome()`. It reconstructed a 30000 micro-USDC
charge from the payment-program instructions and accepted voucher. No receipt
amount was supplied to that history decoder.

A separate temporary buyer store started with this channel in `unknown` state.
Reconciliation recorded one 30000 micro-USDC payment, released the resolved
escrow, and a second reconciliation kept the payment count at one. The same
captured history also recovered the correct charge when the account-read hook
returned `null`, exercising the missing-PDA path without changing on-chain state.

The public PDA was still **DISTRIBUTED** when independently read at finalized
slot 498210628. The canary's earlier message that it was already closed was a
finality-lag diagnostic: its first finalized read did not yet show the newly
opened account. That message is not evidence of rent reclamation. This run proves
settlement, returned USDC, and recovery accounting; it does not claim that delayed
PDA rent reclamation had completed.
