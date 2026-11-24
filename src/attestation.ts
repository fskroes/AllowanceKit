import type { LedgerEvent } from "./ledger.ts";
import { Ledger } from "./ledger.ts";
import { runtimeVersion } from "./version.ts";
import type { OnChainPolicy, OnChainVerifyResult } from "./attestation-chain.ts";
import type { IdentityPolicy, IdentityVerifyResult } from "./attestation-identity.ts";

export const ATTESTATION_DOMAIN = { name: "WallieAttestation", version: "1" } as const;

export const ATTESTATION_TYPES = {
  Attestation: [
    { name: "agent", type: "address" },
    { name: "issuer", type: "string" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
    { name: "digest", type: "bytes32" },
  ],
} as const;

export interface BehaviorSummary {
  agent: string;
  issuer: "wallie";
  runtimeVersion: string;
  periodStart: string | null;
  periodEnd: string | null;
  payments: number;
  spendTotalMicro: string;
  verifiableTxCount: number;
  verifiableTxHashes?: string[];
  registryAgentId?: string;
  blocks: number;
  distinctHosts: number;
  approvalsRequested: number;
  approvalsApproved: number;
  policyChanges: number;
}

export interface SignedAttestation {
  version: 1;
  agent: string;
  issuedAt: number;
  expiresAt: number;
  summary: BehaviorSummary;
  digest: `0x${string}`;
  signature: `0x${string}`;
}

export interface AttestationSigner {
  address: string;
  signTypedData(args: unknown): Promise<string>;
}

export interface AttestOptions {
  ttlSecs?: number;
  now?: number;
  includeEvidence?: boolean;
  registryAgentId?: string;
}

const DEFAULT_TTL_SECS = 30 * 24 * 60 * 60;

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
  if (opts.includeEvidence) summary.verifiableTxHashes = txHashes;
  if (opts.registryAgentId !== undefined && opts.registryAgentId !== "")
    summary.registryAgentId = opts.registryAgentId;
  return summary;
}

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
    const viem = "viem";
    return (await import(viem)) as unknown as ViemBits;
  } catch {
    throw new Error("attestations need viem for EIP-712 signing and verification: npm i viem");
  }
}

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
    const { enforceOnChain } = await import("./attestation-chain.ts");
    const chain = await enforceOnChain(att, opts.onChain);
    if (!chain.ok) return { valid: false, reason: chain.reason };
    onChain = chain.result;
  }

  let identity: IdentityVerifyResult | undefined;
  if (opts.identity) {
    const { enforceIdentity } = await import("./attestation-identity.ts");
    const id = await enforceIdentity(att, opts.identity);
    if (!id.ok) return { valid: false, reason: id.reason };
    identity = id.result;
  }

  return { valid: true, signer: att.agent, summary: att.summary, onChain, identity };
}
