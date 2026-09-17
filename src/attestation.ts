import type { LedgerEvent } from "./ledger.ts";
import { Ledger } from "./ledger.ts";
import { runtimeVersion } from "./version.ts";
import type { OnChainPolicy, OnChainVerifyResult } from "./attestation-chain.ts";
import type { IdentityPolicy, IdentityVerifyResult } from "./attestation-identity.ts";

/**
 * Behavior-derived attestation (PoC, v1 — brand-anchored self-attestation).
 *
 * An agent already keeps a private, append-only audit ledger (`src/ledger.ts`):
 * every payment (with its on-chain `txHash`), every block the rails stopped,
 * every human approval, every policy change, timestamped and per-agent. That is
 * the raw behavioral corpus a reputation signal is derived from.
 *
 * This module compresses that corpus into a small `BehaviorSummary`, then signs
 * it with the SAME wallet key the agent pays with (EIP-712, via viem — the
 * signer this repo already uses in `src/live.ts`). The result is a portable,
 * non-custodial claim: "this address behaved this way." A seller verifies the
 * signature recovers to the claimed address and, in v1, trusts the contents on
 * the Wallie brand — the way a seller trusts a signed receipt from a known
 * runtime, not a zero-knowledge proof.
 *
 * The trust model is deliberately staged, and this module is honest about which
 * stage it is at:
 *   - v1 (here): the signature proves the agent's key produced the claim. It
 *     does NOT prove the numbers against the chain. `verifiableTxCount` names
 *     how much of the claim is on-chain-checkable.
 *   - v2, payments (built, `src/attestation-chain.ts`): a verifier re-checks each
 *     `txHash` on-chain. The agent opts in to exposing the hashes
 *     (`includeEvidence`), the seller reads each receipt and confirms the agent
 *     moved USDC from its own key, and the payments claim stops depending on the
 *     Wallie brand.
 *   - v2, identity (built, `src/attestation-identity.ts`): the agent states its
 *     ERC-8004 `registryAgentId`, and the seller resolves it in the on-chain
 *     Identity Registry, confirming the attesting address is that agent's
 *     registered wallet or owner. The identity then resolves across sellers with
 *     no brand tag at all.
 *
 * `summarize` is dependency-free (pure ledger math). Only `attest` and
 * `verifyAttestation` touch viem, and they import it lazily, so importing this
 * module never pulls a signing library into an agent that only reads its own
 * ledger.
 */

/** The EIP-712 domain both sides sign and verify under. Off-chain: name+version only. */
export const ATTESTATION_DOMAIN = { name: "WallieAttestation", version: "1" } as const;

