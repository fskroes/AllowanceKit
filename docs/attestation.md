# Behavior-derived attestation (PoC)

Status: proof of concept. `src/attestation.ts` (issue + verify), `src/attestation-gate.ts`
(seller gate), `src/attestation-chain.ts` (v2 on-chain re-check), all exported from
the package root. Run the end-to-end demo with `node demo/attestation.ts`.

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
  on-chain-checkable.
- **v2, on-chain re-check (built, `src/attestation-chain.ts`): chain-anchored.**
  The agent opts in to exposing the txHashes behind `verifiableTxCount`
  (`includeEvidence`); a verifier reads each receipt and confirms the agent moved
  USDC from its own key. The payments claim then stops depending on the brand — a
  fabricated or borrowed txHash fails. See "On-chain verification" below.
- **v2, registry-resolvable (not built): ERC-8004 Identity Registry.** The agent
  identity anchors in an on-chain registry so the reputation resolves across
  sellers without any brand tag at all. This half needs a deployed registry
  contract and is left for later.

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
| `verifiableTxHashes` | the actual hashes behind `verifiableTxCount`; present only with `includeEvidence` (v2 evidence) |
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

### One call on a live agent

A live agent signs an attestation from its own ledger with one call. It uses the
same payer key, so the attesting address is the paying address:

```ts
const runtime = await createLiveAgent({ stateDir, network: "base-sepolia", privateKey });
const attestation = await runtime.attest({ ttlSecs: 604800 });
```

The live ledger keys its rows by `agentName`, not the wallet address, so
`runtime.attest()` reads the rows under `agentName` but stamps the wallet address
as the claim identity (`summarize(..., { ledgerKey })`). Attestation is EIP-712,
so it is EVM-only in v1; on a Solana runtime `attest()` rejects.

### Seller gate

`requireAttestation(policy, handler)` is the seller half: it wraps a handler,
verifies the buyer's attestation from the `X-Attestation` header (base64 JSON,
same convention as `X-PAYMENT`), checks the claim clears the seller's bar, and
only then runs the handler. It has the same Node handler shape as a `paymentGate`
handler, so it composes on either side of one:

```ts
import { paymentGate, requireAttestation } from "allowance-kit";

// Payment first, then reputation (bindToPayer can then tie the two together).
const gated = paymentGate(gateOpts, requireAttestation({
  minPayments: 5,
  minVerifiableTxCount: 3,
  bindToPayer: true,          // the paying address must equal the attestation agent
}, handler));

// Or reputation first, before quoting a price.
const gated2 = requireAttestation({ minVerifiableTxCount: 3 }, paymentGate(gateOpts, handler));
```

Policy floors: `minPayments`, `minVerifiableTxCount`, `minApprovalsApproved`,
`minDistinctHosts`, `minSpendMicro`, plus `maxAgeSecs` (freshness), `agents` (an
address allowlist), and `accept(summary, signer)` for anything custom. A rejected
request gets `403 { error: "attestation_rejected", reason }`; override with
`onReject`. On a served request the handler reads the verified claim with
`attestationOf(req)`.

**Replay.** An attestation is signed but not secret, so on its own it proves only
that *some* high-reputation agent signed these numbers, not that the agent in
front of you is that one. `bindToPayer: true` closes this when the same request
carries the `X-PAYMENT`: the payer address must equal the attestation agent, so a
copied attestation from an address that did not pay is refused.

`summarize` is dependency-free (pure ledger math). `attest` and
`verifyAttestation` import `viem` lazily, so an agent that only reads its own
ledger never pulls a signing library in — the same optional-peer pattern as
`src/live.ts`.

## On-chain verification (v2)

v1 proves the key signed the numbers, then trusts them on the brand. v2 removes
the brand from the loop for the one claim that is checkable: the payments. It has
two moving parts.

**The agent opts in to evidence.** By default the summary is counts-only and the
txHashes stay private. `includeEvidence: true` attaches them:

