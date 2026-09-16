# Behavior-derived attestation (PoC)

Status: proof of concept. `src/attestation.ts`, exported from the package root.
Run the end-to-end demo with `node demo/attestation.ts`.

## What it is

An agent already keeps a private audit ledger (`src/ledger.ts`): every payment
with its on-chain `txHash`, every block the rails stopped, every human approval,
every policy change, timestamped and per-agent. This turns that ledger into a
signed, portable reputation claim.

The claim is signed with the **same wallet key the agent pays with** (`src/live.ts`
builds that key from `privateKey`). So the address that pays is the address that
attests: one non-custodial identity, no custodian, no posted stake. Contrast with
a capital-anchored model where trust comes from locking up USDC — here trust comes
from a track record the agent earned by behaving.

## The trust model is staged, and the code says which stage it is at

- **v1 (built, this PoC): brand-anchored self-attestation.** The signature proves
  the agent's key produced the claim. It does **not** prove the numbers against
  the chain. A seller verifies the signature recovers to the claimed address and
  trusts the contents on the Wallie brand, the way it trusts a signed receipt from
  a known runtime. `verifiableTxCount` names how much of the claim is
  on-chain-checkable, so v2 can raise the bar with no wire change.
- **v2 (not built): chain-anchored, registry-resolvable.** A verifier re-checks
  each `txHash` on-chain, and the agent identity anchors in an ERC-8004 Identity
  Registry so the reputation resolves across sellers without trusting any brand.

## What the summary exposes

Counts and totals only. The ledger itself — hosts, urls, per-payment amounts —
never leaves the agent. The summary is a reputation signal, not a data dump.

| field | meaning |
| --- | --- |
| `agent` | payer wallet address; in v1 this is the identity |
| `issuer` | `"wallie"` — brand tag the seller keys trust on (provenance, not proof) |
| `runtimeVersion` | the runtime that produced the claim (provenance, not proof) |
| `periodStart` / `periodEnd` | ISO timestamps of first/last ledger event, or null |
| `payments` | settled payment rows |
| `spendTotalMicro` | total actually spent, micro-dollars, decimal string |
| `verifiableTxCount` | payments with a non-empty `txHash` (the chain-checkable subset) |
| `blocks` | attempts the rails refused (self-reported; no third party can confirm) |
| `distinctHosts` | how many counterparties the agent paid or was blocked against |
| `approvalsRequested` / `approvalsApproved` | human-in-the-loop signal |
| `policyChanges` | how many times the spend policy changed |

## Wire shape

`SignedAttestation` is plain JSON. The bulk of the claim rides in `digest`
(keccak256 of the canonical JSON of `summary`); the EIP-712 signature is over a
small envelope `{ agent, issuer, issuedAt, expiresAt, digest }` under the domain
`{ name: "WallieAttestation", version: "1" }` (`ATTESTATION_DOMAIN`).

```json
{
  "version": 1,
  "agent": "0x1E4e…BfF5",
  "issuedAt": 1789248717,
  "expiresAt": 1789853517,
  "summary": { "...": "BehaviorSummary" },
  "digest": "0x6d30…6d6b",
  "signature": "0xa2b7…"
}
```

## API

```ts
import {
  summarize, attest, attestFromLedger, verifyAttestation,
  ATTESTATION_DOMAIN, ATTESTATION_TYPES,
} from "allowance-kit";

// Issuer side (the agent). `account` is the viem account createLiveAgent uses.
const attestation = await attestFromLedger(account, ledger, agent, { ttlSecs: 604800 });

// Seller side.
const result = await verifyAttestation(attestation);
if (result.valid) {
  // result.signer, result.summary — gate access on the track record.
}
```

`summarize` is dependency-free (pure ledger math). `attest` and
`verifyAttestation` import `viem` lazily, so an agent that only reads its own
ledger never pulls a signing library in — the same optional-peer pattern as
`src/live.ts`.

## Verification checks, in order

1. summary matches the signed `digest` (contents not tampered);
2. `summary.agent` matches the attestation `agent`;
3. the claim is inside its `[issuedAt, expiresAt)` window;
4. the EIP-712 signature recovers to the claimed agent.

A `true` result means "this address controls the key and signed exactly these
numbers." It does not mean the numbers were checked on-chain — that is v2.

## Honest limits of v1

- **Self-asserted.** A local ledger the agent writes about itself is only worth
  trusting because payments carry a `txHash` that settled on-chain. v1 does not
  re-check those; it trusts the Wallie brand. `blocks` and `policyChanges` are
  self-reported and unfalsifiable by a third party — weigh them accordingly.
- **Cold start.** Behavior reputation needs history. A brand-new agent has no
  behavior and so no reputation, which is exactly when a seller most wants a
  signal. A stake bootstraps trust on day one; behavior sustains it. The two
  compose — v1 does not solve cold start.
- **Adoption.** Almost no x402 seller reads a reputation claim today. This issues
  a credential; a seller has to choose to gate on it.