/** The EIP-712 struct that is actually signed. The bulk of the claim rides in `digest`. */
export const ATTESTATION_TYPES = {
  Attestation: [
    { name: "agent", type: "address" },
    { name: "issuer", type: "string" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
    { name: "digest", type: "bytes32" },
  ],
} as const;

/**
 * What an agent's ledger says about how it behaves. Counts and totals only — the
 * ledger itself (hosts, urls, per-payment amounts) never leaves the agent. This
 * is a reputation signal, not a data dump.
 */
export interface BehaviorSummary {
  /** The payer wallet address. In v1 this IS the agent's identity. */
  agent: string;
  /** Brand tag the seller keys its trust on ("wallie"). Provenance, not proof. */
  issuer: "wallie";
  /** The runtime that produced the claim. Provenance, not proof. */
  runtimeVersion: string;
  /** ISO timestamp of the agent's first ledger event, or null if the ledger is empty. */
  periodStart: string | null;
  /** ISO timestamp of the agent's last ledger event, or null. */
  periodEnd: string | null;
  /** Settled payment rows (an `amountMicro` was charged). */
  payments: number;
  /** Total actually spent across those payments, micro-dollars as a decimal string. */
  spendTotalMicro: string;
  /**
   * Payments that carry a non-empty `txHash` — the subset a verifier can
   * re-check on-chain. Always <= `payments`.
   */
  verifiableTxCount: number;
  /**
   * The actual txHashes behind `verifiableTxCount`, present only when the agent
   * opts in (`includeEvidence`). This is the evidence a seller re-checks on-chain
   * (v2, `src/attestation-chain.ts`). It is omitted by default because a txHash
   * is public: exposing it lets anyone resolve the counterparty on-chain, so an
   * agent trades that privacy for trustlessness only when it chooses to. When
   * present, `verifiableTxHashes.length === verifiableTxCount`.
   */
  verifiableTxHashes?: string[];
  /**
   * The agent's ERC-8004 Identity Registry id (the NFT tokenId), a decimal
   * string. Present only when the agent opts in (`registryAgentId` at attest
   * time). A seller resolves it on-chain (`src/attestation-identity.ts`) to
   * confirm the attesting address is this agent's registered wallet or owner, so
   * the identity resolves without the Wallie brand tag. Omitted by default, which
   * keeps the digest identical to a v1 claim.
   */
  registryAgentId?: string;
  /** Attempts the policy rails refused. Self-reported: no third party can confirm a block. */
  blocks: number;
  /** How many distinct hosts the agent paid or was blocked against — breadth of counterparties. */
  distinctHosts: number;
  /** Payments the agent escalated to a human. */
  approvalsRequested: number;
  /** Of those, how many a human approved. */
  approvalsApproved: number;
  /** How many times the agent's spend policy changed. */
  policyChanges: number;
}

/** A signed, portable behavior claim. Travels as JSON; the seller verifies it. */
export interface SignedAttestation {
  /** Attestation wire version. */
  version: 1;
  /** The claimed agent address; must equal the recovered signer and `summary.agent`. */
  agent: string;
  /** Unix seconds the claim was issued. */
  issuedAt: number;
  /** Unix seconds the claim stops being valid. */
  expiresAt: number;
  /** The behavior claim. */
  summary: BehaviorSummary;
  /** keccak256 of the canonical JSON of `summary`; binds the signature to the contents. */
  digest: `0x${string}`;
  /** EIP-712 signature over {agent, issuer, issuedAt, expiresAt, digest}. */
  signature: `0x${string}`;
}

/** Anything that can sign EIP-712 typed data — `privateKeyToAccount(...)` from viem fits. */
export interface AttestationSigner {
  address: string;
  signTypedData(args: unknown): Promise<string>;
}

export interface AttestOptions {
  /** How long the claim stays valid, in seconds. Default 30 days. */
  ttlSecs?: number;
  /** Override "now" (unix seconds), for tests. */
  now?: number;
  /**
   * Include the txHash evidence (`summary.verifiableTxHashes`) so a seller can
   * re-check the payments on-chain (v2). Opt-in: it exposes public txHashes and
   * thus the counterparties. Ignored by `attest` (which takes a ready summary);
   * used by `summarize` and `attestFromLedger`.
   */
  includeEvidence?: boolean;
  /**
   * Stamp the agent's ERC-8004 Identity Registry id into the summary
   * (`summary.registryAgentId`) so a seller can resolve the identity on-chain
   * (v2, `src/attestation-identity.ts`). A decimal tokenId string. The agentId
   * is not in the ledger; it comes from the agent's registration, so it is
   * supplied here. Ignored by `attest`; used by `summarize` and `attestFromLedger`.
   */
  registryAgentId?: string;
}

const DEFAULT_TTL_SECS = 30 * 24 * 60 * 60;

/**
 * Derive a behavior summary from an agent's ledger. Pure: no network, no viem,
 * no signing. One pass over the agent's own rows.
 *
 * `agent` is the wallet address that becomes the claim's identity (`summary.agent`)
 * and, by default, the key the ledger rows are filtered by. The live runtime
 * keys its ledger rows by an `agentName` string, not the address, so pass
 * `opts.ledgerKey` to read rows under that name while still stamping the wallet
 * address as the identity. When they are the same (the standalone demo/tests),
 * `ledgerKey` is unnecessary.
 */
export function summarize(
  ledger: Ledger,
  agent: string,
  opts: { ledgerKey?: string; includeEvidence?: boolean; registryAgentId?: string } = {},
): BehaviorSummary {
  const ledgerKey = opts.ledgerKey ?? agent;
  let periodStart: string | null = null;
  let periodEnd: string | null = null;
  let payments = 0;
  let spendTotalMicro = 0n;
  let verifiableTxCount = 0;
  let blocks = 0;
  let approvalsRequested = 0;
  let approvalsApproved = 0;
  let policyChanges = 0;
  const hosts = new Set<string>();
  const txHashes: string[] = [];

  for (const e of ledger.read() as LedgerEvent[]) {
    if (e.agent !== ledgerKey) continue;
    if (periodStart === null || e.at < periodStart) periodStart = e.at;
    if (periodEnd === null || e.at > periodEnd) periodEnd = e.at;
    switch (e.t) {
      case "payment":
        payments++;
        spendTotalMicro += BigInt(e.amountMicro);
        if (e.txHash) {
          verifiableTxCount++;
          txHashes.push(e.txHash);
        }
        hosts.add(e.host);
        break;
      case "blocked":
        blocks++;
        hosts.add(e.host);
        break;
      case "approval_requested":
        approvalsRequested++;
        break;
      case "approval_decided":
        if (e.approved) approvalsApproved++;
        break;
      case "policy_change":
        policyChanges++;
        break;
    }
  }

  const summary: BehaviorSummary = {
    agent,
    issuer: "wallie",
    runtimeVersion: runtimeVersion(),
    periodStart,
    periodEnd,
    payments,
    spendTotalMicro: spendTotalMicro.toString(),
    verifiableTxCount,
    blocks,
    distinctHosts: hosts.size,
    approvalsRequested,
    approvalsApproved,
    policyChanges,
  };
  // Only attach the evidence when asked, so the default wire stays counts-only
  // and its digest is unchanged from v1.
  if (opts.includeEvidence) summary.verifiableTxHashes = txHashes;
  // Same for the registry id: attached only when the agent opts in, so a claim
  // without it keeps the v1 digest.
  if (opts.registryAgentId !== undefined && opts.registryAgentId !== "")
    summary.registryAgentId = opts.registryAgentId;
  return summary;
}

/**
 * Deterministic JSON: object keys sorted at every depth, so the digest is stable
 * regardless of field insertion order. Both signer and verifier hash this exact
 * string, so it must never depend on runtime key order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

async function digestOf(summary: BehaviorSummary): Promise<`0x${string}`> {
  const { keccak256, stringToHex } = await loadViem();
  return keccak256(stringToHex(canonicalJson(summary)));
}

interface ViemBits {
  keccak256: (hex: `0x${string}`) => `0x${string}`;
  stringToHex: (s: string) => `0x${string}`;
  verifyTypedData: (args: unknown) => Promise<boolean>;
}

async function loadViem(): Promise<ViemBits> {
  try {
    // Optional peer dependency, resolved at runtime — the core stays zero-dep,
    // exactly as src/live.ts does for signing.
    const viem = "viem";
    return (await import(viem)) as unknown as ViemBits;
  } catch {
    throw new Error("attestations need viem for EIP-712 signing and verification: npm i viem");
  }
}

/**
 * Sign a behavior summary with the agent's wallet key. The signer is the same
 * `account` object `createLiveAgent` builds from the payer key, so the address
 * that pays is the address that attests — one non-custodial identity.
 */
export async function attest(
  signer: AttestationSigner,
  summary: BehaviorSummary,
  opts: AttestOptions = {},
): Promise<SignedAttestation> {
  if (summary.agent.toLowerCase() !== signer.address.toLowerCase())
    throw new Error(
      `summary is for ${summary.agent} but the signer is ${signer.address} — an agent can only attest to its own behavior`,
    );

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const issuedAt = now;
  const expiresAt = now + (opts.ttlSecs ?? DEFAULT_TTL_SECS);
  const digest = await digestOf(summary);

  const signature = (await signer.signTypedData({
    domain: ATTESTATION_DOMAIN,
    types: ATTESTATION_TYPES,
    primaryType: "Attestation",
    message: {
      agent: summary.agent as `0x${string}`,
      issuer: summary.issuer,
      issuedAt: BigInt(issuedAt),
      expiresAt: BigInt(expiresAt),
      digest,
    },
  })) as `0x${string}`;

  return { version: 1, agent: summary.agent, issuedAt, expiresAt, summary, digest, signature };
}

/**
 * Issue an attestation straight from a ledger: `summarize` then `attest`.
 * `opts.ledgerKey` lets the ledger filter key differ from the wallet address
 * that signs and becomes the identity (see {@link summarize}).
 */
export async function attestFromLedger(
  signer: AttestationSigner,
  ledger: Ledger,
  agent: string,
  opts: AttestOptions & { ledgerKey?: string } = {},
): Promise<SignedAttestation> {
  return attest(
    signer,
    summarize(ledger, agent, {
      ledgerKey: opts.ledgerKey,
      includeEvidence: opts.includeEvidence,
      registryAgentId: opts.registryAgentId,
    }),
    opts,
  );
}

export type VerifyAttestationResult =
  | { valid: true; signer: string; summary: BehaviorSummary; onChain?: OnChainVerifyResult; identity?: IdentityVerifyResult }
  | { valid: false; reason: string };

/**
 * Seller-side check. Confirms, in order:
 *   1. the summary matches the signed digest (contents not tampered),
 *   2. the claimed agent matches the summary's own agent field,
 *   3. the claim is within its validity window,
 *   4. the EIP-712 signature recovers to the claimed agent.
 *
 * A `true` result means "this address controls the key and signed exactly these
 * numbers." By default it does NOT check the numbers against the chain — the
 * seller trusts the contents on the Wallie brand once the signature is proven.
 *
 * Pass `opts.onChain` to add step 5: re-check the txHash evidence on-chain
 * (v2, `src/attestation-chain.ts`). It requires the agent to have attested with
 * `includeEvidence`, adds RPC latency, and folds the on-chain tally into the
 * result (`result.onChain`) or fails verification when the evidence does not
 * clear the policy.
 *
 * Pass `opts.identity` to add step 6: resolve the agent's `registryAgentId` in
 * the ERC-8004 Identity Registry (v2, `src/attestation-identity.ts`) and confirm
 * the attesting address is that agent's registered wallet or owner. It requires
 * the agent to have attested with `registryAgentId` and folds the resolution into
 * `result.identity` (or fails verification when the agent does not resolve).
 */
export async function verifyAttestation(
  att: SignedAttestation,
  opts: { now?: number; onChain?: OnChainPolicy; identity?: IdentityPolicy } = {},
): Promise<VerifyAttestationResult> {
  if (att.version !== 1) return { valid: false, reason: `unknown attestation version ${att.version}` };

  const expected = await digestOf(att.summary);
  if (expected !== att.digest) return { valid: false, reason: "summary does not match the signed digest — tampered" };

  if (att.summary.agent.toLowerCase() !== att.agent.toLowerCase())
    return { valid: false, reason: "summary.agent does not match the attestation agent" };

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (now >= att.expiresAt) return { valid: false, reason: "attestation has expired" };
  if (now + 300 < att.issuedAt) return { valid: false, reason: "attestation is not valid yet (issuedAt is in the future)" };

  const { verifyTypedData } = await loadViem();
  let ok: boolean;
  try {
    ok = await verifyTypedData({
      address: att.agent as `0x${string}`,
      domain: ATTESTATION_DOMAIN,
      types: ATTESTATION_TYPES,
      primaryType: "Attestation",
      message: {
        agent: att.agent as `0x${string}`,
        issuer: att.summary.issuer,
        issuedAt: BigInt(att.issuedAt),
        expiresAt: BigInt(att.expiresAt),
        digest: att.digest,
      },
      signature: att.signature,
    });
  } catch (e) {
    return { valid: false, reason: `signature check failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!ok) return { valid: false, reason: "signature does not recover to the claimed agent" };

  let onChain: OnChainVerifyResult | undefined;
  if (opts.onChain) {
    // Lazy so a seller that never asks for on-chain verification never imports
    // an RPC client (same optional-peer pattern as the signing path).
    const { enforceOnChain } = await import("./attestation-chain.ts");
    const chain = await enforceOnChain(att, opts.onChain);
    if (!chain.ok) return { valid: false, reason: chain.reason };
    onChain = chain.result;
  }

  let identity: IdentityVerifyResult | undefined;
  if (opts.identity) {
    // Lazy for the same reason: registry resolution pulls viem in only on demand.
    const { enforceIdentity } = await import("./attestation-identity.ts");
    const id = await enforceIdentity(att, opts.identity);
    if (!id.ok) return { valid: false, reason: id.reason };
    identity = id.result;
  }

  return { valid: true, signer: att.agent, summary: att.summary, onChain, identity };
}