```ts
const attestation = await runtime.attest({ includeEvidence: true });
// or standalone: summarize(ledger, agent, { includeEvidence: true })
```

This is a deliberate privacy trade. A txHash is public, so exposing it lets
anyone resolve the counterparty on-chain. The agent gives up that privacy only
when the extra trust is worth it; without `includeEvidence`, v2 has nothing to
check and the claim stays v1.

**The seller re-checks each hash.** `verifyAttestationOnChain` reads each
receipt and confirms the transaction settled and emitted a USDC `Transfer` whose
`from` is the agent:

```ts
import { verifyAttestationOnChain } from "allowance-kit";

const r = await verifyAttestationOnChain(attestation, { network: "base-sepolia" });
// r.verified / r.checked / r.claimed, r.weak, r.failures[]
```

Pass `network` (bare or CAIP-2) to resolve the USDC token and a default RPC, or
`rpcUrl` for your own endpoint, or a ready `client` (a viem public client, or a
fake in tests). With no token known the check falls back to any ERC-20 `Transfer`
from the agent and sets `weak: true`.

x402 settles USDC with EIP-3009 `transferWithAuthorization`, relayed by a
facilitator, so the transaction **sender** is the facilitator, not the agent. The
check reads the `Transfer` **log** (`from` = the agent), never `tx.from`, which is
why it works for relayed settlement.

**What a pass proves:** the agent really moved USDC on-chain from its own key in
each evidence tx. **What it does not:** which seller was paid (the host never
leaves the agent) or the exact amount (the evidence is hashes only). It raises
the floor from "the agent says it paid N times" to "the agent provably paid N
times", not to a full audit.

**One-call and gate integration.** `verifyAttestation` takes an `onChain` option
that folds the re-check in, and the seller gate takes `policy.onChain`:

```ts
// One call: signature + on-chain in one result.
const res = await verifyAttestation(attestation, {
  onChain: { network: "base-sepolia", minVerified: 2 },
});
if (res.valid) res.onChain; // the tally

// Gate: the on-chain check runs LAST, after the cheap floors, so a request that
// fails minPayments never spends an RPC round-trip.
const gated = requireAttestation({
  minPayments: 5,
  bindToPayer: true,
  onChain: { network: "base-sepolia", requireAll: true },
}, handler);
```

`minVerified` sets how many evidence txs must clear; `requireAll` demands every
claimed one. Because the check costs an RPC per hash, gate before pricing and
cache per agent. The handler reads the tally with `attestationOf(req).onChain`.

## Verification checks, in order

1. summary matches the signed `digest` (contents not tampered);
2. `summary.agent` matches the attestation `agent`;
3. the claim is inside its `[issuedAt, expiresAt)` window;
4. the EIP-712 signature recovers to the claimed agent.

A `true` result means "this address controls the key and signed exactly these
numbers." By default it does not mean the numbers were checked on-chain. Add
`opts.onChain` (or `policy.onChain` on the gate) for step 5: re-check the txHash
evidence on-chain (needs `includeEvidence` on the attestation) and fail
verification, or attach `result.onChain`, per the "On-chain verification"
section.

## Honest limits of v1

- **Self-asserted.** A local ledger the agent writes about itself is only worth
  trusting because payments carry a `txHash` that settled on-chain. v1 does not
  re-check those; it trusts the Wallie brand. v2 (`includeEvidence` +
  `verifyAttestationOnChain`) closes this for payments — it proves them on-chain.
  It does nothing for `blocks` and `policyChanges`, which are self-reported and
  unfalsifiable by a third party; weigh those accordingly.
- **Cold start.** Behavior reputation needs history. A brand-new agent has no
  behavior and so no reputation, which is exactly when a seller most wants a
  signal. A stake bootstraps trust on day one; behavior sustains it. The two
  compose — v1 does not solve cold start.
- **Adoption.** Almost no x402 seller reads a reputation claim today. This issues
  a credential; a seller has to choose to gate on it.
